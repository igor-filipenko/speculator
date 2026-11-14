import { candleIntervalSeconds, timeframeFromMinutes } from "../../../market/candle.js";
import { applySearchPatch } from "../../../types.js";
import type {
  Candle,
  PerpsFees,
  PortfolioSnapshot,
  RequiredCandles,
  SearchSpace,
  Signal,
  SignalSide,
  Strategy,
  StrategyModule,
  StrategyParamPatch,
  Timeframe,
} from "../../../types.js";
import { atr, bollinger, dmi } from "../../indicators.js";
import { buildBollingerSvg } from "../bollinger/index.js";

export interface BandWalkerParams {
  timeframe: Timeframe;
  /** SMA / band lookback. */
  period: number;
  /** Band width in population standard deviations. */
  stdDev: number;
  /** Wilder ATR period. Sizes the initial buffer and the chandelier. */
  atrPeriod: number;
  /** Wilder ADX / DI period. ADX is recorded and does not gate entries. */
  adxPeriod: number;
  /**
   * Longs need +DI above this multiple of −DI. Shorts need the mirror.
   * 0 disables the gate. Exits ignore it.
   */
  diRatio: number;
  /** Middle band must have moved this many bars with the walk. */
  slopeBars: number;
  /** Recent closes inspected for %B persistence. Also the initial-stop window. */
  walkWindow: number;
  /** How many bars in `walkWindow` must sit in the outer %B zone. */
  walkHits: number;
  /** Long persistence is %B at or above this. Short persistence is at or below 1 − this. */
  percentBMin: number;
  /** Initial stop distance past the walk-window extreme, in ATRs. */
  stopAtr: number;
  /** Chandelier stays off until the hold extreme is this many ATRs in favor. */
  trailArmAtr: number;
  /** Once armed, stop distance behind the hold extreme, in ATRs. 0 disables the trail. */
  trailAtr: number;
  /** Once armed, a long stop is at least the fill and a short stop is at most the fill. */
  trailLockEntry: boolean;
}

/** Signal-side params. */
export function bandWalkerParamsFor(): BandWalkerParams {
  return {
    timeframe: "1h",
    period: 30,
    stdDev: 2,
    atrPeriod: 20,
    adxPeriod: 14,
    diRatio: 1.2,
    slopeBars: 5,
    walkWindow: 5,
    walkHits: 3,
    percentBMin: 0.8,
    stopAtr: 0.5,
    trailArmAtr: 1.5,
    trailAtr: 4,
    trailLockEntry: true,
  };
}

/**
 * Decision knobs for `pnpm tune`. Timeframe stays at 1h. ATR and ADX lengths,
 * the walk window, and the slope length stay on {@link bandWalkerParamsFor}.
 */
export const BAND_WALKER_SEARCH_SPACE: SearchSpace = {
  axes: [
    { key: "period", levels: [20, 30, 40] },
    { key: "stdDev", levels: [1.5, 2, 2.5] },
    { key: "diRatio", levels: [1, 1.2, 1.5] },
    { key: "percentBMin", levels: [0.7, 0.8, 0.9] },
    { key: "walkHits", levels: [2, 3, 4] },
    { key: "stopAtr", levels: [0.5, 1, 1.5] },
    { key: "trailArmAtr", levels: [1, 1.5, 2] },
    { key: "trailAtr", levels: [3, 4, 5] },
  ],
};

/**
 * Initial stop beyond the walk-window extreme. Longs sit under the lowest low;
 * shorts sit over the highest high.
 */
export function bandWalkerStopPrice(
  side: "long" | "short",
  windowExtreme: number,
  atrValue: number,
  stopAtr: number,
): number {
  const distance = stopAtr * atrValue;
  return side === "long" ? windowExtreme - distance : windowExtreme + distance;
}

/**
 * Chandelier stop once the hold extreme has moved `trailArmAtr` × ATR in favor.
 * Null when the trail is disabled, ATR is missing, or the move has not armed it.
 * The caller supplies an extreme taken from closed bars only.
 */
export function bandWalkerTrailPrice(input: {
  side: "long" | "short";
  entryPrice: number;
  extreme: number;
  atrValue: number;
  trailAtr: number;
  trailArmAtr: number;
  trailLockEntry: boolean;
}): number | null {
  const { side, entryPrice, extreme, atrValue, trailAtr, trailArmAtr, trailLockEntry } = input;
  if (!(entryPrice > 0) || !(atrValue > 0) || !(trailAtr > 0)) return null;
  const advance = side === "long" ? extreme - entryPrice : entryPrice - extreme;
  if (advance < trailArmAtr * atrValue) return null;
  const trail = side === "long" ? extreme - trailAtr * atrValue : extreme + trailAtr * atrValue;
  const level = trailLockEntry
    ? side === "long"
      ? Math.max(trail, entryPrice)
      : Math.min(trail, entryPrice)
    : trail;
  return level > 0 ? level : null;
}

