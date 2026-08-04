import type { AppConfig } from "../config.js";
import { strategyParams } from "../config.js";
import { JupiterClient } from "../jupiter/client.js";
import { fetchCandles } from "../market/gecko-terminal.js";
import { appendSignalJsonl, logSignal, logSnapshot, logTrade } from "../notify/console.js";
import { Telegram } from "../notify/telegram.js";
import { evaluateEmaRsi } from "../strategy/ema-rsi.js";
import type {
  Candle,
  PairConfig,
  Portfolio,
  ProgramState,
  ShutdownCb,
  Signal,
  StrategyParams,
} from "../types.js";

export interface WatchOptions {
  config: AppConfig;
  state: ProgramState;
  telegram: Telegram;
  /** When true, run a single iteration then exit (useful for smoke tests). */
  once?: boolean;
  shutdownCb: ShutdownCb;
}

/**
 * Main poll loop: candles → indicators → signal → optional paper fill.
 */
export async function runWatch(options: WatchOptions): Promise<void> {
  const { config, once = false } = options;
  const strategy = strategyParams(config.strategy);
  const jupiter = new JupiterClient({ apiKey: config.jupiterApiKey });

  if (!config.jupiterApiKey) {
    console.warn("Warning: JUPITER_API_KEY is empty; quotes may fail or be rate-limited.");
  }

  const portfolios = options.state.portfolios;
  const lastSignals = options.state.lastSignals;
  const lastCandles = options.state.lastCandles;
  const telegram = options.telegram;
  const shutdown = options.shutdownCb;
  const startMsg = `Starting ${config.mode} mode | strategy=${strategy.mode} (${strategy.timeframe}) | pairs=${config.watchlist.join(",")} | poll=${config.pollIntervalMs}ms`;
  console.log(startMsg);

  const ok = await telegram.notify({ type: "start" });
  if (!ok) {
    console.error("Failed to send start message to Telegram");
    process.exit(1);
  }

  const tick = async (): Promise<void> => {
    for (const pair of config.pairs) {
      try {
        await processPair({
          config,
          pair,
          strategy,
          jupiter,
          portfolios,
          lastSignals,
          lastCandles,
          telegram,
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
  strategy: StrategyParams;
  jupiter: JupiterClient;
  portfolios: Map<string, Portfolio>;
  lastSignals: Map<string, Signal>;
  lastCandles: Map<string, Candle[]>;
  telegram: Telegram;
}): Promise<void> {
  const { config, pair, strategy, jupiter, portfolios, lastSignals, lastCandles, telegram } = args;

  const candles = await fetchCandles({
    poolAddress: pair.geckoPoolAddress,
    timeframe: strategy.timeframe,
    limit: Math.max(strategy.emaSlow + strategy.rsiPeriod + 5, 120),
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
    strategy,
    price,
  });

  lastCandles.set(pair.symbol, candles);
  lastSignals.set(pair.symbol, signal);
  logSignal(signal);
  await appendSignalJsonl(signal);
  await telegram.notify({ type: "signal", signal });

  if (config.mode !== "paper") {
    return;
  }

  const portfolio = portfolios.get(pair.symbol);
  if (!portfolio) {
    return;
  }

  const trade = await portfolio.applySignal(signal);
  if (trade) {
    logTrade(trade);
    await telegram.notify({ type: "trade", trade });
  }
  logSnapshot(portfolio.getSnapshot(price));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
