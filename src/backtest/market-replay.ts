import { candleIntervalSeconds } from "../market/gecko-terminal.js";
import { loadCachedCandles } from "../market/ohlcv-cache.js";
import type { Candle, MarketIndicators, PairConfig, StrategyManager } from "../types.js";

export interface LoadReplayCandlesArgs {
  pair: PairConfig;
  strategyManager: StrategyManager;
  fromTime: number;
  toTime: number;
  injected: Candle[] | undefined;
  skipFetch: boolean;
  cacheOpts: { forceRefresh: boolean };
}

export async function loadHtfCandles(args: LoadReplayCandlesArgs): Promise<Candle[]> {
  if (args.injected !== undefined) {
    return args.injected;
  }
  if (args.skipFetch) {
    return [];
  }

  const required = args.strategyManager.getRequiredHtfCandles();
  const interval = candleIntervalSeconds(required.timeframe);
  const candles = await loadCachedCandles({
    symbol: args.pair.symbol,
    poolAddress: args.pair.geckoPoolAddress,
    timeframe: required.timeframe,
    fromTime: args.fromTime - required.count * interval,
    toTime: args.toTime,
    ...args.cacheOpts,
  });
  if (candles.length === 0) {
    console.log(`[${args.pair.symbol}] no HTF ${required.timeframe} candles; market state skipped`);
  }
  return candles;
}

export async function loadMtfCandles(args: LoadReplayCandlesArgs): Promise<Candle[]> {
  if (args.injected !== undefined) {
    return args.injected;
  }
  if (args.skipFetch) {
    return [];
  }

  const required = args.strategyManager.getRequiredMtfCandles();
  const interval = candleIntervalSeconds(required.timeframe);
  const candles = await loadCachedCandles({
    symbol: args.pair.symbol,
    poolAddress: args.pair.geckoPoolAddress,
    timeframe: required.timeframe,
    fromTime: args.fromTime - required.count * interval,
    toTime: args.toTime,
    ...args.cacheOpts,
  });
  if (candles.length === 0) {
    console.log(`[${args.pair.symbol}] no MTF ${required.timeframe} candles; volatility skipped`);
  }
  return candles;
}

/** Inclusive end index of candles with open time ≤ `atTime`. */
export function advanceClosedEnd(candles: Candle[], atTime: number, end: number): number {
  let next = end;
  while (next < candles.length && candles[next]!.time <= atTime) {
    next += 1;
  }
  return next;
}

export interface SyncMarketIndicatorsArgs {
  pair: string;
  strategyManager: StrategyManager;
  htfCandles: Candle[];
  mtfCandles: Candle[];
  atTime: number;
  price: number;
  htfEnd: number;
  mtfEnd: number;
  lastMarket: MarketIndicators | undefined;
}

export interface SyncMarketIndicatorsResult {
  htfEnd: number;
  mtfEnd: number;
  lastMarket: MarketIndicators | undefined;
  /** True when a new HTF or 1h bar closed and indicators were re-evaluated. */
  evaluated: boolean;
}

/**
 * Advance HTF/1h windows to `atTime` and re-evaluate market indicators when a bar closes.
 * Same cadence as backtest: trend/vol only change on HTF or 1h close.
 */
export function syncMarketIndicators(args: SyncMarketIndicatorsArgs): SyncMarketIndicatorsResult {
  const htfEnd = advanceClosedEnd(args.htfCandles, args.atTime, args.htfEnd);
  const mtfEnd = advanceClosedEnd(args.mtfCandles, args.atTime, args.mtfEnd);
  if ((htfEnd === 0 && mtfEnd === 0) || (htfEnd === args.htfEnd && mtfEnd === args.mtfEnd)) {
    return { htfEnd, mtfEnd, lastMarket: args.lastMarket, evaluated: false };
  }

  const htfWindow = args.htfCandles.slice(0, htfEnd);
  const mtfWindow = args.mtfCandles.slice(0, mtfEnd);
  const lastBar = htfWindow[htfWindow.length - 1] ?? mtfWindow[mtfWindow.length - 1];
  if (lastBar === undefined) {
    return { htfEnd, mtfEnd, lastMarket: args.lastMarket, evaluated: false };
  }
  const market = args.strategyManager.evaluate(
    args.pair,
    htfWindow,
    mtfWindow,
    args.price,
    new Date(lastBar.time * 1000),
  );
  args.strategyManager.applyMarketIndicators(market, args.lastMarket);
  return { htfEnd, mtfEnd, lastMarket: market, evaluated: true };
}
