import type {
  HtfTimeframe,
  MarketIndicators,
  PairConfig,
  RequiredCandles,
  Timeframe,
} from "../types.js";
import { candleIntervalSeconds } from "./gecko-terminal.js";
import { evaluateMarketIndicators, htfParamsFor } from "./htf.js";
import { loadCachedCandles } from "./ohlcv-cache.js";

/**
 * Load HTF {@link MarketIndicators} from OHLCV cache.
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

  const interval = candleIntervalSeconds(timeframe);
  const fromTime = nowSec - args.required.count * interval;

  const candles = await loadCachedCandles({
    symbol: args.pair.symbol,
    poolAddress: args.pair.geckoPoolAddress,
    timeframe,
    fromTime,
    toTime: nowSec,
  });

  const last = candles[candles.length - 1];
  const at = last !== undefined ? new Date(last.time * 1000) : args.at;

  return evaluateMarketIndicators({
    pair: args.pair.symbol,
    candles,
    price: args.price,
    at,
    params,
  });
}

function asHtfTimeframe(timeframe: Timeframe): HtfTimeframe {
  if (timeframe === "4h" || timeframe === "1d") {
    return timeframe;
  }
  throw new Error(`HTF timeframe must be 4h or 1d, got ${timeframe}`);
}
