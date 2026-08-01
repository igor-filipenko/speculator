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
  notifyTelegram,
  startTelegramCommands,
  type TelegramCommandState,
} from "../notify/telegram.js";
import { PaperPortfolio } from "../paper/portfolio.js";
import { loadPaperState, savePaperState } from "../paper/store.js";
import { evaluateEmaRsi } from "../strategy/ema-rsi.js";
import type { Candle, PairConfig, Signal } from "../types.js";

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
    const saved = await loadPaperState();
    for (const pair of config.pairs) {
      const persisted = saved?.portfolios[pair.symbol];
      if (persisted) {
        const portfolio = PaperPortfolio.fromPersisted(persisted);
        portfolios.set(pair.symbol, portfolio);
        const snap = portfolio.toPersisted();
        const pos =
          snap.position.side === "long"
            ? `long ${snap.position.size.toFixed(6)} @ ${snap.position.entryPrice.toFixed(6)}`
            : "flat";
        console.log(
          `Restored paper ${pair.symbol}: cash=${snap.cashUsdc.toFixed(4)} USDC | position=${pos} | realizedPnl=${snap.realizedPnl.toFixed(4)} | trades=${snap.trades.length}`,
        );
      } else {
        portfolios.set(
          pair.symbol,
          new PaperPortfolio(pair.symbol, config.paperCashUsdc),
        );
      }
    }
  }

  const lastSignals = new Map<string, Signal>();
  const lastCandles = new Map<string, Candle[]>();
  const telegramState: TelegramCommandState = {
    mode: config.mode,
    params,
    lastSignals,
    lastCandles,
    portfolios,
  };

  const startMsg = `Starting ${config.mode} mode | strategy=${config.strategy} (${params.timeframe}) | pairs=${config.watchlist.join(",")} | poll=${config.pollIntervalMs}ms`;
  console.log(startMsg);

  const ok = once ? true : await notifyTelegram(config.telegram, { type: "start" });
  if (!ok) {
    console.error("Failed to send start message to Telegram");
    process.exit(1);
  }

  let stopTelegramCommands: (() => Promise<void>) | undefined;
  if (config.telegram && !once) {
    stopTelegramCommands = startTelegramCommands(config.telegram, telegramState);
  }

  const shutdown = once
    ? async (): Promise<void> => {
        /* no-op for --once */
      }
    : installLifecycleNotifiers(config.telegram, stopTelegramCommands);

  const tick = async (): Promise<void> => {
    for (const pair of config.pairs) {
      try {
        await processPair({
          config,
          pair,
          params,
          jupiter,
          portfolios,
          lastSignals,
          lastCandles,
        });
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
  lastSignals: Map<string, Signal>;
  lastCandles: Map<string, Candle[]>;
}): Promise<void> {
  const {
    config,
    pair,
    params,
    jupiter,
    portfolios,
    lastSignals,
    lastCandles,
  } = args;

  const candles = await fetchCandles({
    poolAddress: pair.geckoPoolAddress,
    timeframe: params.timeframe,
    limit: Math.max(params.emaSlow + params.rsiPeriod + 5, 120),
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

  lastCandles.set(pair.symbol, candles);
  lastSignals.set(pair.symbol, signal);
  logSignal(signal);
  await appendSignalJsonl(signal);
  await notifyTelegram(config.telegram, { type: "signal", signal });

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
    await notifyTelegram(config.telegram, { type: "paperTrade", trade });
    await savePaperState(portfolios);
  }
  logPaperSnapshot(portfolio.getSnapshot(price));
}

/**
 * Notify Telegram on SIGINT/SIGTERM and uncaught crashes, then exit.
 * Returns a callable used for orderly stops (e.g. --once) and fatal errors inside runWatch.
 */
function installLifecycleNotifiers(
  telegram: TelegramConfig | undefined,
  stopTelegramCommands?: () => Promise<void>,
): (reason: string, exitCode: number) => Promise<void> {
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (stopTelegramCommands) {
      try {
        await stopTelegramCommands();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Telegram command polling stop failed: ${message}`);
      }
    }

    console.log(`Stopped (${reason})`);
    await notifyTelegram(telegram, {
      type: "shutdown",
      code: exitCode,
      reason,
    });

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
