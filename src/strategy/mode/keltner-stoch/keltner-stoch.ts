import { liquidityTierForPair, TIER_COSTS } from "../../../exchange/emulated/emulated-quote.js";
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
import { atr, dmi, keltner, stochastic } from "../../indicators.js";
import { buildKeltnerStochSvg } from "./svg.js";

export interface KeltnerStochParams {
  timeframe: Timeframe;
  /** EMA / channel lookback. The channel ATR uses the same length. */
  period: number;
  /** Channel width in Wilder ATRs around the EMA. */
  atrMult: number;
  /** Wilder ATR period for the stop. The stop sits this many ATRs beyond the signal bar. */
  atrPeriod: number;
  /**
   * New entries only while ATR is above its SMA of this many bars.
   * 0 disables. Exits ignore it.
   */
  atrSmaPeriod: number;
  /** Wilder ADX period. */
  adxPeriod: number;
  /**
   * New entries only while ADX is below this. 0 disables. Exits ignore it.
   */
  adxMax: number;
  /**
   * Ignore a candle that traded through the channel when its high-low exceeds
   * this many ATRs. 0 disables.
   */
  maxBreakAtr: number;
  /**
   * Minimum fee-adjusted reward per unit of fee-adjusted stop risk.
   * 0 still requires reward > 0.
   */
  minRewardRisk: number;
  /** Stop distance beyond the entry-bar extreme, in ATRs. */
  stopAtr: number;
  /**
   * Bars of `timeframe` over which an open fade's exit slides from the
   * profitable price to the fee breakeven. At that horizon the position closes
   * at the quote. 0 disables. Missing `openedAt` leaves the current gate and
   * does not flatten.
   */
  decayBars: number;
  /** Stochastic %K lookback. */
  kPeriod: number;
  /** SMA length applied to raw %K. */
  kSmooth: number;
  /** SMA length of %K that produces %D. The entry gate uses %K. */
  dPeriod: number;
  /** Long only when %K is at or below this. */
  stochThreshold: number;
  /**
   * At the mid exit, sell half only while %K is still below this level.
   * At or above it, the position closes in full.
   */
  stochMid: number;
}

/** 5m mean-reversion: a closed bar through a Keltner channel while %K is extreme. */
export function keltnerStochParamsFor(): KeltnerStochParams {
  return {
    timeframe: "5m",
    period: 20,
    atrMult: 2.0,
    atrPeriod: 14,
    atrSmaPeriod: 50,
    adxPeriod: 14,
    adxMax: 20,
    maxBreakAtr: 4,
    minRewardRisk: 0.5,
    stopAtr: 2.5,
    decayBars: 12,
    kPeriod: 9,
    kSmooth: 3,
    dPeriod: 3,
    stochThreshold: 15,
    stochMid: 40,
  };
}

/**
 * Decision knobs for `pnpm tune`. Signal timeframe stays at 5m. `adxPeriod`,
 * `atrPeriod`, `atrSmaPeriod`, `adxMax`, `maxBreakAtr`, `kSmooth`, and
 * `dPeriod` stay on the defaults.
 */
export const KELTNER_STOCH_SEARCH_SPACE: SearchSpace = {
  axes: [
    { key: "period", levels: [14, 20, 28] },
    { key: "atrMult", levels: [1.5, 2, 2.5] },
    { key: "kPeriod", levels: [9, 14, 21] },
    { key: "stochThreshold", levels: [10, 15, 20] },
    { key: "stochMid", levels: [30, 40, 50] },
    { key: "stopAtr", levels: [2, 2.5, 3] },
    { key: "minRewardRisk", levels: [0.5, 0.75, 1] },
    { key: "decayBars", levels: [6, 12, 24] },
  ],
};

export interface KeltnerStochInput {
  pair: string;
  candles: Candle[];
  strategy: KeltnerStochParams;
  /** Spot price used in the signal (usually the exchange quote). */
  price: number;
  at?: Date;
  /** Open fill. Required for the mid exit. */
  entryPrice?: number;
  /** Which side `entryPrice` belongs to. A short is ignored. */
  positionSide?: "long" | "short";
  /** When the open position was filled. Decay counts from here. */
  openedAt?: Date;
  /**
   * Stored hard stop. A stop on the profitable side of the entry means the
   * first half is already closed and this evaluation manages the remainder.
   */
  slPrice?: number;
}

