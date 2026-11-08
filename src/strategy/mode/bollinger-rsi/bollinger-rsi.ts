import { liquidityTierForPair, TIER_COSTS } from "../../../exchange/emulated/emulated-quote.js";
import { shortPositionFeePct } from "../../../exchange/jupiter/perps-fees.js";
import { candleIntervalSeconds, timeframeFromMinutes } from "../../../market/candle.js";
import { applySearchPatch } from "../../../types.js";
import type {
  Candle,
  MarketIndicators,
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
  Trend,
  Volatility,
} from "../../../types.js";
import { atr, bollinger, dmi, rsi } from "../../indicators.js";
import { buildBollingerSvg } from "../bollinger/index.js";

export interface BollingerRsiParams {
  timeframe: Timeframe;
  /** SMA / band lookback. */
  period: number;
  /** Band width in population standard deviations. */
  stdDev: number;
  /** Wilder ATR period. The stop sits this many ATRs beyond the signal bar. */
  atrPeriod: number;
  /** Wilder ADX period. */
  adxPeriod: number;
  /**
   * New entries only while ADX is below this. 0 disables. Exits ignore it.
   */
  adxMax: number;
  /**
   * Ignore a candle that traded through the band when its high-low exceeds
   * this many ATRs. 0 disables.
   */
  maxBreakAtr: number;
  /**
   * Minimum fee-adjusted reward per unit of stop risk.
   * 0 still requires reward > 0.
   */
  minRewardRisk: number;
  /** Stop distance beyond the entry-bar extreme, in ATRs. */
  stopAtr: number;
  /**
   * Bars of `timeframe` over which an open fade's exit slides from the
   * profitable price to the fee breakeven. At that horizon the position closes
   * at the quote. 0 disables. A short's breakeven ignores borrow accrued after
   * the fill. Missing `openedAt` leaves the current gate and does not flatten.
   */
  decayBars: number;
  /** Wilder RSI lookback on the signal closes. */
  rsiPeriod: number;
  /**
   * Long only when RSI is at or below this. A short uses the mirror,
   * `100 - rsiThreshold`.
   */
  rsiThreshold: number;
  /**
   * At the mid exit, sell half only while RSI is still on the entry side of
   * this level. A long at or above it, and a short at or below it, closes in full.
   */
  rsiMid: number;
}

/** 1h mean-reversion: a closed bar through a Bollinger band while RSI is extreme. */
export function bollingerRsiParamsFor(): BollingerRsiParams {
  return {
    timeframe: "1h",
    period: 20,
    stdDev: 2,
    atrPeriod: 14,
    adxPeriod: 14,
    adxMax: 20,
    maxBreakAtr: 4,
    minRewardRisk: 0.75,
    stopAtr: 2.5,
    decayBars: 12,
    rsiPeriod: 14,
    rsiThreshold: 30,
    rsiMid: 40,
  };
}

/**
 * Decision knobs for `pnpm tune`. Signal timeframe stays at 1h.
 * `adxPeriod`, `atrPeriod`, `adxMax`, `maxBreakAtr`, and `minRewardRisk` stay
 * on the defaults: prior SOL searches either pinned those gates or moved each
 * one to a different edge on every fold. A 28-bar band, 2.5σ bands, RSI
 * lengths of 20 and 28, and an RSI threshold of 20 rarely reach the trade
 * count a fold needs. A 2 ATR stop and decay of 0 or 3 bars only won on the
 * synthetic path. The short RSI gate is `100 - rsiThreshold`.
 */
export const BOLLINGER_RSI_SEARCH_SPACE: SearchSpace = {
  axes: [
    { key: "period", levels: [14, 20] },
    { key: "stdDev", levels: [1.5, 2] },
    { key: "rsiPeriod", levels: [7, 14] },
    { key: "rsiThreshold", levels: [30, 35] },
    { key: "rsiMid", levels: [40, 50, 60] },
    { key: "stopAtr", levels: [2.5, 3] },
    { key: "decayBars", levels: [6, 12] },
  ],
};