export interface BandWalkerInput {
  pair: string;
  candles: Candle[];
  strategy: BandWalkerParams;
  /** Spot price used in the signal (usually the exchange quote). */
  price: number;
  at?: Date;
  /** Open fill. Required for the middle-band exit and the chandelier. */
  entryPrice?: number;
  /** Which side `entryPrice` belongs to. */
  positionSide?: "long" | "short";
  /** When the position was opened. Closed bars at or before this are not the trail extreme. */
  openedAt?: Date;
  /**
   * Perps open/close/borrow rates from the exchange cache.
   * Missing rates block a new short. A cover does not need them.
   */
  perpsFees?: PerpsFees;
}

/**
 * 1h band walk. A long opens on the first closed bar that closes above the upper
 * band while the middle is rising, at least `walkHits` of the last `walkWindow`
 * closes have %B ≥ `percentBMin`, and +DI leads −DI. A short is the mirror and
 * needs a perps fee schedule. A later bar of the same walk does not open again.
 * An open long sells on a closed close back through the middle. An open short
 * covers on a closed close back through the middle. There is no take-profit.
 * An opening signal sets `slPrice` beyond the walk-window extreme. A later signal
 * sets `slPrice` to the chandelier candidate when that trail is armed; the risk
 * manager writes it onto the position only when it is tighter.
 */
export function evaluateBandWalker(input: BandWalkerInput): Signal {
  const { pair, candles, strategy, price } = input;
  const at = input.at ?? new Date();
  const atSec = at.getTime() / 1000;
  const forming = candles[candles.length - 1];
  const lastIsClosed = forming?.isClosed(atSec) === true;
  const signalCandles = lastIsClosed || forming == null ? candles : candles.slice(0, -1);
  const closes = signalCandles.map((c) => c.close);

  const bands = bollinger(closes, strategy.period, strategy.stdDev);
  const atrSeries = atr(signalCandles, strategy.atrPeriod);
  const dmiNow = dmi(signalCandles, strategy.adxPeriod);

  const i = closes.length - 1;
  const bbMid = bands.mid[i];
  const bbUpper = bands.upper[i];
  const bbLower = bands.lower[i];
  const atrNow = atrSeries[i];
  const adxNow = dmiNow.adx[i];
  const plusDi = dmiNow.plusDi[i];
  const minusDi = dmiNow.minusDi[i];
  const lastBar = signalCandles[i];

  const meta: NonNullable<Signal["meta"]> = {};
  if (bbMid != null) meta.bbMid = bbMid;
  if (bbUpper != null) meta.bbUpper = bbUpper;
  if (bbLower != null) meta.bbLower = bbLower;
  if (atrNow != null) meta.atr = atrNow;
  if (adxNow != null) meta.adx = adxNow;
  if (plusDi != null) meta.plusDi = plusDi;
  if (minusDi != null) meta.minusDi = minusDi;
  const rangeBar = forming ?? lastBar;
  if (rangeBar != null) {
    meta.barLow = rangeBar.low;
    meta.barHigh = rangeBar.high;
  }

  const base = {
    pair,
    strategyId: "band-walker",
    price,
    at,
    meta,
    tpPrices: [] as number[],
    minRewardRisk: 0,
  };

  if (bbMid == null || bbUpper == null || bbLower == null || lastBar == null || i < 0) {
    return { ...base, side: "HOLD", reason: "Indicators not warm yet (need more candles)" };
  }

  const close = closes[i]!;
  const entry = input.entryPrice;
  const openSide = input.positionSide;
  const long = openSide === "long" && entry != null && entry > 0;
  const short = openSide === "short" && entry != null && entry > 0;

  if (long || short) {
    const side = long ? "long" : "short";
    const crossed = long ? close < bbMid : close > bbMid;
    const trail =
      entry != null && input.openedAt != null && atrNow != null
        ? bandWalkerTrailPrice({
            side,
            entryPrice: entry,
            extreme: closedExtreme(side, entry, input.openedAt, signalCandles, strategy.timeframe),
            atrValue: atrNow,
            trailAtr: strategy.trailAtr,
            trailArmAtr: strategy.trailArmAtr,
            trailLockEntry: strategy.trailLockEntry,
          })
        : null;
    if (crossed) {
      const through = long ? "below" : "above";
      return {
        ...base,
        side: long ? "SELL" : "BUY",
        reason: `Walk over: close ${fmt(close)} ${through} mid ${fmt(bbMid)}`,
        ...(trail != null ? { slPrice: trail } : {}),
      };
    }
    const trailNote = trail != null ? `trail ${fmt(trail)}` : "trail not armed";
    return {
      ...base,
      side: "HOLD",
      reason: `Walk holds (close ${fmt(close)}, mid ${fmt(bbMid)}); ${trailNote}`,
      ...(trail != null ? { slPrice: trail } : {}),
    };
  }

  const longWalk = walkAt(strategy, closes, bands, dmiNow, i, "long");
  const shortWalk = walkAt(strategy, closes, bands, dmiNow, i, "short");
  const longPrev = walkAt(strategy, closes, bands, dmiNow, i - 1, "long");
  const shortPrev = walkAt(strategy, closes, bands, dmiNow, i - 1, "short");

  let side: SignalSide = "HOLD";
  let reason = lastIsClosed
    ? `No band walk (close=${fmt(close)}, lower=${fmt(bbLower)}, mid=${fmt(bbMid)}, upper=${fmt(bbUpper)})`
    : `No band walk (waiting for a closed ${strategy.timeframe} bar; close=${fmt(close)}, mid=${fmt(bbMid)})`;

  if (close > bbUpper) {
    reason = walkHoldReason(strategy, closes, bands, dmiNow, i, "long", longWalk, longPrev);
    if (longWalk && !longPrev) side = "BUY";
  } else if (close < bbLower) {
    if (input.perpsFees == null) {
      reason = "Lower walk ignored: perps fee schedule missing";
    } else {
      reason = walkHoldReason(strategy, closes, bands, dmiNow, i, "short", shortWalk, shortPrev);
      if (shortWalk && !shortPrev) side = "SELL";
    }
  }

  if ((side !== "BUY" && side !== "SELL") || atrNow == null || !(atrNow > 0)) {
    return { ...base, side, reason };
  }

  const positionSide = side === "BUY" ? "long" : "short";
  const extreme = windowExtreme(signalCandles, i, strategy.walkWindow, positionSide);
  if (extreme == null) {
    return { ...base, side: "HOLD", reason };
  }
  const slPrice = bandWalkerStopPrice(positionSide, extreme, atrNow, strategy.stopAtr);
  const beyond = positionSide === "long" ? slPrice < price : slPrice > price;
  if (!beyond) {
    const head = positionSide === "long" ? "Upper walk ignored" : "Lower walk ignored";
    return {
      ...base,
      side: "HOLD",
      reason: `${head}: stop ${fmt(slPrice)} is not beyond the quote ${fmt(price)}`,
    };
  }
  return { ...base, side, reason, slPrice };
}

