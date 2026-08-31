import { atr, dmi, ema } from "../strategy/indicators.js";
import type { Candle, HtfTimeframe, MarketIndicators, Trend } from "../types.js";
import { keyLevels } from "./levels.js";

/** HTF indicator periods for {@link evaluateMarketIndicators}. */
export interface HtfParams {
  timeframe: HtfTimeframe;
  emaSlow: number;
  emaFast: number;
  atrPeriod: number;
  adxPeriod: number;
  adxFlatMax: number;
  swingLeftRight: number;
  levelClusterAtrMult: number;
  levelAtPriceAtrMult: number;
  levelMaxDistAtr: number;
  maxLevelsEach: number;
}

export function htfParamsFor(timeframe: HtfTimeframe): HtfParams {
  return {
    timeframe,
    emaSlow: 200,
    emaFast: 50,
    atrPeriod: 14,
    adxPeriod: 14,
    adxFlatMax: 20,
    swingLeftRight: 2,
    levelClusterAtrMult: 0.5,
    levelAtPriceAtrMult: 1,
    levelMaxDistAtr: 8,
    maxLevelsEach: 3,
  };
}

export interface EvaluateMarketIndicatorsInput {
  pair: string;
  candles: Candle[];
  price: number;
  at: Date;
  params: HtfParams;
}

/**
 * Pure HTF regime from candles. Callers load OHLCV via required-candle counts.
 *
 * TODO: Open Interest / OI-mcap would need a derivatives vendor; GeckoTerminal does not provide it.
 */
export function evaluateMarketIndicators(input: EvaluateMarketIndicatorsInput): MarketIndicators {
  const { pair, candles, price, at, params } = input;
  const base: MarketIndicators = {
    pair,
    timeframe: params.timeframe,
    at,
    price,
    trend: "unknown",
    candles,
  };

  if (candles.length === 0) {
    return base;
  }

  const closes = candles.map((c) => c.close);
  const lastClose = candles[candles.length - 1]!.close;
  const ema200 = last(ema(closes, params.emaSlow));
  const ema50 = last(ema(closes, params.emaFast));
  const atrNow = last(atr(candles, params.atrPeriod));
  const dmiNow = dmi(candles, params.adxPeriod);
  const adxNow = last(dmiNow.adx);
  const plusDi = last(dmiNow.plusDi);
  const minusDi = last(dmiNow.minusDi);

  const trend = classifyTrend({
    close: lastClose,
    ema200,
    ema50,
    adxNow,
    plusDi,
    minusDi,
    adxFlatMax: params.adxFlatMax,
  });

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
  if (plusDi != null) {
    indicators.plusDi = plusDi;
  }
  if (minusDi != null) {
    indicators.minusDi = minusDi;
  }
  if (atrNow != null) {
    indicators.atr = atrNow;
    if (price > 0) {
      indicators.atrPct = atrNow / price;
    }
  }
  attachKeyLevels(indicators, candles, price, atrNow, params);
  return indicators;
}

/** Recompute S/R and last +DI/−DI from candles (hydrate overlay). */
export function attachDerivedFromCandles(
  indicators: MarketIndicators,
  candles: Candle[],
  livePrice: number,
  params: HtfParams,
): void {
  const dmiNow = dmi(candles, params.adxPeriod);
  const plusDi = last(dmiNow.plusDi);
  const minusDi = last(dmiNow.minusDi);
  if (plusDi != null) {
    indicators.plusDi = plusDi;
  }
  if (minusDi != null) {
    indicators.minusDi = minusDi;
  }
  attachKeyLevels(indicators, candles, livePrice, indicators.atr, params);
}

function attachKeyLevels(
  indicators: MarketIndicators,
  candles: Candle[],
  price: number,
  atrNow: number | undefined,
  params: HtfParams,
): void {
  const found = keyLevels(candles, price, atrNow, {
    swingLeftRight: params.swingLeftRight,
    clusterAtrMult: params.levelClusterAtrMult,
    atPriceAtrMult: params.levelAtPriceAtrMult,
    maxDistAtr: params.levelMaxDistAtr,
    maxLevelsEach: params.maxLevelsEach,
  });
  if (found.levels.length > 0) {
    indicators.levels = found.levels;
  }
  if (found.support !== undefined) {
    indicators.support = found.support;
  }
  if (found.resistance !== undefined) {
    indicators.resistance = found.resistance;
  }
}

function classifyTrend(input: {
  close: number;
  ema200: number | undefined;
  ema50: number | undefined;
  adxNow: number | undefined;
  plusDi: number | undefined;
  minusDi: number | undefined;
  adxFlatMax: number;
}): Trend {
  const { close, ema200, ema50, adxNow, plusDi, minusDi, adxFlatMax } = input;
  if (ema200 == null || ema50 == null) {
    return "unknown";
  }
  if (adxNow == null || adxNow < adxFlatMax || plusDi == null || minusDi == null) {
    return "flat";
  }
  const stackedUp = close > ema50 && ema50 > ema200 && plusDi > minusDi;
  const stackedDown = close < ema50 && ema50 < ema200 && minusDi > plusDi;
  if (stackedUp) {
    return "bullish";
  }
  if (stackedDown) {
    return "bearish";
  }
  return "flat";
}

function last(series: (number | null)[]): number | undefined {
  const value = series[series.length - 1];
  return value ?? undefined;
}
