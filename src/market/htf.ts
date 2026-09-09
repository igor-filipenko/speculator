import { atr, bollinger, dmi, ema, keltner, percentile } from "../strategy/indicators.js";
import type {
  Candle,
  HtfSnapshot,
  HtfTimeframe,
  MarketIndicators,
  MtfSnapshot,
  MtfTimeframe,
  Trend,
  Volatility,
} from "../types.js";
import { keyLevels } from "./levels.js";

/** HTF indicator periods for {@link evaluateMarketIndicators}. */
export interface HtfParams {
  timeframe: HtfTimeframe;
  emaSlow: number;
  emaFast: number;
  atrPeriod: number;
  adxPeriod: number;
  adxFlatMax: number;
  /**
   * Consecutive HTF closes of the same raw label before a trend switch is published.
   * 1 = previous hair-trigger (switch on the first 4h/1d bar). 2 ignores one-bar
   * ADX/stack blips and delays a real move by one HTF bar.
   */
  trendConfirmBars: number;
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
    trendConfirmBars: 2,
    swingLeftRight: 2,
    levelClusterAtrMult: 0.5,
    levelAtPriceAtrMult: 1,
    levelMaxDistAtr: 8,
    maxLevelsEach: 3,
  };
}

/** 1h volatility periods for {@link evaluateMarketIndicators}. */
export interface MtfParams {
  timeframe: MtfTimeframe;
  bbPeriod: number;
  bbStdDev: number;
  kcPeriod: number;
  kcAtrMult: number;
  atrPctLookback: number;
  atrPctHighPercentile: number;
  /**
   * Consecutive 1h closes of the same raw label before a vol switch is published.
   * 1 = previous hair-trigger. 2 ignores one-hour squeeze/high/low blips.
   */
  volConfirmBars: number;
  swingLeftRight: number;
  levelClusterAtrMult: number;
  levelAtPriceAtrMult: number;
  levelMaxDistAtr: number;
  maxLevelsEach: number;
}