export interface BollingerRsiInput {
  pair: string;
  candles: Candle[];
  strategy: BollingerRsiParams;
  /** Spot price used in the signal (usually the exchange quote). */
  price: number;
  at?: Date;
  /** Open fill. Required for the mid exit. */
  entryPrice?: number;
  /** Which side `entryPrice` belongs to. */
  positionSide?: "long" | "short";
  /** When the open position was filled. Borrow and decay count from here. */
  openedAt?: Date;
  /**
   * Stored hard stop. A stop on the profitable side of the entry means the
   * first half is already closed and this evaluation manages the remainder.
   */
  slPrice?: number;
  /**
   * Perps open/close/borrow rates. Missing rates block a new short and keep
   * an open short on HOLD.
   */
  perpsFees?: PerpsFees;
}

const REWARD_RISK_EPSILON = 1e-9;

/** How long a just-closed signal bar may still open a position. */
const ENTRY_WINDOW_SECONDS = 60;

/**
 * Mean-reversion on a Bollinger band exit confirmed by an RSI extreme.
 * BUY when a closed bar trades at or through the lower band, the close and
 * the quote are still below the mid, and RSI ≤ `rsiThreshold`.
 * SELL when a closed bar trades at or through the upper band, the close and
 * the quote are still above the mid, and RSI ≥ `100 - rsiThreshold`. A new short
 * needs a perps fee schedule.
 * A candle wider than `maxBreakAtr` × ATR is ignored. ADX ≥ `adxMax` waits
 * for a range (`adxMax` 0 leaves that gate off). Neither gate blocks an exit.
 * A new entry is taken only in the first minute after that closed bar. The
 * same bar stays true for the rest of the hour, and a stop would otherwise
 * reopen it on every later quote.
 * An open long sells half at the profitable price (mid, after the exit-leg fee)
 * only while RSI is still below `rsiMid`, and the whole position once RSI has
 * reached it. The half that remains has its stop at fee breakeven and sells at
 * the upper band, at that stop, or at the quote once `decayBars` elapses.
 * An open short covers half at the mirror price only while RSI is still above
 * `rsiMid`. `decayBars` still slides the first target toward breakeven and
 * flattens whatever size is left at the horizon. A short's breakeven ignores
 * borrow accrued after the fill.
 */