const REWARD_RISK_EPSILON = 1e-9;

/** How long a just-closed signal bar may still open a position. */
const ENTRY_WINDOW_SECONDS = 60;

/**
 * Long-only mean-reversion on a Keltner channel exit confirmed by a stochastic
 * extreme. BUY when a closed bar trades at or through the lower channel, the
 * close and the quote are still below the mid, and %K ≤ `stochThreshold`.
 * A candle wider than `maxBreakAtr` × ATR is ignored. ADX ≥ `adxMax` waits
 * for a range (`adxMax` 0 leaves that gate off). A new entry also needs ATR
 * above its `atrSmaPeriod` average (`atrSmaPeriod` 0 leaves that gate off).
 * None of these gates block an exit.
 * A new entry is taken only in the first minute after that closed bar. The
 * same bar stays true for the rest of the timeframe, and a stop would otherwise
 * reopen it on every later quote.
 * An open long sells half at the profitable price (mid, after the exit-leg fee)
 * only while %K is still below `stochMid`, and the whole position once %K has
 * reached it. The half that remains has its stop at fee breakeven and sells at
 * the upper channel, at that stop, or at the quote once `decayBars` elapses.
 * `decayBars` slides the first target toward breakeven and flattens whatever
 * size is left at the horizon.
 */