export function mtfParamsFor(): MtfParams {
  return {
    timeframe: "1h",
    bbPeriod: 20,
    bbStdDev: 2,
    kcPeriod: 20,
    kcAtrMult: 1.5,
    atrPctLookback: 100,
    atrPctHighPercentile: 0.7,
    volConfirmBars: 2,
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
  mtfCandles?: Candle[];
  mtfParams?: MtfParams;
}

/**
 * Pure HTF trend + S/R from `candles`, 1h volatility from `mtfCandles`.
 * Callers load OHLCV via required-candle counts.
 *
 * TODO: Open Interest / OI-mcap would need a derivatives vendor; GeckoTerminal does not provide it.
 */
export function evaluateMarketIndicators(input: EvaluateMarketIndicatorsInput): MarketIndicators {
  const { pair, candles, price, params } = input;
  const mtfParams = input.mtfParams ?? mtfParamsFor();
  const { volatility, mtf } = classifyVolatility(input.mtfCandles ?? [], price, mtfParams);
  const htf: HtfSnapshot = { timeframe: params.timeframe, candles };
  const base: MarketIndicators = {
    pair,
    price,
    trend: "unknown",
    volatility,
    htf,
    mtf,
  };

  if (candles.length === 0) {
    return base;
  }

  const closes = candles.map((c) => c.close);
  const ema200s = ema(closes, params.emaSlow);
  const ema50s = ema(closes, params.emaFast);
  const atrNow = last(atr(candles, params.atrPeriod));
  const dmiNow = dmi(candles, params.adxPeriod);
  const adxNow = last(dmiNow.adx);
  const plusDi = last(dmiNow.plusDi);
  const minusDi = last(dmiNow.minusDi);
  const ema200 = last(ema200s);
  const ema50 = last(ema50s);

  const raw: Trend[] = [];
  for (let i = 0; i < candles.length; i++) {
    raw.push(
      classifyTrend({
        close: candles[i]!.close,
        ema200: at(ema200s, i),
        ema50: at(ema50s, i),
        adxNow: at(dmiNow.adx, i),
        plusDi: at(dmiNow.plusDi, i),
        minusDi: at(dmiNow.minusDi, i),
        adxFlatMax: params.adxFlatMax,
      }),
    );
  }
  const trend = confirmTrend(raw, params.trendConfirmBars);

  if (ema200 != null) {
    htf.ema200 = ema200;
    if (price > 0 && ema200 > 0) {
      htf.distEma200Pct = (price - ema200) / ema200;
    }
  }
  if (ema50 != null) {
    htf.ema50 = ema50;
  }
  if (adxNow != null) {
    htf.adx = adxNow;
  }
  if (plusDi != null) {
    htf.plusDi = plusDi;
  }
  if (minusDi != null) {
    htf.minusDi = minusDi;
  }
  if (atrNow != null) {
    htf.atr = atrNow;
    if (price > 0) {
      htf.atrPct = atrNow / price;
    }
  }
  attachKeyLevels(htf, candles, price, atrNow, params);
  return { ...base, trend };
}

/** Recompute S/R and last +DI/−DI from candles (hydrate overlay). */
export function attachDerivedFromCandles(
  indicators: MarketIndicators,
  candles: Candle[],
  livePrice: number,
  params: HtfParams,
): void {
  const htf = indicators.htf ?? { timeframe: params.timeframe, candles };
  indicators.htf = htf;
  const dmiNow = dmi(candles, params.adxPeriod);
  const plusDi = last(dmiNow.plusDi);
  const minusDi = last(dmiNow.minusDi);
  if (plusDi != null) {
    htf.plusDi = plusDi;
  }
  if (minusDi != null) {
    htf.minusDi = minusDi;
  }
  attachKeyLevels(htf, candles, livePrice, htf.atr, params);
}

type LevelAttachParams = Pick<
  HtfParams,
  | "swingLeftRight"
  | "levelClusterAtrMult"
  | "levelAtPriceAtrMult"
  | "levelMaxDistAtr"
  | "maxLevelsEach"
>;

function attachKeyLevels(
  snapshot: HtfSnapshot | MtfSnapshot,
  candles: Candle[],
  price: number,
  atrNow: number | undefined,
  params: LevelAttachParams,
): void {
  const found = keyLevels(candles, price, atrNow, {
    swingLeftRight: params.swingLeftRight,
    clusterAtrMult: params.levelClusterAtrMult,
    atPriceAtrMult: params.levelAtPriceAtrMult,
    maxDistAtr: params.levelMaxDistAtr,
    maxLevelsEach: params.maxLevelsEach,
  });
  if (found.levels.length > 0) {
    snapshot.levels = found.levels;
  }
  if (found.support !== undefined) {
    snapshot.support = found.support;
  }
  if (found.resistance !== undefined) {
    snapshot.resistance = found.resistance;
  }
}

function classifyVolatility(
  candles: Candle[],
  price: number,
  params: MtfParams,
): { volatility: Volatility; mtf: MtfSnapshot } {
  const mtf: MtfSnapshot = { timeframe: params.timeframe };
  if (candles.length === 0) {
    return { volatility: "unknown", mtf };
  }

  const closes = candles.map((c) => c.close);
  const bb = bollinger(closes, params.bbPeriod, params.bbStdDev);
  const kc = keltner(candles, params.kcPeriod, params.kcAtrMult);
  const atrs = atr(candles, params.kcPeriod);
  const atrNow = last(atrs);
  if (atrNow != null) {
    mtf.atr = atrNow;
    if (price > 0) {
      mtf.atrPct = atrNow / price;
    }
  }
  attachKeyLevels(mtf, candles, price, atrNow, params);

  const bbUpper = last(bb.upper);
  const bbLower = last(bb.lower);
  const bbMid = last(bb.mid);
  const kcUpper = last(kc.upper);
  const kcLower = last(kc.lower);
  const kcMid = last(kc.mid);
  if (bbMid != null) {
    mtf.bbMid = bbMid;
  }
  if (bbUpper != null) {
    mtf.bbUpper = bbUpper;
  }
  if (bbLower != null) {
    mtf.bbLower = bbLower;
  }
  if (kcMid != null) {
    mtf.kcMid = kcMid;
  }
  if (kcUpper != null) {
    mtf.kcUpper = kcUpper;
  }
  if (kcLower != null) {
    mtf.kcLower = kcLower;
  }

  const atrPcts: number[] = [];
  const raw: Volatility[] = [];
  for (let i = 0; i < candles.length; i++) {
    const a = atrs[i];
    const close = candles[i]!.close;
    if (a != null && close > 0) {
      atrPcts.push(a / close);
    }
    raw.push(classifyVolatilityAt(i, bb, kc, atrPcts, params));
  }
  return { volatility: confirmLabel(raw, params.volConfirmBars, "unknown"), mtf };
}

function classifyVolatilityAt(
  i: number,
  bb: { upper: (number | null)[]; lower: (number | null)[] },
  kc: { upper: (number | null)[]; lower: (number | null)[] },
  atrPcts: number[],
  params: MtfParams,
): Volatility {
  const bbUpper = at(bb.upper, i);
  const bbLower = at(bb.lower, i);
  const kcUpper = at(kc.upper, i);
  const kcLower = at(kc.lower, i);
  if (bbUpper == null || bbLower == null || kcUpper == null || kcLower == null) {
    return "unknown";
  }
  if (bbUpper < kcUpper && bbLower > kcLower) {
    return "squeeze";
  }
  const window = atrPcts.slice(-params.atrPctLookback);
  if (window.length < params.atrPctLookback) {
    return "unknown";
  }
  const threshold = percentile(window, params.atrPctHighPercentile);
  const lastAtrPct = window[window.length - 1];
  if (threshold == null || lastAtrPct == null) {
    return "unknown";
  }
  if (lastAtrPct > threshold) {
    return "high";
  }
  return "low";
}

/**
 * Publish a label only after `confirmBars` consecutive raw values agree.
 * The first label after `unset` (warmup) is accepted immediately.
 * `confirmBars <= 1` restores the previous one-bar hair-trigger.
 */
export function confirmLabel<T extends string>(
  rawSeries: readonly T[],
  confirmBars: number,
  unset: T,
): T {
  const needed = confirmBars <= 1 ? 1 : confirmBars;
  let published: T = unset;
  let pending: T | undefined;
  let pendingCount = 0;

  for (const raw of rawSeries) {
    if (published === unset) {
      published = raw;
      pending = undefined;
      pendingCount = 0;
      continue;
    }
    if (raw === published) {
      pending = undefined;
      pendingCount = 0;
      continue;
    }
    if (raw === pending) {
      pendingCount += 1;
    } else {
      pending = raw;
      pendingCount = 1;
    }
    if (pendingCount >= needed) {
      published = raw;
      pending = undefined;
      pendingCount = 0;
    }
  }
  return published;
}

/** {@link confirmLabel} for HTF trend (`unset` is `unknown`). */
export function confirmTrend(rawSeries: Trend[], confirmBars: number): Trend {
  return confirmLabel(rawSeries, confirmBars, "unknown");
}

/** Raw per-bar vote; {@link confirmTrend} publishes after consecutive HTF closes agree. */
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
  return at(series, series.length - 1);
}

function at(series: (number | null)[], i: number): number | undefined {
  const value = series[i];
  return value ?? undefined;
}