export function evaluateBollingerRsi(input: BollingerRsiInput): Signal {
  const at = input.at ?? new Date();
  const signalCandles = closedSignalCandles(input.candles, at);
  const closes = signalCandles.map((c) => c.close);
  const rsiNow = rsi(closes, input.strategy.rsiPeriod)[closes.length - 1] ?? null;

  const { pair, candles, strategy, price } = input;
  const forming = candles[candles.length - 1];
  const lastIsClosed = forming?.isClosed(at.getTime() / 1000) === true;

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
  if (rsiNow != null) meta.rsi = rsiNow;
  const rangeBar = forming ?? lastBar;
  if (rangeBar != null) {
    meta.barLow = rangeBar.low;
    meta.barHigh = rangeBar.high;
  }

  const base = {
    pair,
    strategyId: "bollinger-rsi",
    price,
    at,
    meta,
    tpPrices: [] as number[],
    minRewardRisk: strategy.minRewardRisk,
  };

  if (
    bbMid == null ||
    bbUpper == null ||
    bbLower == null ||
    adxNow == null ||
    rsiNow == null ||
    lastBar == null
  ) {
    return { ...base, side: "HOLD", reason: "Indicators not warm yet (need more candles)" };
  }

  const entry = input.entryPrice;
  const openSide = input.positionSide;
  if (entry != null && entry > 0 && openSide !== "short") {
    return longExit(
      base,
      pair,
      price,
      entry,
      bbMid,
      bbUpper,
      strategy,
      at,
      input.openedAt,
      input.slPrice,
      rsiNow,
    );
  }
  if (openSide === "short" && entry != null && entry > 0) {
    return shortExit(
      base,
      pair,
      price,
      entry,
      bbMid,
      bbLower,
      strategy,
      at,
      input.openedAt,
      input.perpsFees,
      input.slPrice,
      rsiNow,
    );
  }

  const close = closes[i]!;
  let side: SignalSide = "HOLD";
  let reason = lastIsClosed
    ? `No BB+RSI signal (close=${fmt(close)}, lower=${fmt(bbLower)}, mid=${fmt(bbMid)}, upper=${fmt(bbUpper)}, RSI=${fmt(rsiNow)})`
    : `No BB+RSI signal (waiting for a closed bar; close=${fmt(close)}, lower=${fmt(bbLower)}, mid=${fmt(bbMid)}, RSI=${fmt(rsiNow)})`;

  const belowMid = Math.max(close, price) < bbMid;
  const aboveMid = Math.min(close, price) > bbMid;
  const beyondLower = lastBar.low <= bbLower;
  const beyondUpper = lastBar.high >= bbUpper;

  if (belowMid && beyondLower) {
    const breakoutHold = breakoutRangeHold("long", lastBar, atrNow, strategy.maxBreakAtr);
    if (rsiNow > strategy.rsiThreshold) {
      reason = `Lower band exit ignored: RSI ${fmt(rsiNow)} > ${strategy.rsiThreshold}`;
    } else if (breakoutHold != null) {
      reason = breakoutHold;
    } else if (adxBlocksEntry(adxNow, strategy.adxMax)) {
      reason = `Lower band exit ignored: ADX ${fmt(adxNow)} >= ${strategy.adxMax}, waiting for a range`;
    } else {
      side = "BUY";
      reason =
        `Lower BB exit (low ${fmt(lastBar.low)} ≤ ${fmt(bbLower)}, close ${fmt(close)}); ` +
        `RSI ${fmt(rsiNow)} ≤ ${strategy.rsiThreshold}`;
    }
  } else if (aboveMid && beyondUpper) {
    const breakoutHold = breakoutRangeHold("short", lastBar, atrNow, strategy.maxBreakAtr);
    if (input.perpsFees == null) {
      reason = "Upper band exit ignored: perps fee schedule missing";
    } else if (rsiNow < shortRsiThreshold(strategy.rsiThreshold)) {
      reason = `Upper band exit ignored: RSI ${fmt(rsiNow)} < ${shortRsiThreshold(strategy.rsiThreshold)}`;
    } else if (breakoutHold != null) {
      reason = breakoutHold;
    } else if (adxBlocksEntry(adxNow, strategy.adxMax)) {
      reason = `Upper band exit ignored: ADX ${fmt(adxNow)} >= ${strategy.adxMax}, waiting for a range`;
    } else {
      side = "SELL";
      reason =
        `Upper BB exit (high ${fmt(lastBar.high)} ≥ ${fmt(bbUpper)}, close ${fmt(close)}); ` +
        `RSI ${fmt(rsiNow)} ≥ ${shortRsiThreshold(strategy.rsiThreshold)}`;
    }
  }

  if (side === "BUY" || side === "SELL") {
    const stale = staleSignalBar(lastBar, at);
    if (stale != null) return { ...base, side: "HOLD", reason: stale };
  }
  if ((side !== "BUY" && side !== "SELL") || atrNow == null || !(atrNow > 0)) {
    return { ...base, side, reason };
  }
  const extreme = side === "BUY" ? lastBar.low : lastBar.high;
  const positionSide = side === "BUY" ? "long" : "short";
  const slPrice = stopPrice(positionSide, extreme, atrNow, strategy.stopAtr);
  const tpPrices = tpPricesFor(positionSide, price, bbMid);
  const rewardHold = openingRewardHoldReason({
    side: positionSide,
    price,
    sl: slPrice,
    tp: tpPrices[0],
    pair,
    minRewardRisk: strategy.minRewardRisk,
    ...(input.perpsFees !== undefined ? { perpsFees: input.perpsFees } : {}),
  });
  if (rewardHold != null) return { ...base, side: "HOLD", reason: rewardHold };
  return { ...base, side, reason, slPrice, tpPrices };
}

/** 1h BB band exit confirmed by an RSI extreme. */
export class BollingerRsiStrategy implements Strategy {
  readonly axes = BOLLINGER_RSI_SEARCH_SPACE.axes;
  private readonly params: BollingerRsiParams;

  constructor(
    _trend: Trend = "flat",
    _volatility: Volatility = "low",
    params?: BollingerRsiParams,
  ) {
    this.params = params ?? bollingerRsiParamsFor();
  }

  getSearchDefaults(): Readonly<Record<string, number>> {
    return searchDefaults(this.params);
  }

