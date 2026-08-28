import type { AppConfig } from "../config.js";
import { JupiterExchange } from "../exchange/jupiter.js";
import { fetchCandles } from "../market/gecko-terminal.js";
import { refreshMarketIndicators } from "../market/htf-cache.js";
import { logMarket, logSignal, persistSignal } from "../notify/console.js";
import { Telegram } from "../notify/telegram.js";
import type {
  Candle,
  Exchange,
  MarketIndicators,
  PairConfig,
  ProgramState,
  ShutdownCb,
  Signal,
  Strategy,
  StrategyManager,
} from "../types.js";
import { sleep } from "./tick.js";

export interface WatchOptions {
  config: AppConfig;
  strategy: Strategy;
  strategyManager: StrategyManager;
  state: ProgramState;
  telegram: Telegram;
  /** When true, run a single iteration then exit (useful for smoke tests). */
  once?: boolean;
  shutdownCb: ShutdownCb;
}

/**
 * Main poll loop: candles → signal → risk command → exchange order → optional paper fill.
 */
export async function runWatch(options: WatchOptions): Promise<void> {
  const { config, strategy, strategyManager, once = false } = options;
  const exchange = new JupiterExchange({ apiKey: config.jupiterApiKey });

  const lastSignals = options.state.lastSignals;
  const lastCandles = options.state.lastCandles;
  const lastMarketIndicators = options.state.lastMarketIndicators;
  const telegram = options.telegram;
  const shutdown = options.shutdownCb;
  const startMsg = `Starting watch mode | strategy=${strategy.getDisplayName()} | htf=${config.htf} | pairs=${config.watchlist.join(",")} | poll=${config.pollIntervalMs}ms`;
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
          pair,
          strategyManager,
          exchange,
          lastSignals,
          lastCandles,
          lastMarketIndicators,
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
  pair: PairConfig;
  strategyManager: StrategyManager;
  exchange: Exchange;
  lastSignals: Map<string, Signal>;
  lastCandles: Map<string, Candle[]>;
  lastMarketIndicators: Map<string, MarketIndicators>;
  telegram: Telegram;
}): Promise<void> {
  const {
    pair,
    strategyManager,
    exchange,
    lastSignals,
    lastCandles,
    lastMarketIndicators,
    telegram,
  } = args;

  const price = await exchange.spotPrice(pair);

  try {
    const previous = lastMarketIndicators.get(pair.symbol);
    const market = await refreshMarketIndicators({
      pair,
      required: strategyManager.getRequiredCandles(),
      price,
      at: new Date(),
    });
    logMarket(market);
    const trendChanged =
      previous !== undefined
        ? strategyManager.applyMarketIndicators(market, previous)
        : strategyManager.applyMarketIndicators(market);
    lastMarketIndicators.set(pair.symbol, market);
    if (trendChanged) {
      console.log(`[${pair.symbol}] trend changed from ${previous?.trend} to ${market.trend}`);
      await telegram.notify({
        type: "market",
        market,
        ...(previous !== undefined ? { previous: previous.trend } : {}),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${pair.symbol}] market indicators failed: ${message}`);
  }

  const strategy = strategyManager.getActiveStrategy();
  const required = strategy.getRequiredCandles();
  const candles = await fetchCandles({
    poolAddress: pair.geckoPoolAddress,
    timeframe: required.timeframe,
    limit: required.count,
  });

  const signal = strategy.evaluateSignal(
    pair.symbol,
    candles,
    price,
    new Date(candles[candles.length - 1]!.time * 1000),
  );

  lastCandles.set(pair.symbol, candles);
  lastSignals.set(pair.symbol, signal);
  logSignal(signal);
  await persistSignal(signal);
  await telegram.notify({ type: "signal", signal });
}