/** 1h band walk: closed-bar close outside BB(30, 2), rising or falling middle, 3 of 5 %B, DI lead. No take-profit. */
export class BandWalkerStrategy implements Strategy {
  readonly axes = BAND_WALKER_SEARCH_SPACE.axes;
  private readonly params: BandWalkerParams;

  constructor(params?: BandWalkerParams) {
    this.params = params ?? bandWalkerParamsFor();
  }

  getSearchDefaults(): Readonly<Record<string, number>> {
    return searchDefaults(this.params);
  }

  paramPatch(values: Readonly<Record<string, number>>): StrategyParamPatch {
    const knobs: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(paramsFromSearch(values))) {
      if (value !== undefined) knobs[key] = value;
    }
    return { values: knobs };
  }

  getDisplayName(): string {
    const { timeframe, period, stdDev, percentBMin, walkHits, walkWindow, diRatio } = this.params;
    return `band-walker (${timeframe} BB${period}×${stdDev} %B${percentBMin} ${walkHits}/${walkWindow} DI${diRatio})`;
  }

  getId(): string {
    return "band-walker";
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, period, atrPeriod, adxPeriod, slopeBars, walkWindow } = this.params;
    const warm = Math.max(period + slopeBars, atrPeriod, adxPeriod * 2, walkWindow) + 5;
    return { timeframe, count: Math.max(warm, 160) };
  }

  evaluateSignal(
    pair: string,
    candles: Candle[],
    price: number,
    at: Date,
    portfolio?: PortfolioSnapshot,
    perpsFees?: PerpsFees,
  ): Signal {
    const position = portfolio?.position;
    const positioned =
      (position?.side === "long" || position?.side === "short") && position.entryPrice > 0
        ? position
        : undefined;
    return evaluateBandWalker({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
      ...(perpsFees !== undefined ? { perpsFees } : {}),
      ...(positioned?.side === "long" || positioned?.side === "short"
        ? {
            entryPrice: positioned.entryPrice,
            positionSide: positioned.side,
            ...(positioned.openedAt != null ? { openedAt: positioned.openedAt } : {}),
          }
        : {}),
    });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildBollingerSvg({ pair, candles, strategy: this.params });
  }
}