  paramPatch(values: Readonly<Record<string, number>>): StrategyParamPatch {
    const params = paramsFromSearch(values);
    const knobs: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === "timeframe" || value === undefined) continue;
      knobs[key] = value;
    }
    if (params.timeframe === undefined) return { values: knobs };
    return { timeframe: params.timeframe, values: knobs };
  }

  getDisplayName(): string {
    const { timeframe, period, stdDev, rsiPeriod, rsiThreshold, rsiMid, adxMax, decayBars } =
      this.params;
    const adx = adxMax > 0 ? ` ADX<${adxMax}` : "";
    const decay = decayBars > 0 ? ` decay${decayBars}` : "";
    const shortRsi = shortRsiThreshold(rsiThreshold);
    return `bollinger-rsi (${timeframe} BB${period}×${stdDev} RSI${rsiPeriod} ≤${rsiThreshold}/≥${shortRsi}↔${rsiMid}${adx}${decay})`;
  }

  getId(): string {
    return "bollinger-rsi";
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, period, atrPeriod, adxPeriod, rsiPeriod } = this.params;
    const warm = Math.max(period, atrPeriod, adxPeriod * 2, rsiPeriod + 1) + 5;
    return { timeframe, count: Math.max(warm, 160) };
  }

  evaluateSignal(
    pair: string,
    candles: Candle[],
    _market: MarketIndicators,
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
    return evaluateBollingerRsi({
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
            slPrice: positioned.slPrice,
            ...(positioned.openedAt != null ? { openedAt: positioned.openedAt } : {}),
          }
        : {}),
    });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildBollingerSvg({ pair, candles, strategy: this.params });
  }
}

interface SignalBase {
  pair: string;
  strategyId: string;
  price: number;
  at: Date;
  meta: NonNullable<Signal["meta"]>;
  tpPrices: number[];
  minRewardRisk: number;
}

const SCALE_OUT_FRACTION = 0.5;

function longExit(
  base: SignalBase,
  pair: string,
  price: number,
  entry: number,
  bbMid: number,
  bbUpper: number,
  strategy: BollingerRsiParams,
  at: Date,
  openedAt: Date | undefined,
  slPrice: number | undefined,
  rsiNow: number,
): Signal {
  const exitFee = legFeePct(pair, "spot");
  const minExit = exitFee < 1 ? entry / (1 - exitFee) : entry;
  const clock = {
    decayBars: strategy.decayBars,
    at,
    timeframe: strategy.timeframe,
    ...(openedAt !== undefined ? { openedAt } : {}),
  };
  if (stopIsRunner("long", entry, slPrice)) {
    // The forming bar still contains the wick from before the half exit.
    // Quote marks keep that wick from stopping the remainder at breakeven.
    base.meta.barLow = price;
    base.meta.barHigh = price;
    const decay = decayTarget({ strict: minExit, floor: minExit, ...clock });
    if (decay.flatten) {
      return { ...base, side: "SELL", reason: timeDecayReason(decay, entry, bbMid) };
    }
    if (price <= minExit) {
      return {
        ...base,
        side: "SELL",
        reason: `Price ${fmt(price)} ≤ breakeven ${fmt(minExit)}; closing remainder (entry=${fmt(entry)})`,
      };
    }
    if (price >= bbUpper && bbUpper > minExit) {
      return {
        ...base,
        side: "SELL",
        reason: `Price ${fmt(price)} ≥ upper band ${fmt(bbUpper)}; closing remainder (entry=${fmt(entry)})`,
      };
    }
    return {
      ...base,
      side: "HOLD",
      reason: `Waiting for upper band ${fmt(bbUpper)} or breakeven ${fmt(minExit)} (entry=${fmt(entry)})`,
    };
  }
  const decay = decayTarget({
    strict: Math.max(bbMid, minExit),
    floor: minExit,
    ...clock,
  });
  if (decay.flatten) {
    return { ...base, side: "SELL", reason: timeDecayReason(decay, entry, bbMid) };
  }
  if (price >= decay.target) {
    if (decay.target > minExit && rsiNow < strategy.rsiMid) {
      return {
        ...base,
        side: "SELL",
        closeFraction: SCALE_OUT_FRACTION,
        slPrice: minExit,
        reason:
          `Price ${fmt(price)} > profitable price ${fmt(decay.target)}; closing half, ` +
          `stop remainder at ${fmt(minExit)} (entry=${fmt(entry)}, mid=${fmt(bbMid)}, RSI=${fmt(rsiNow)}, spotFee=${pct(exitFee)})`,
      };
    }
    return {
      ...base,
      side: "SELL",
      reason:
        `Price ${fmt(price)} > profitable price ${fmt(decay.target)}; closing the position ` +
        `(entry=${fmt(entry)}, minExit=${fmt(minExit)}, RSI=${fmt(rsiNow)}, spotFee=${pct(exitFee)})`,
    };
  }
  return {
    ...base,
    side: "HOLD",
    reason: `Waiting for profitable price at ${fmt(decay.target)}, mid=${fmt(bbMid)}, entry=${fmt(entry)}, minExit=${fmt(minExit)}, spotFee=${pct(exitFee)}`,
  };
}