export function evaluateKeltnerStoch(input: KeltnerStochInput): Signal {
  const at = input.at ?? new Date();
  const signalCandles = closedSignalCandles(input.candles, at);
  const stoch = stochastic(
    signalCandles,
    input.strategy.kPeriod,
    input.strategy.kSmooth,
    input.strategy.dPeriod,
  );
  const i = signalCandles.length - 1;
  const stochK = stoch.k[i] ?? null;
  const stochD = stoch.d[i] ?? null;

  const { pair, candles, strategy, price } = input;
  const forming = candles[candles.length - 1];
  const lastIsClosed = forming?.isClosed(at.getTime() / 1000) === true;

  const bands = keltner(signalCandles, strategy.period, strategy.atrMult);
  const atrSeries = atr(signalCandles, strategy.atrPeriod);
  const dmiNow = dmi(signalCandles, strategy.adxPeriod);

  const kcMid = bands.mid[i];
  const kcUpper = bands.upper[i];
  const kcLower = bands.lower[i];
  const atrNow = atrSeries[i];
  const atrSma = smaAt(atrSeries, i, strategy.atrSmaPeriod);
  const adxNow = dmiNow.adx[i];
  const plusDi = dmiNow.plusDi[i];
  const minusDi = dmiNow.minusDi[i];
  const lastBar = signalCandles[i];

  const meta: NonNullable<Signal["meta"]> = {};
  if (kcMid != null) meta.kcMid = kcMid;
  if (kcUpper != null) meta.kcUpper = kcUpper;
  if (kcLower != null) meta.kcLower = kcLower;
  if (atrNow != null) meta.atr = atrNow;
  if (adxNow != null) meta.adx = adxNow;
  if (plusDi != null) meta.plusDi = plusDi;
  if (minusDi != null) meta.minusDi = minusDi;
  if (stochK != null) meta.stochK = stochK;
  if (stochD != null) meta.stochD = stochD;
  const rangeBar = forming ?? lastBar;
  if (rangeBar != null) {
    meta.barLow = rangeBar.low;
    meta.barHigh = rangeBar.high;
  }

  const base = {
    pair,
    strategyId: "keltner-stoch",
    price,
    at,
    meta,
    tpPrices: [] as number[],
    minRewardRisk: strategy.minRewardRisk,
  };

  if (
    kcMid == null ||
    kcUpper == null ||
    kcLower == null ||
    adxNow == null ||
    stochK == null ||
    lastBar == null
  ) {
    return { ...base, side: "HOLD", reason: "Indicators not warm yet (need more candles)" };
  }

  const entry = input.entryPrice;
  const openSide = input.positionSide;
  if (openSide === "short") {
    return { ...base, side: "HOLD", reason: "Short positions are not traded" };
  }
  if (entry != null && entry > 0) {
    return longExit(
      base,
      pair,
      price,
      entry,
      kcMid,
      kcUpper,
      strategy,
      at,
      input.openedAt,
      input.slPrice,
      stochK,
    );
  }

  const close = lastBar.close;
  let side: SignalSide = "HOLD";
  let reason = lastIsClosed
    ? `No KC+Stoch signal (close=${fmt(close)}, lower=${fmt(kcLower)}, mid=${fmt(kcMid)}, upper=${fmt(kcUpper)}, %K=${fmt(stochK)})`
    : `No KC+Stoch signal (waiting for a closed bar; close=${fmt(close)}, lower=${fmt(kcLower)}, mid=${fmt(kcMid)}, %K=${fmt(stochK)})`;

  const belowMid = Math.max(close, price) < kcMid;
  const beyondLower = lastBar.low <= kcLower;
  const atrHold = atrExpansionHold(atrNow, atrSma, strategy.atrSmaPeriod);

  if (belowMid && beyondLower) {
    const breakoutHold = breakoutRangeHold(lastBar, atrNow, strategy.maxBreakAtr);
    if (stochK > strategy.stochThreshold) {
      reason = `Lower channel exit ignored: Stoch %K ${fmt(stochK)} > ${strategy.stochThreshold}`;
    } else if (breakoutHold != null) {
      reason = breakoutHold;
    } else if (adxBlocksEntry(adxNow, strategy.adxMax)) {
      reason = `Lower channel exit ignored: ADX ${fmt(adxNow)} >= ${strategy.adxMax}, waiting for a range`;
    } else if (atrHold != null) {
      reason = atrHold;
    } else {
      side = "BUY";
      reason =
        `Lower KC exit (low ${fmt(lastBar.low)} ≤ ${fmt(kcLower)}, close ${fmt(close)}); ` +
        `Stoch %K ${fmt(stochK)} ≤ ${strategy.stochThreshold}`;
    }
  }

  if (side === "BUY") {
    const stale = staleSignalBar(lastBar, at);
    if (stale != null) return { ...base, side: "HOLD", reason: stale };
  }
  if (side !== "BUY" || atrNow == null || !(atrNow > 0)) {
    return { ...base, side, reason };
  }
  const slPrice = stopPrice(lastBar.low, atrNow, strategy.stopAtr);
  const tpPrices = tpPricesFor(price, kcMid);
  const reward = netReward(pair, price, tpPrices[0]);
  const risk = netRisk(pair, price, slPrice);
  const rewardHold = openingRewardHoldReason({
    price,
    sl: slPrice,
    tp: tpPrices[0],
    reward,
    risk,
    minRewardRisk: strategy.minRewardRisk,
  });
  if (rewardHold != null) return { ...base, side: "HOLD", reason: rewardHold };
  return {
    ...base,
    side,
    reason: `${reason}; risk=${fmt(risk)} reward=${fmt(reward ?? 0)}`,
    slPrice,
    tpPrices,
  };
}

/** Keltner channel exit confirmed by a stochastic %K extreme. */
export class KeltnerStochStrategy implements Strategy {
  readonly axes = KELTNER_STOCH_SEARCH_SPACE.axes;
  private readonly params: KeltnerStochParams;

  constructor(params?: KeltnerStochParams) {
    this.params = params ?? keltnerStochParamsFor();
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
    const {
      timeframe,
      period,
      atrMult,
      kPeriod,
      kSmooth,
      dPeriod,
      stochThreshold,
      stochMid,
      adxMax,
      decayBars,
      atrSmaPeriod,
    } = this.params;
    const adx = adxMax > 0 ? ` ADX<${adxMax}` : "";
    const atrGate = atrSmaPeriod > 0 ? ` ATR>SMA${atrSmaPeriod}` : "";
    const decay = decayBars > 0 ? ` decay${decayBars}` : "";
    return `keltner-stoch (${timeframe} KC${period}×${atrMult} Stoch${kPeriod},${kSmooth},${dPeriod} ≤${stochThreshold}↔${stochMid}${adx}${atrGate}${decay})`;
  }

