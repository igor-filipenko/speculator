import type { AppConfig, TelegramConfig } from "../config.js";
import { strategyParams } from "../config.js";
import { JupiterClient } from "../jupiter/client.js";
import { fetchCandles } from "../market/gecko-terminal.js";
import {
  appendSignalJsonl,
  logPaperSnapshot,
  logPaperTrade,
  logSignal,
} from "../notify/console.js";
import {
  formatPaperTradeMessage,
  formatSignalMessage,
  sendTelegramMessage,
} from "../notify/telegram.js";
import { PaperPortfolio, type PaperTrade } from "../paper/portfolio.js";
import { evaluateEmaRsi } from "../strategy/ema-rsi.js";
import type { PairConfig, Signal } from "../types.js";

export interface WatchOptions {
  config: AppConfig;
  /** When true, run a single iteration then exit (useful for smoke tests). */
  once?: boolean;
}

/**
 * Main poll loop: candles → indicators → signal → optional paper fill.
 */
export async function runWatch(options: WatchOptions): Promise<void> {
  const { config, once = false } = options;
  const params = strategyParams(config.strategy);
  const jupiter = new JupiterClient({ apiKey: config.jupiterApiKey });

  if (!config.jupiterApiKey) {
    console.warn(
      "Warning: JUPITER_API_KEY is empty; quotes may fail or be rate-limited.",
    );
  }

  const portfolios = new Map<string, PaperPortfolio>();
  if (config.mode === "paper") {
    for (const pair of config.pairs) {
      portfolios.set(
        pair.symbol,
        new PaperPortfolio(pair.symbol, config.paperCashUsdc),
      );
    }
  }

  const startMsg = `Starting ${config.mode} mode | strategy=${config.strategy} (${params.timeframe}) | pairs=${config.watchlist.join(",")} | poll=${config.pollIntervalMs}ms`;
  console.log(startMsg);

  const ok = once ? true : await notifyTelegram(config.telegram, startMsg);
  if (!ok) {
    console.error("Failed to send start message to Telegram");
    process.exit(1);
  }
  const shutdown = once ? async () => {} : installLifecycleNotifiers(config.telegram);

  const tick = async (): Promise<void> => {
    for (const pair of config.pairs) {
      try {
        await processPair({ config, pair, params, jupiter, portfolios });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${pair.symbol}] tick failed: ${message}`);
      }
    }
  };

  try {
    await tick();
    if (once) {
      await shutdown("once complete", 0);
      return;
    }

    for (;;) {
      await sleep(config.pollIntervalMs);
      await tick();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await shutdown(`crash: ${message}`, 1);
  }
}

async function processPair(args: {
  config: AppConfig;
  pair: PairConfig;
  params: ReturnType<typeof strategyParams>;
  jupiter: JupiterClient;
  portfolios: Map<string, PaperPortfolio>;
}): Promise<void> {
  const { config, pair, params, jupiter, portfolios } = args;

  const candles = await fetchCandles({
    poolAddress: pair.geckoPoolAddress,
    timeframe: params.timeframe,
    limit: Math.max(params.emaSlow + params.rsiPeriod + 5, 50),
  });

  const price = await jupiter.spotPrice({
    baseMint: pair.baseMint,
    quoteMint: pair.quoteMint,
    baseDecimals: pair.baseDecimals,
    quoteDecimals: pair.quoteDecimals,
  });

  const signal = evaluateEmaRsi({
    pair: pair.symbol,
    candles,
    params,
    price,
  });

  logSignal(signal);
  await appendSignalJsonl(signal);
  await notifyTelegramSignal(config.telegram, signal);

  if (config.mode !== "paper") {
    return;
  }

  const portfolio = portfolios.get(pair.symbol);
  if (!portfolio) {
    return;
  }

  const trade = portfolio.applySignal(signal);
  if (trade) {
    logPaperTrade(trade);
    await notifyTelegramPaperTrade(config.telegram, trade);
  }
  logPaperSnapshot(portfolio.getSnapshot(price));
}

/**
 * Notify Telegram on SIGINT/SIGTERM and uncaught crashes, then exit.
 * Returns a callable used for orderly stops (e.g. --once) and fatal errors inside runWatch.
 */
function installLifecycleNotifiers(
  telegram: TelegramConfig | undefined,
): (reason: string, exitCode: number) => Promise<void> {
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const text = `Stopped (${reason})`;
    console.log(text);
    await notifyTelegram(telegram, text);

    // Allow a clean exit after --once without forcing process.exit (lets main resolve).
    if (reason === "once complete") {
      return;
    }
    process.exit(exitCode);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT", 130);
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });
  process.once("uncaughtException", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    void shutdown(`crash: ${message}`, 1);
  });
  process.once("unhandledRejection", (reason) => {
    const message =
      reason instanceof Error ? reason.message : String(reason);
    void shutdown(`crash: ${message}`, 1);
  });

  return shutdown;
}

async function notifyTelegram(
  telegram: TelegramConfig | undefined,
  text: string,
): Promise<boolean> {
  if (!telegram) {
    return true;
  }
  try {
    await sendTelegramMessage(telegram, text);
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Telegram notify failed: ${errMsg}`);
    return false;
  }
}

async function notifyTelegramSignal(
  telegram: TelegramConfig | undefined,
  signal: Signal,
): Promise<void> {
  if (!telegram || signal.side === "HOLD") {
    return;
  }
  try {
    await sendTelegramMessage(telegram, formatSignalMessage(signal));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Telegram signal notify failed: ${message}`);
  }
}

async function notifyTelegramPaperTrade(
  telegram: TelegramConfig | undefined,
  trade: PaperTrade,
): Promise<void> {
  if (!telegram) {
    return;
  }
  try {
    await sendTelegramMessage(telegram, formatPaperTradeMessage(trade));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Telegram paper notify failed: ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
