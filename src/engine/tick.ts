import type { AppConfig } from "../config.js";
import { readCandles } from "../db/candles.js";
import {
  loadFreshMarketState,
  toMarketState,
  toPersistedMarket,
  upsertMarket,
  type PersistedMarket,
} from "../db/market.js";
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
  HtfTimeframe,
  MarketState,
  PairConfig,
  PoolStats,
  Portfolio,
  ProgramState,
  ShutdownCb,
  Signal,
  StrategyManager,
  StrategyMode,
  Timeframe,
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
    const previous = lastMarketStates.get(pair.symbol);
    const market = await refreshMarketState({
      pair,
      strategyManager,
      price,
      at: new Date(),
    });
    logMarket(market);
    const trendChanged =
      previous !== undefined
        ? strategyManager.applyMarketState(market, previous)
        : strategyManager.applyMarketState(market);
    lastMarketStates.set(pair.symbol, market);
    if (trendChanged) {
      await telegram.notify({
        type: "market",
        market,
        ...(previous !== undefined ? { previous: previous.trend } : {}),
      });
    }
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
 * Load HTF {@link MarketState}: reuse `market.states` while the cached bar is open,
 * otherwise Gecko OHLCV + pool stats, then persist. Pool stats failures are logged;
 * candle failures propagate to the caller.
 */
export async function refreshMarketState(args: {
  pair: PairConfig;
  strategyManager: StrategyManager;
  price: number;
  at: Date;
}): Promise<MarketState> {
  const required = args.strategyManager.getRequiredCandles();
  const timeframe = asHtfTimeframe(required.timeframe);
  const nowSec = Math.floor(args.at.getTime() / 1000);
  const strategyMode = args.strategyManager.getActiveStrategy().getMode();

  const persisted = await loadFreshMarketState({
    pair: args.pair.symbol,
    timeframe,
    nowSec,
  });
  if (persisted !== null) {
    const cached = await hydrateMarketState(persisted, required.count, args.price, strategyMode);
    if (cached !== null) {
      return cached;
    }
  }

  const interval = candleIntervalSeconds(timeframe);
  const fromTime = nowSec - required.count * interval;

  const candles = await loadCachedCandles({
    symbol: args.pair.symbol,
    poolAddress: args.pair.geckoPoolAddress,
    timeframe,
    fromTime,
    toTime: nowSec,
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

  const state = args.strategyManager.evaluate(args.pair.symbol, candles, args.price, at, poolStats);
  await upsertMarket(toPersistedMarket(state));
  return state;
}

async function hydrateMarketState(
  persisted: PersistedMarket,
  requiredCount: number,
  livePrice: number,
  strategyMode: StrategyMode,
): Promise<MarketState | null> {
  const interval = candleIntervalSeconds(persisted.timeframe);
  const fromTime = persisted.barTime - (requiredCount - 1) * interval;
  const candles = await readCandles(
    persisted.pair,
    persisted.timeframe,
    fromTime,
    persisted.barTime + 1,
  );
  if (candles[candles.length - 1]?.time !== persisted.barTime) {
    return null;
  }
  return toMarketState(persisted, candles, livePrice, strategyMode);
}

function asHtfTimeframe(timeframe: Timeframe): HtfTimeframe {
  if (timeframe === "4h" || timeframe === "1d") {
    return timeframe;
  }
  throw new Error(`HTF timeframe must be 4h or 1d, got ${timeframe}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