  getId(): string {
    return "keltner-stoch";
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, period, atrPeriod, atrSmaPeriod, adxPeriod, kPeriod, kSmooth, dPeriod } =
      this.params;
    const stochWarm = kPeriod + kSmooth + dPeriod - 2;
    const atrWarm = atrSmaPeriod > 0 ? atrPeriod + atrSmaPeriod : atrPeriod;
    const warm = Math.max(period + 1, atrWarm, adxPeriod * 2, stochWarm) + 5;
    return { timeframe, count: Math.max(warm, 160) };
  }

  evaluateSignal(
    pair: string,
    candles: Candle[],
    price: number,
    at: Date,
    portfolio?: PortfolioSnapshot,
    _perpsFees?: PerpsFees,
  ): Signal {
    const position = portfolio?.position;
    const positioned =
      (position?.side === "long" || position?.side === "short") && position.entryPrice > 0
        ? position
        : undefined;
    return evaluateKeltnerStoch({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
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
    return buildKeltnerStochSvg({ pair, candles, strategy: this.params });
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
  kcMid: number,
  kcUpper: number,
  strategy: KeltnerStochParams,
  at: Date,
  openedAt: Date | undefined,
  slPrice: number | undefined,
  stochK: number,
): Signal {
  const exitFee = legFeePct(pair);
  const minExit = exitFee < 1 ? entry / (1 - exitFee) : entry;
  const clock = {
    decayBars: strategy.decayBars,
    at,
    timeframe: strategy.timeframe,
    ...(openedAt !== undefined ? { openedAt } : {}),
  };
  if (stopIsRunner(entry, slPrice)) {
    // The forming bar still contains the wick from before the half exit.
    // Quote marks keep that wick from stopping the remainder at breakeven.
    base.meta.barLow = price;
    base.meta.barHigh = price;
    const decay = decayTarget({ strict: minExit, floor: minExit, ...clock });
    if (decay.flatten) {
      return { ...base, side: "SELL", reason: timeDecayReason(decay, entry, kcMid, stochK) };
    }
    if (price <= minExit) {
      return {
        ...base,
        side: "SELL",
        reason: exitReason(
          `Price ${fmt(price)} ≤ breakeven ${fmt(minExit)}; closing remainder (entry=${fmt(entry)})`,
          stochK,
        ),
      };
    }
    if (price >= kcUpper && kcUpper > minExit) {
      return {
        ...base,
        side: "SELL",
        reason: exitReason(
          `Price ${fmt(price)} ≥ upper channel ${fmt(kcUpper)}; closing remainder (entry=${fmt(entry)})`,
          stochK,
        ),
      };
    }
    return {
      ...base,
      side: "HOLD",
      reason: `Waiting for upper channel ${fmt(kcUpper)} or breakeven ${fmt(minExit)} (entry=${fmt(entry)})`,
    };
  }
  const decay = decayTarget({
    strict: Math.max(kcMid, minExit),
    floor: minExit,
    ...clock,
  });
  if (decay.flatten) {
    return { ...base, side: "SELL", reason: timeDecayReason(decay, entry, kcMid, stochK) };
  }
  if (price >= decay.target) {
    if (decay.target > minExit && stochK < strategy.stochMid) {
      return {
        ...base,
        side: "SELL",
        closeFraction: SCALE_OUT_FRACTION,
        slPrice: minExit,
        reason:
          `Price ${fmt(price)} > profitable price ${fmt(decay.target)}; closing half, ` +
          `stop remainder at ${fmt(minExit)} (entry=${fmt(entry)}, mid=${fmt(kcMid)}, %K=${fmt(stochK)}, spotFee=${pct(exitFee)})`,
      };
    }
    return {
      ...base,
      side: "SELL",
      reason:
        `Price ${fmt(price)} > profitable price ${fmt(decay.target)}; closing the position ` +
        `(entry=${fmt(entry)}, minExit=${fmt(minExit)}, %K=${fmt(stochK)}, spotFee=${pct(exitFee)})`,
    };
  }
  return {
    ...base,
    side: "HOLD",
    reason: `Waiting for profitable price at ${fmt(decay.target)}, mid=${fmt(kcMid)}, entry=${fmt(entry)}, minExit=${fmt(minExit)}, spotFee=${pct(exitFee)}`,
  };
}

/** True once the stored stop has been moved to the profitable side of the entry. */
function stopIsRunner(entry: number, slPrice: number | undefined): boolean {
  if (slPrice == null || !(slPrice > 0) || !(entry > 0)) return false;
  return slPrice >= entry;
}

function stopPrice(barExtreme: number, atrValue: number, stopAtr: number): number {
  return barExtreme - stopAtr * atrValue;
}

function tpPricesFor(price: number, kcMid: number): number[] {
  if (!(price > 0) || !(kcMid > price)) return [];
  return [kcMid];
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

function legFeePct(pair: string): number {
  const costs = TIER_COSTS[liquidityTierForPair(pair)];
  return costs.slippage + costs.poolFee;
}

function netReward(pair: string, price: number, tp: number | undefined): number | null {
  if (!(price > 0) || tp == null || !(tp > 0)) return null;
  const fee = legFeePct(pair);
  return tp * (1 - fee) - price * (1 + fee);
}

/** Loss per unit if the long buys and the stop sells through the same spot costs. */
function netRisk(pair: string, price: number, sl: number): number {
  const fee = legFeePct(pair);
  return price * (1 + fee) - sl * (1 - fee);
}

function exitReason(reason: string, stochK: number): string {
  return `${reason} (%K=${fmt(stochK)})`;
}

function timeDecayReason(decay: DecayTarget, entry: number, mid: number, stochK: number): string {
  return exitReason(
    `Time decay: ${decay.barsHeld} bars, target ${fmt(decay.target)}, floor ${fmt(decay.floor)} ` +
      `(entry=${fmt(entry)}, mid=${fmt(mid)})`,
    stochK,
  );
}

/**
 * A closed bar stays a valid break for the whole next bar. Allow the entry
 * only while that close is still in its first minute, so a stop cannot reopen
 * the same bar on the next quote.
 */
function staleSignalBar(bar: Candle, at: Date): string | null {
  const age = at.getTime() / 1000 - (bar.time + bar.intervalSeconds);
  if (age >= 0 && age < ENTRY_WINDOW_SECONDS) return null;
  return `Signal bar is ${Math.floor(age)}s old; one entry per closed bar`;
}

function closedSignalCandles(candles: Candle[], at: Date): Candle[] {
  const forming = candles[candles.length - 1];
  if (forming == null || forming.isClosed(at.getTime() / 1000)) return candles;
  return candles.slice(0, -1);
}

/** SMA of a series that is null until it warms. Null when any bar in the window is missing. */
function smaAt(values: readonly (number | null)[], index: number, period: number): number | null {
  if (!(period > 0) || index < period - 1) return null;
  let sum = 0;
  for (let j = index - period + 1; j <= index; j++) {
    const value = values[j];
    if (value == null || !Number.isFinite(value)) return null;
    sum += value;
  }
  return sum / period;
}

function atrExpansionHold(
  atrNow: number | null | undefined,
  atrSma: number | null,
  atrSmaPeriod: number,
): string | null {
  if (!(atrSmaPeriod > 0)) return null;
  const head = "Lower channel exit ignored";
  if (atrNow == null || !(atrNow > 0) || atrSma == null) return `${head}: ATR average not warm`;
  if (!(atrNow > atrSma)) {
    return `${head}: ATR ${fmt(atrNow)} ≤ SMA${atrSmaPeriod} ${fmt(atrSma)}`;
  }
  return null;
}

function adxBlocksEntry(adx: number, adxMax: number): boolean {
  if (!(adxMax > 0)) return false;
  return adx >= adxMax;
}

function breakoutRangeHold(
  candle: Candle,
  atrValue: number | null | undefined,
  maxBreakAtr: number,
): string | null {
  if (!(maxBreakAtr > 0)) return null;
  const head = "Lower channel exit ignored";
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
  price: number;
  sl: number;
  tp: number | undefined;
  reward: number | null;
  risk: number;
  minRewardRisk: number;
}): string | null {
  const head = "Lower channel exit ignored";
  if (input.tp == null || !(input.tp > 0)) {
    return `${head}: reward <= 0 (mid is not beyond the quote)`;
  }
  if (input.reward == null || !(input.reward > 0)) {
    return (
      `${head}: reward ${fmt(input.reward ?? 0)} <= 0 after fees ` +
      `(price=${fmt(input.price)}, tp=${fmt(input.tp)})`
    );
  }
  if (!(input.risk > 0)) return `${head}: stop is at the entry price`;
  const ratio = input.reward / input.risk;
  if (ratio < input.minRewardRisk - REWARD_RISK_EPSILON) {
    return (
      `${head}: reward:risk ${ratio.toFixed(2)} < ${input.minRewardRisk} ` +
      `(reward=${fmt(input.reward)}, risk=${fmt(input.risk)}, sl=${fmt(input.sl)})`
    );
  }
  return null;
}

function paramsFromSearch(values: Readonly<Record<string, number>>): Partial<KeltnerStochParams> {
  const patch: Partial<KeltnerStochParams> = {};
  const timeframe = values["timeframe"];
  const period = values["period"];
  const atrMult = values["atrMult"];
  const atrPeriod = values["atrPeriod"];
  const adxPeriod = values["adxPeriod"];
  const adxMax = values["adxMax"];
  const maxBreakAtr = values["maxBreakAtr"];
  const minRewardRisk = values["minRewardRisk"];
  const stopAtr = values["stopAtr"];
  const decayBars = values["decayBars"];
  const kPeriod = values["kPeriod"];
  const kSmooth = values["kSmooth"];
  const dPeriod = values["dPeriod"];
  const stochThreshold = values["stochThreshold"];
  const stochMid = values["stochMid"];
  const atrSmaPeriod = values["atrSmaPeriod"];
  if (timeframe !== undefined) {
    const label = timeframeFromMinutes(timeframe);
    if (label === undefined) throw new Error(`No timeframe for ${timeframe} minutes`);
    patch.timeframe = label;
  }
  if (period !== undefined) patch.period = period;
  if (atrMult !== undefined) patch.atrMult = atrMult;
  if (atrPeriod !== undefined) patch.atrPeriod = atrPeriod;
  if (adxPeriod !== undefined) patch.adxPeriod = adxPeriod;
  if (adxMax !== undefined) patch.adxMax = adxMax;
  if (maxBreakAtr !== undefined) patch.maxBreakAtr = maxBreakAtr;
  if (minRewardRisk !== undefined) patch.minRewardRisk = minRewardRisk;
  if (stopAtr !== undefined) patch.stopAtr = stopAtr;
  if (decayBars !== undefined) patch.decayBars = decayBars;
  if (kPeriod !== undefined) patch.kPeriod = kPeriod;
  if (kSmooth !== undefined) patch.kSmooth = kSmooth;
  if (dPeriod !== undefined) patch.dPeriod = dPeriod;
  if (stochThreshold !== undefined) patch.stochThreshold = stochThreshold;
  if (stochMid !== undefined) patch.stochMid = stochMid;
  if (atrSmaPeriod !== undefined) patch.atrSmaPeriod = atrSmaPeriod;
  return patch;
}

function searchDefaults(params: KeltnerStochParams): Record<string, number> {
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
  id: "keltner-stoch",
  defaults: () => keltnerStochParamsFor(),
  create(patch) {
    return new KeltnerStochStrategy(applySearchPatch(keltnerStochParamsFor(), patch));
  },
};