function shortExit(
  base: SignalBase,
  pair: string,
  price: number,
  entry: number,
  bbMid: number,
  bbLower: number,
  strategy: BollingerRsiParams,
  at: Date,
  openedAt: Date | undefined,
  perpsFees: PerpsFees | undefined,
  slPrice: number | undefined,
  rsiNow: number,
): Signal {
  if (perpsFees == null) {
    return { ...base, side: "HOLD", reason: "Short cover held: perps fee schedule missing" };
  }
  const heldMs = openedAt != null ? at.getTime() - openedAt.getTime() : 0;
  const feePct = shortPositionFeePct({ ...perpsFees, heldMs });
  const slip = legFeePct(pair, "perps");
  const minExit = shortCoverPrice(entry, feePct, slip);
  const floorFeePct = shortPositionFeePct({ ...perpsFees, heldMs: 0 });
  const floor = shortCoverPrice(entry, floorFeePct, slip);
  const clock = {
    decayBars: strategy.decayBars,
    at,
    timeframe: strategy.timeframe,
    ...(openedAt !== undefined ? { openedAt } : {}),
  };
  if (stopIsRunner("short", entry, slPrice)) {
    base.meta.barLow = price;
    base.meta.barHigh = price;
    const decay = decayTarget({ strict: floor, floor, ...clock });
    if (decay.flatten) {
      return { ...base, side: "BUY", reason: timeDecayReason(decay, entry, bbMid) };
    }
    if (price >= floor) {
      return {
        ...base,
        side: "BUY",
        reason: `Price ${fmt(price)} ≥ breakeven ${fmt(floor)}; closing remainder (entry=${fmt(entry)})`,
      };
    }
    if (price <= bbLower && bbLower < floor) {
      return {
        ...base,
        side: "BUY",
        reason: `Price ${fmt(price)} ≤ lower band ${fmt(bbLower)}; closing remainder (entry=${fmt(entry)})`,
      };
    }
    return {
      ...base,
      side: "HOLD",
      reason: `Waiting for lower band ${fmt(bbLower)} or breakeven ${fmt(floor)} (entry=${fmt(entry)})`,
    };
  }
  const decay = decayTarget({
    strict: Math.min(bbMid, minExit),
    floor,
    ...clock,
  });
  if (decay.flatten) {
    return { ...base, side: "BUY", reason: timeDecayReason(decay, entry, bbMid) };
  }
  if (price <= decay.target) {
    if (decay.target < floor && rsiNow > 100 - strategy.rsiMid) {
      return {
        ...base,
        side: "BUY",
        closeFraction: SCALE_OUT_FRACTION,
        slPrice: floor,
        reason:
          `Price ${fmt(price)} < profitable price ${fmt(decay.target)}; closing half, ` +
          `stop remainder at ${fmt(floor)} (entry=${fmt(entry)}, mid=${fmt(bbMid)}, RSI=${fmt(rsiNow)}, perpsFee=${pct(feePct)})`,
      };
    }
    return {
      ...base,
      side: "BUY",
      reason:
        `Price ${fmt(price)} < profitable price ${fmt(decay.target)}; closing the position ` +
        `(entry=${fmt(entry)}, minExit=${fmt(minExit)}, RSI=${fmt(rsiNow)}, perpsFee=${pct(feePct)})`,
    };
  }
  return {
    ...base,
    side: "HOLD",
    reason: `Waiting for profitable price at ${fmt(decay.target)}, mid=${fmt(bbMid)}, entry=${fmt(entry)}, minExit=${fmt(minExit)}, perpsFee=${pct(feePct)}`,
  };
}

/** True once the stored stop has been moved to the profitable side of the entry. */
function stopIsRunner(side: "long" | "short", entry: number, slPrice: number | undefined): boolean {
  if (slPrice == null || !(slPrice > 0) || !(entry > 0)) return false;
  return side === "long" ? slPrice >= entry : slPrice <= entry;
}

