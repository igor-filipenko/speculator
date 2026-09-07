import type {
  HtfTimeframe,
  MarketIndicators,
  PairConfig,
  RequiredCandles,
  Timeframe,
} from "../types.js";
import { candleIntervalSeconds } from "./gecko-terminal.js";
import { evaluateMarketIndicators, htfParamsFor, mtfParamsFor } from "./htf.js";
import { loadCachedCandles } from "./ohlcv-cache.js";

/**
 * Load HTF trend/S/R plus 1h volatility {@link MarketIndicators} from OHLCV cache.
 */
export async function refreshMarketIndicators(args: {
  pair: PairConfig;
  required: RequiredCandles;
  mtfRequired: RequiredCandles;
  price: number;
  at: Date;
}): Promise<MarketIndicators> {
  const timeframe = asHtfTimeframe(args.required.timeframe);
  const mtfTimeframe = asMtfTimeframe(args.mtfRequired.timeframe);
  const nowSec = Math.floor(args.at.getTime() / 1000);
  const params = htfParamsFor(timeframe);
  const mtfParams = mtfParamsFor();

  const interval = candleIntervalSeconds(timeframe);
  const fromTime = nowSec - args.required.count * interval;
  const mtfInterval = candleIntervalSeconds(mtfTimeframe);
  const mtfFromTime = nowSec - args.mtfRequired.count * mtfInterval;

  const [candles, mtfCandles] = await Promise.all([
    loadCachedCandles({
      symbol: args.pair.symbol,
      poolAddress: args.pair.geckoPoolAddress,
      timeframe,
      fromTime,
      toTime: nowSec,
    }),
    loadCachedCandles({
      symbol: args.pair.symbol,
      poolAddress: args.pair.geckoPoolAddress,
      timeframe: mtfTimeframe,
      fromTime: mtfFromTime,
      toTime: nowSec,
    }),
  ]);

  const last = candles[candles.length - 1];
  const at = last !== undefined ? new Date(last.time * 1000) : args.at;

  return evaluateMarketIndicators({
    pair: args.pair.symbol,
    candles,
    mtfCandles,
    price: args.price,
    at,
    params,
    mtfParams,
  });
}

function asHtfTimeframe(timeframe: Timeframe): HtfTimeframe {
  if (timeframe === "4h" || timeframe === "1d") {
    return timeframe;
  }
  throw new Error(`HTF timeframe must be 4h or 1d, got ${timeframe}`);
}

function asMtfTimeframe(timeframe: Timeframe): "1h" {
  if (timeframe === "1h") {
    return timeframe;
  }
  throw new Error(`MTF timeframe must be 1h, got ${timeframe}`);
}