interface BandSeries {
  mid: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
}

interface DiSeries {
  plusDi: (number | null)[];
  minusDi: (number | null)[];
}

function percentB(close: number, upper: number, lower: number): number | null {
  const width = upper - lower;
  if (!(width > 0)) return null;
  return (close - lower) / width;
}

/** +DI must lead for a long and −DI must lead for a short. A non-positive ratio disables the gate. */
function diConfirms(
  side: "long" | "short",
  plusDi: number,
  minusDi: number,
  diRatio: number,
): boolean {
  if (!(diRatio > 0)) return true;
  if (side === "long") return plusDi > diRatio * minusDi;
  return minusDi > diRatio * plusDi;
}

function walkAt(
  strategy: BandWalkerParams,
  closes: number[],
  bands: BandSeries,
  di: DiSeries,
  index: number,
  side: "long" | "short",
): boolean {
  if (index < 0 || index >= closes.length) return false;
  const close = closes[index];
  const upper = bands.upper[index];
  const lower = bands.lower[index];
  const mid = bands.mid[index];
  const midThen = bands.mid[index - strategy.slopeBars];
  const plus = di.plusDi[index];
  const minus = di.minusDi[index];
  if (
    close == null ||
    upper == null ||
    lower == null ||
    mid == null ||
    midThen == null ||
    plus == null ||
    minus == null
  ) {
    return false;
  }
  const beyond = side === "long" ? close > upper : close < lower;
  const slope = side === "long" ? mid > midThen : mid < midThen;
  if (!beyond || !slope) return false;
  if (hitCount(strategy, closes, bands, index, side) < strategy.walkHits) return false;
  return diConfirms(side, plus, minus, strategy.diRatio);
}

function hitCount(
  strategy: BandWalkerParams,
  closes: number[],
  bands: BandSeries,
  end: number,
  side: "long" | "short",
): number {
  const start = end - strategy.walkWindow + 1;
  if (start < 0) return 0;
  let hits = 0;
  for (let j = start; j <= end; j++) {
    const upper = bands.upper[j];
    const lower = bands.lower[j];
    const close = closes[j];
    if (upper == null || lower == null || close == null) continue;
    const b = percentB(close, upper, lower);
    if (b == null) continue;
    const hit = side === "long" ? b >= strategy.percentBMin : b <= 1 - strategy.percentBMin;
    if (hit) hits += 1;
  }
  return hits;
}

function walkHoldReason(
  strategy: BandWalkerParams,
  closes: number[],
  bands: BandSeries,
  di: DiSeries,
  index: number,
  side: "long" | "short",
  qualifies: boolean,
  previous: boolean,
): string {
  const head = side === "long" ? "Upper walk" : "Lower walk";
  const close = closes[index]!;
  const upper = bands.upper[index]!;
  const lower = bands.lower[index]!;
  const mid = bands.mid[index]!;
  const midThen = bands.mid[index - strategy.slopeBars];
  const plus = di.plusDi[index];
  const minus = di.minusDi[index];
  const band = side === "long" ? upper : lower;
  const hits = hitCount(strategy, closes, bands, index, side);
  const floor = side === "long" ? strategy.percentBMin : 1 - strategy.percentBMin;

  if (midThen == null) {
    return `${head} ignored: middle band is not warm`;
  }
  const slopeOk = side === "long" ? mid > midThen : mid < midThen;
  if (!slopeOk) {
    const rel = side === "long" ? "<=" : ">=";
    return `${head} ignored: mid ${fmt(mid)} ${rel} mid ${strategy.slopeBars} bars ago ${fmt(midThen)}`;
  }
  if (hits < strategy.walkHits) {
    return (
      `${head} ignored: ${hits}/${strategy.walkWindow} closes with %B ` +
      `${side === "long" ? ">=" : "<="} ${floor} (close ${fmt(close)} vs ${fmt(band)})`
    );
  }
  if (plus == null || minus == null) {
    return `${head} ignored: DI not warm`;
  }
  if (!diConfirms(side, plus, minus, strategy.diRatio)) {
    if (side === "long") {
      return `${head} ignored: +DI ${fmt(plus)} <= ${strategy.diRatio}× -DI ${fmt(minus)}`;
    }
    return `${head} ignored: -DI ${fmt(minus)} <= ${strategy.diRatio}× +DI ${fmt(plus)}`;
  }
  if (qualifies && previous) {
    return `${head} ignored: previous bar already qualified`;
  }
  const diNote =
    side === "long"
      ? `+DI ${fmt(plus)} > ${strategy.diRatio}× -DI ${fmt(minus)}`
      : `-DI ${fmt(minus)} > ${strategy.diRatio}× +DI ${fmt(plus)}`;
  const where =
    side === "long"
      ? `close ${fmt(close)} > upper ${fmt(upper)}`
      : `close ${fmt(close)} < lower ${fmt(lower)}`;
  return `${head} (${where}); mid ${side === "long" ? "rising" : "falling"}; ${hits}/${strategy.walkWindow} %B; ${diNote}`;
}

