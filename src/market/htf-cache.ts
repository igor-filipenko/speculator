import { readCandles } from "../db/candles.js";
import {
  loadFreshMarketIndicators,
  toMarketIndicators,
  toPersistedMarketIndicators,
  upsertMarketIndicators,
  type PersistedMarketIndicators,
} from "../db/market.js";
import type {
  HtfTimeframe,
  MarketIndicators,
  PairConfig,
  PoolStats,
  RequiredCandles,
  Timeframe,
} from "../types.js";
import { candleIntervalSeconds, fetchPoolStats } from "./gecko-terminal.js";
import { evaluateMarketIndicators, htfParamsFor } from "./htf.js";
import { loadCachedCandles } from "./ohlcv-cache.js";

/**
 * Load HTF {@link MarketIndicators}: reuse `market.indicators` while the cached bar is open,
 * otherwise Gecko OHLCV + pool stats, then persist. Pool stats failures are logged;
 * candle failures propagate to the caller.
 */
export async function refreshMarketIndicators(args: {
  pair: PairConfig;
  required: RequiredCandles;
  price: number;
  at: Date;
}): Promise<MarketIndicators> {
  const timeframe = asHtfTimeframe(args.required.timeframe);
  const nowSec = Math.floor(args.at.getTime() / 1000);
  const params = htfParamsFor(timeframe);

  const persisted = await loadFreshMarketIndicators({
    pair: args.pair.symbol,
    timeframe,
    nowSec,
  });
  if (persisted !== null) {
    const cached = await hydrateMarketIndicators(persisted, args.required.count, args.price);
    if (cached !== null) {
      return cached;
    }
  }

  const interval = candleIntervalSeconds(timeframe);
  const fromTime = nowSec - args.required.count * interval;

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

  const indicators = evaluateMarketIndicators({
    pair: args.pair.symbol,
    candles,
    price: args.price,
    at,
    params,
    ...(poolStats !== undefined ? { poolStats } : {}),
  });
  await upsertMarketIndicators(toPersistedMarketIndicators(indicators));
  return indicators;
}

async function hydrateMarketIndicators(
  persisted: PersistedMarketIndicators,
  requiredCount: number,
  livePrice: number,
): Promise<MarketIndicators | null> {
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
  return toMarketIndicators(persisted, candles, livePrice);
}

function asHtfTimeframe(timeframe: Timeframe): HtfTimeframe {
  if (timeframe === "4h" || timeframe === "1d") {
    return timeframe;
  }
  throw new Error(`HTF timeframe must be 4h or 1d, got ${timeframe}`);
}