function stopPrice(
  side: "long" | "short",
  barExtreme: number,
  atrValue: number,
  stopAtr: number,
): number {
  const distance = stopAtr * atrValue;
  return side === "long" ? barExtreme - distance : barExtreme + distance;
}

function tpPricesFor(side: "long" | "short", price: number, bbMid: number): number[] {
  if (!(price > 0) || !(bbMid > 0)) return [];
  const beyond = side === "long" ? bbMid > price : bbMid < price;
  return beyond ? [bbMid] : [];
}

interface DecayTarget {
  target: number;
  floor: number;
  barsHeld: number;
  flatten: boolean;
}

function decayTarget(input: {
  strict: number;
  floor: number;
  decayBars: number;
  openedAt?: Date;
  at: Date;
  timeframe: Timeframe;
}): DecayTarget {
  const { strict, floor } = input;
  const idle: DecayTarget = { target: strict, floor, barsHeld: 0, flatten: false };
  if (!(input.decayBars > 0) || input.openedAt == null) return idle;
  const intervalSec = candleIntervalSeconds(input.timeframe);
  if (!(intervalSec > 0)) return idle;
  const elapsedSec = Math.max(0, (input.at.getTime() - input.openedAt.getTime()) / 1000);
  const barsHeld = Math.floor(elapsedSec / intervalSec);
  const t = Math.min(1, barsHeld / input.decayBars);
  return {
    target: strict + (floor - strict) * t,
    floor,
    barsHeld,
    flatten: barsHeld >= input.decayBars,
  };
}

function legFeePct(pair: string, venue: "spot" | "perps"): number {
  const costs = TIER_COSTS[liquidityTierForPair(pair)];
  return venue === "spot" ? costs.slippage + costs.poolFee : costs.slippage;
}

function netReward(input: {
  side: "long" | "short";
  price: number;
  tp: number;
  pair: string;
  perpsFees?: PerpsFees;
}): number | null {
  const { side, price, tp } = input;
  if (!(price > 0) || !(tp > 0)) return null;
  if (side === "long") {
    const fee = legFeePct(input.pair, "spot");
    return tp * (1 - fee) - price * (1 + fee);
  }
  const fees = input.perpsFees;
  if (fees == null) return null;
  const slip = legFeePct(input.pair, "perps");
  return price * (1 - slip - fees.openFeePct - fees.closeFeePct) - tp * (1 + slip);
}

function shortCoverPrice(entry: number, feePct: number, slip: number): number {
  return slip > -1 ? (entry * (1 - feePct)) / (1 + slip) : entry * (1 - feePct);
}

function timeDecayReason(decay: DecayTarget, entry: number, mid: number): string {
  return (
    `Time decay: ${decay.barsHeld} bars, target ${fmt(decay.target)}, floor ${fmt(decay.floor)} ` +
    `(entry=${fmt(entry)}, mid=${fmt(mid)})`
  );
}

/**
 * A closed bar stays a valid break for the whole next hour. Allow the entry
 * only while that close is still in its first minute, so a stop cannot reopen
 * the same bar on the next quote.
 */
function staleSignalBar(bar: Candle, at: Date): string | null {
  const age = at.getTime() / 1000 - (bar.time + bar.intervalSeconds);
  if (age >= 0 && age < ENTRY_WINDOW_SECONDS) return null;
  return `Signal bar is ${Math.floor(age)}s old; one entry per closed bar`;
}

function shortRsiThreshold(threshold: number): number {
  return 100 - threshold;
}

function closedSignalCandles(candles: Candle[], at: Date): Candle[] {
  const forming = candles[candles.length - 1];
  if (forming == null || forming.isClosed(at.getTime() / 1000)) return candles;
  return candles.slice(0, -1);
}

function adxBlocksEntry(adx: number, adxMax: number): boolean {
  if (!(adxMax > 0)) return false;
  return adx >= adxMax;
}