function windowExtreme(
  candles: Candle[],
  end: number,
  window: number,
  side: "long" | "short",
): number | null {
  const start = end - window + 1;
  if (start < 0 || window < 1) return null;
  let extreme = side === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let j = start; j <= end; j++) {
    const candle = candles[j];
    if (candle == null) return null;
    extreme = side === "long" ? Math.min(extreme, candle.low) : Math.max(extreme, candle.high);
  }
  return Number.isFinite(extreme) ? extreme : null;
}

/** Best high (long) or low (short) of closed bars that finished after the fill. Seeds at the fill. */
function closedExtreme(
  side: "long" | "short",
  entryPrice: number,
  openedAt: Date,
  candles: Candle[],
  timeframe: Timeframe,
): number {
  let extreme = entryPrice;
  const intervalSec = candleIntervalSeconds(timeframe);
  const openedSec = openedAt.getTime() / 1000;
  for (const candle of candles) {
    if (intervalSec > 0 && candle.time + intervalSec <= openedSec) continue;
    extreme = side === "long" ? Math.max(extreme, candle.high) : Math.min(extreme, candle.low);
  }
  return extreme;
}

function fmt(n: number): string {
  return n.toFixed(4);
}

/** Search minutes become a candle label. Other axis keys copy onto the params. */
function paramsFromSearch(values: Readonly<Record<string, number>>): Partial<BandWalkerParams> {
  const patch: Partial<BandWalkerParams> = {};
  const timeframe = values["timeframe"];
  const period = values["period"];
  const stdDev = values["stdDev"];
  const atrPeriod = values["atrPeriod"];
  const adxPeriod = values["adxPeriod"];
  const diRatio = values["diRatio"];
  const slopeBars = values["slopeBars"];
  const walkWindow = values["walkWindow"];
  const walkHits = values["walkHits"];
  const percentBMin = values["percentBMin"];
  const stopAtr = values["stopAtr"];
  const trailArmAtr = values["trailArmAtr"];
  const trailAtr = values["trailAtr"];
  if (timeframe !== undefined) {
    const label = timeframeFromMinutes(timeframe);
    if (label === undefined) throw new Error(`No timeframe for ${timeframe} minutes`);
    patch.timeframe = label;
  }
  if (period !== undefined) patch.period = period;
  if (stdDev !== undefined) patch.stdDev = stdDev;
  if (atrPeriod !== undefined) patch.atrPeriod = atrPeriod;
  if (adxPeriod !== undefined) patch.adxPeriod = adxPeriod;
  if (diRatio !== undefined) patch.diRatio = diRatio;
  if (slopeBars !== undefined) patch.slopeBars = slopeBars;
  if (walkWindow !== undefined) patch.walkWindow = walkWindow;
  if (walkHits !== undefined) patch.walkHits = walkHits;
  if (percentBMin !== undefined) patch.percentBMin = percentBMin;
  if (stopAtr !== undefined) patch.stopAtr = stopAtr;
  if (trailArmAtr !== undefined) patch.trailArmAtr = trailArmAtr;
  if (trailAtr !== undefined) patch.trailAtr = trailAtr;
  return patch;
}

function searchDefaults(params: BandWalkerParams): Record<string, number> {
  const source: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "number") source[key] = value;
  }
  source["timeframe"] = candleIntervalSeconds(params.timeframe) / 60;
  return source;
}

export const strategyModule: StrategyModule = {
  id: "band-walker",
  defaults: () => bandWalkerParamsFor(),
  create(patch) {
    return new BandWalkerStrategy(applySearchPatch(bandWalkerParamsFor(), patch));
  },
};
