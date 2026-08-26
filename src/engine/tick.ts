import type { AppConfig } from "../config.js";
import { candleIntervalSeconds, fetchCandles, fetchPoolStats } from "../market/gecko-terminal.js";
import { loadCachedCandles } from "../market/ohlcv-cache.js";
import {
  logMarket,
  logRisk,
  logSignal,
  logSnapshot,
  logTrade,
  persistSignal,
} from "../notify/console.js";
import { Telegram } from "../notify/telegram.js";
import type {
  Candle,
  Exchange,
  MarketState,
  PairConfig,
  PoolStats,
  Portfolio,
  ProgramState,
  ShutdownCb,
  Signal,
  StrategyManager,
} from "../types.js";

export interface TradingLoopOptions {
  config: AppConfig;
  strategyManager: StrategyManager;
  exchange: Exchange;
  state: ProgramState;
  telegram: Telegram;
  once?: boolean;
  shutdownCb: ShutdownCb;
  modeLabel: string;
}

/**
 * Shared poll loop: candles → signal → risk command → exchange order → portfolio fill.
 */
export async function runTradingLoop(options: TradingLoopOptions): Promise<void> {
  const { config, strategyManager, exchange, once = false, modeLabel } = options;
  const strategy = strategyManager.getActiveStrategy();
  const portfolios = options.state.portfolios;
  const lastSignals = options.state.lastSignals;
  const lastCandles = options.state.lastCandles;
  const lastMarketStates = options.state.lastMarketStates;
  const telegram = options.telegram;
  const shutdown = options.shutdownCb;
  const startMsg = `Starting ${modeLabel} mode | strategy=${strategy.getDisplayName()} | htf=${config.htf} | pairs=${config.watchlist.join(",")} | poll=${config.pollIntervalMs}ms`;
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
          portfolios,
          lastSignals,
          lastCandles,
          lastMarketStates,
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

export async function processPair(args: {
  pair: PairConfig;
  strategyManager: StrategyManager;
  exchange: Exchange;
  portfolios: Map<string, Portfolio>;
  lastSignals: Map<string, Signal>;
  lastCandles: Map<string, Candle[]>;
  lastMarketStates: Map<string, MarketState>;
  telegram: Telegram;
}): Promise<void> {
  const {
    pair,
    strategyManager,
    exchange,
    portfolios,
    lastSignals,
    lastCandles,
    lastMarketStates,
    telegram,
  } = args;

  const price = await exchange.spotPrice(pair);

  try {
    const market = await refreshMarketState({
      pair,
      strategyManager,
      price,
      at: new Date(),
    });
    logMarket(market);
    lastMarketStates.set(pair.symbol, market);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${pair.symbol}] market state failed: ${message}`);
  }

  const strategy = strategyManager.getActiveStrategy();
  const riskManager = strategyManager.getActiveRiskManager();

  const requiredCandles = strategy.getRequiredCandles();
  const candles = await fetchCandles({
    poolAddress: pair.geckoPoolAddress,
    timeframe: requiredCandles.timeframe,
    limit: requiredCandles.count,
  });

  const portfolio = portfolios.get(pair.symbol);
  if (portfolio) {
    await portfolio.syncFromChain(price);
  }

  const signal = strategy.evaluateSignal(
    pair.symbol,
    candles,
    price,
    new Date(candles[candles.length - 1]!.time * 1000),
    portfolio?.getSnapshot(price),
  );

  lastCandles.set(pair.symbol, candles);
  lastSignals.set(pair.symbol, signal);
  logSignal(signal);
  await persistSignal(signal);
  await telegram.notify({ type: "signal", signal });

  if (!portfolio) {
    console.error(`[${pair.symbol}] portfolio not found`);
    return;
  }

  const result = riskManager.check(signal, portfolio.getSnapshot(price), candles);
  if (result.kind === "risk") {
    logRisk(result.risk);
    await telegram.notify({ type: "risk", risk: result.risk });
    logSnapshot(portfolio.getSnapshot(price));
    return;
  }
  if (result.kind === "no-command") {
    logSnapshot(portfolio.getSnapshot(price));
    return;
  }
  const command = result.command;

  const order = await exchange.execute(command, pair);
  if (!order) {
    console.error(`[${pair.symbol}] no order, exchange returned null`);
    return;
  }

  const trade = await portfolio.applyOrder(order);
  if (!trade) {
    logSnapshot(portfolio.getSnapshot(price));
    console.error(`[${pair.symbol}] no trade, portfolio returned null`);
    return;
  }

  logTrade(trade);
  await telegram.notify({ type: "trade", trade });
}

/**
 * Load HTF candles (DuckDB cache + Gecko backfill) and evaluate {@link MarketState}.
 * Pool stats failures are logged; candle failures propagate to the caller.
 */
export async function refreshMarketState(args: {
  pair: PairConfig;
  strategyManager: StrategyManager;
  price: number;
  at: Date;
}): Promise<MarketState> {
  const required = args.strategyManager.getRequiredCandles();
  const interval = candleIntervalSeconds(required.timeframe);
  const toTime = Math.floor(Date.now() / 1000);
  const fromTime = toTime - required.count * interval;

  const candles = await loadCachedCandles({
    symbol: args.pair.symbol,
    poolAddress: args.pair.geckoPoolAddress,
    timeframe: required.timeframe,
    fromTime,
    toTime,
  });

  let poolStats: PoolStats | undefined;
  try {
    poolStats = await fetchPoolStats(args.pair.geckoPoolAddress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${args.pair.symbol}] pool stats failed: ${message}`);
  }

  const last = candles[candles.length - 1];
  const at = last !== undefined ? new Date(last.time * 1000) : args.at;

  return args.strategyManager.evaluate(args.pair.symbol, candles, args.price, at, poolStats);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