function breakoutRangeHold(
  side: "long" | "short",
  candle: Candle,
  atrValue: number | null | undefined,
  maxBreakAtr: number,
): string | null {
  if (!(maxBreakAtr > 0)) return null;
  const head = side === "long" ? "Lower band exit ignored" : "Upper band exit ignored";
  if (atrValue == null || !(atrValue > 0)) return `${head}: ATR not warm`;
  const range = candle.high - candle.low;
  const maxRange = maxBreakAtr * atrValue;
  if (range > maxRange) {
    return (
      `${head}: breakout range ${fmt(range)} > ${fmt(maxRange)} ` +
      `(${maxBreakAtr}×ATR ${fmt(atrValue)})`
    );
  }
  return null;
}

function openingRewardHoldReason(input: {
  side: "long" | "short";
  price: number;
  sl: number;
  tp: number | undefined;
  pair: string;
  minRewardRisk: number;
  perpsFees?: PerpsFees;
}): string | null {
  const head = input.side === "long" ? "Lower band exit ignored" : "Upper band exit ignored";
  if (input.tp == null || !(input.tp > 0)) {
    return `${head}: reward <= 0 (mid is not beyond the quote)`;
  }
  const reward = netReward({
    side: input.side,
    price: input.price,
    tp: input.tp,
    pair: input.pair,
    ...(input.perpsFees !== undefined ? { perpsFees: input.perpsFees } : {}),
  });
  if (reward == null || !(reward > 0)) {
    return (
      `${head}: reward ${fmt(reward ?? 0)} <= 0 after fees ` +
      `(price=${fmt(input.price)}, tp=${fmt(input.tp)})`
    );
  }
  const risk = Math.abs(input.price - input.sl);
  if (!(risk > 0)) return `${head}: stop is at the entry price`;
  const ratio = reward / risk;
  if (ratio < input.minRewardRisk - REWARD_RISK_EPSILON) {
    return (
      `${head}: reward:risk ${ratio.toFixed(2)} < ${input.minRewardRisk} ` +
      `(reward=${fmt(reward)}, risk=${fmt(risk)}, sl=${fmt(input.sl)})`
    );
  }
  return null;
}

function paramsFromSearch(values: Readonly<Record<string, number>>): Partial<BollingerRsiParams> {
  const patch: Partial<BollingerRsiParams> = {};
  const timeframe = values["timeframe"];
  const period = values["period"];
  const stdDev = values["stdDev"];
  const atrPeriod = values["atrPeriod"];
  const adxPeriod = values["adxPeriod"];
  const adxMax = values["adxMax"];
  const maxBreakAtr = values["maxBreakAtr"];
  const minRewardRisk = values["minRewardRisk"];
  const stopAtr = values["stopAtr"];
  const decayBars = values["decayBars"];
  const rsiPeriod = values["rsiPeriod"];
  const rsiThreshold = values["rsiThreshold"];
  const rsiMid = values["rsiMid"];
  if (timeframe !== undefined) {
    const label = timeframeFromMinutes(timeframe);
    if (label === undefined) throw new Error(`No timeframe for ${timeframe} minutes`);
    patch.timeframe = label;
  }
  if (period !== undefined) patch.period = period;
  if (stdDev !== undefined) patch.stdDev = stdDev;
  if (atrPeriod !== undefined) patch.atrPeriod = atrPeriod;
  if (adxPeriod !== undefined) patch.adxPeriod = adxPeriod;
  if (adxMax !== undefined) patch.adxMax = adxMax;
  if (maxBreakAtr !== undefined) patch.maxBreakAtr = maxBreakAtr;
  if (minRewardRisk !== undefined) patch.minRewardRisk = minRewardRisk;
  if (stopAtr !== undefined) patch.stopAtr = stopAtr;
  if (decayBars !== undefined) patch.decayBars = decayBars;
  if (rsiPeriod !== undefined) patch.rsiPeriod = rsiPeriod;
  if (rsiThreshold !== undefined) patch.rsiThreshold = rsiThreshold;
  if (rsiMid !== undefined) patch.rsiMid = rsiMid;
  return patch;
}

function searchDefaults(params: BollingerRsiParams): Record<string, number> {
  const source: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "number") source[key] = value;
  }
  source["timeframe"] = candleIntervalSeconds(params.timeframe) / 60;
  return source;
}

function fmt(n: number): string {
  return n.toFixed(4);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export const strategyModule: StrategyModule = {
  id: "bollinger-rsi",
  create(trend, volatility, patch) {
    return new BollingerRsiStrategy(
      trend,
      volatility,
      applySearchPatch(bollingerRsiParamsFor(), patch),
    );
  },
};
