import { adx, atr, ema } from "../strategy/indicators.js";
import type { Candle, HtfTimeframe, MarketIndicators, PoolStats, Trend } from "../types.js";

/** HTF indicator periods for {@link evaluateMarketIndicators}. */
export interface HtfParams {
  timeframe: HtfTimeframe;
  emaSlow: number;
  emaFast: number;
  atrPeriod: number;
  adxPeriod: number;
  adxFlatMax: number;
}

export function htfParamsFor(timeframe: HtfTimeframe): HtfParams {
  return {
    timeframe,
    emaSlow: 200,
    emaFast: 50,
    atrPeriod: 14,
    adxPeriod: 14,
    adxFlatMax: 20,
  };
}

export interface EvaluateMarketIndicatorsInput {
  pair: string;
  candles: Candle[];
  price: number;
  at: Date;
  params: HtfParams;
  poolStats?: PoolStats;
}

/**
 * Pure HTF regime from candles. Callers load OHLCV via required-candle counts.
 *
 * TODO: Open Interest / OI-mcap would need a derivatives vendor; GeckoTerminal does not provide it.
 */
export function evaluateMarketIndicators(input: EvaluateMarketIndicatorsInput): MarketIndicators {
  const { pair, candles, price, at, params, poolStats } = input;
  const base: MarketIndicators = {
    pair,
    timeframe: params.timeframe,
    at,
    price,
    trend: "unknown",
    candles,
  };
  if (poolStats?.marketCapUsd != null) {
    base.marketCapUsd = poolStats.marketCapUsd;
  }
  if (poolStats?.fdvUsd != null) {
    base.fdvUsd = poolStats.fdvUsd;
  }

  if (candles.length === 0) {
    return base;
  }

  const closes = candles.map((c) => c.close);
  const lastClose = candles[candles.length - 1]!.close;
  const ema200 = last(ema(closes, params.emaSlow));
  const ema50 = last(ema(closes, params.emaFast));
  const atrNow = last(atr(candles, params.atrPeriod));
  const adxNow = last(adx(candles, params.adxPeriod));

  const trend = classifyTrend(lastClose, ema200, adxNow, params.adxFlatMax);

  const indicators: MarketIndicators = { ...base, trend };
  if (ema200 != null) {
    indicators.ema200 = ema200;
    if (price > 0 && ema200 > 0) {
      indicators.distEma200Pct = (price - ema200) / ema200;
    }
  }
  if (ema50 != null) {
    indicators.ema50 = ema50;
  }
  if (adxNow != null) {
    indicators.adx = adxNow;
  }
  if (atrNow != null) {
    indicators.atr = atrNow;
    if (price > 0) {
      indicators.atrPct = atrNow / price;
    }
  }
  return indicators;
}

function classifyTrend(
  close: number,
  ema200: number | undefined,
  adxNow: number | undefined,
  adxFlatMax: number,
): Trend {
  if (ema200 == null) {
    return "unknown";
  }
  if (adxNow == null || adxNow < adxFlatMax) {
    return "flat";
  }
  if (close > ema200) {
    return "bullish";
  }
  if (close < ema200) {
    return "bearish";
  }
  return "flat";
}

function last(series: (number | null)[]): number | undefined {
  const value = series[series.length - 1];
  return value ?? undefined;
}
