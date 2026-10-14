import { liquidityTierForPair, TIER_COSTS } from "../../exchange/emulated/emulated-quote.js";
import { shortPositionFeePct } from "../../exchange/jupiter/perps-fees.js";
import { candleIntervalSeconds, isCandleClosed } from "../../market/gecko-terminal.js";
import type {
  Candle,
  MarketIndicators,
  PerpsFees,
  PortfolioSnapshot,
  RequiredCandles,
  Signal,
  SignalSide,
  Strategy,
  Timeframe,
  Trend,
  Volatility,
} from "../../types.js";
import { atr, bollinger, dmi, rsi } from "../indicators.js";
import { buildBollingerSvg } from "./bollinger-svg.js";

export interface BollingerParams {
  timeframe: Timeframe;
  /** SMA / band lookback. */
  period: number;
  /** Band width in population standard deviations. */
  stdDev: number;
  /** Wilder ATR period (into Signal.meta for risk stops). */
  atrPeriod: number;
  /** Wilder ADX period. */
  adxPeriod: number;
  /**
   * Flat-regime cap. Above this, a long is allowed only when +DI > −DI
   * and a short only when −DI > +DI. At or below it, direction is not required.
   */
  adxMax: number;
  /**
   * Minimum (close − lower) / (mid − lower) after a reclaim.
   * Skips kisses that close only a tick back inside the band.
   */
  minReclaimDepth: number;
  /** Wilder RSI period (oversold gate on lower-band reclaim). */
  rsiPeriod: number;
  /** BUY only when RSI < this (skip weak lower-band touches). */
  rsiBuyMax: number;
  /**
   * Minimum fee-adjusted reward per unit of stop risk.
   * Mean-reversion targets sit close to the stop. 0 still requires reward > 0.
   */
  minRewardRisk: number;
  /** Stop distance beyond the entry-bar extreme, in ATRs. */
  stopAtr: number;
  /**
   * Closed bars to wait before an adverse time stop. 0 disables.
   * Mean-reversion that is still going the wrong way is scratched here,
   * before the hard stop.
   */
  timeStopBars: number;
  /** Last closed bar must be at least this many ATRs against the entry. */
  timeStopAtr: number;
}

/**
 * Hard stop beyond the signal bar. Longs sit under the bar low; shorts sit over
 * the bar high. Using the close would leave the reclaim wick already through the stop.
 */
export function bollingerStopPrice(
  side: "long" | "short",
  barExtreme: number,
  atrValue: number,
  stopAtr: number,
): number {
  const distance = stopAtr * atrValue;
  return side === "long" ? barExtreme - distance : barExtreme + distance;
}

/** Middle-band take-profit. Empty when the mid is not beyond the fill. */
export function bollingerTpPrices(side: "long" | "short", price: number, bbMid: number): number[] {
  if (!(price > 0) || !(bbMid > 0)) return [];
  const beyond = side === "long" ? bbMid > price : bbMid < price;
  return beyond ? [bbMid] : [];
}

/**
 * Float slack so a ratio that lands a few ULPs under the floor still passes.
 * Same idea as the risk manager's reward:risk gate.
 */
const REWARD_RISK_EPSILON = 1e-9;

/** Slippage + pool fee on a spot leg. Perps legs pay slippage only (no pool fee). */
function legFeePct(pair: string, venue: "spot" | "perps"): number {
  const costs = TIER_COSTS[liquidityTierForPair(pair)];
  return venue === "spot" ? costs.slippage + costs.poolFee : costs.slippage;
}

/**
 * Quote-to-target reward per 1 base unit after round-trip fees.
 * A long buys above the quote and sells below the mid (spot slippage + pool each leg).
 * A short sells below the quote and covers above the mid (perps slippage each leg)
 * and pays open + close on entry notional. Borrow starts at zero; the exit gate
 * charges it once the hold is known. Priority and volume impact depend on size,
 * which is chosen after the signal, so they are not in this ratio.
 */
export function bollingerNetReward(input: {
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

/** HOLD reason when the fee-adjusted target fails reward > 0 or reward/risk. */
function openingRewardHoldReason(input: {
  side: "long" | "short";
  price: number;
  sl: number;
  tp: number | undefined;
  pair: string;
  minRewardRisk: number;
  perpsFees?: PerpsFees;
}): string | null {
  const head = input.side === "long" ? "Lower reclaim ignored" : "Upper rejection ignored";
  if (input.tp == null || !(input.tp > 0)) {
    return `${head}: reward <= 0 (mid is not beyond the quote)`;
  }
  const reward = bollingerNetReward({
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
  if (!(risk > 0)) {
    return `${head}: stop is at the entry price`;
  }
  const ratio = reward / risk;
  if (ratio < input.minRewardRisk - REWARD_RISK_EPSILON) {
    return (
      `${head}: reward:risk ${ratio.toFixed(2)} < ${input.minRewardRisk} ` +
      `(reward=${fmt(reward)}, risk=${fmt(risk)}, sl=${fmt(input.sl)})`
    );
  }
  return null;
}

/** Signal-side params for HTF `trend` × 1h `volatility` (defaults: flat / low). */
export function bollingerParamsFor(): BollingerParams {
  return {
    timeframe: "15m",
    period: 14,
    stdDev: 1.5,
    atrPeriod: 14,
    adxPeriod: 14,
    adxMax: 40,
    minReclaimDepth: 0.1,
    rsiPeriod: 14,
    rsiBuyMax: 50,
    minRewardRisk: 0.2,
    stopAtr: 2.5,
    timeStopBars: 2,
    timeStopAtr: 1,
  };
}

export interface BollingerInput {
  pair: string;
  candles: Candle[];
  strategy: BollingerParams;
  /** Spot price used in the signal (usually exchange quote). */
  price: number;
  at?: Date;
  /** Open fill; required for mid-exit. */
  entryPrice?: number;
  /** Which side `entryPrice` belongs to. */
  positionSide?: "long" | "short";
  /** When the open short was filled. Borrow fee accrues from here. */
  openedAt?: Date;
  /**
   * Perps open/close/borrow rates from the exchange cache.
   * Missing rates block a new short and keep an open short on HOLD.
   */
  perpsFees?: PerpsFees;
  /** HTF trend. */
  trend: Trend;
  /** 1h volatility. */
  volatility: Volatility;
}

/**
 * Mean-reversion Bollinger for bullish/flat × low/squeeze.
 * BUY on a **closed** lower-band reclaim: same-bar wick (low ≤ lower, close back inside, green)
 * or prior close ≤ prior lower then close > lower, when the ADX gate passes, close < mid,
 * reclaim depth ≥ minReclaimDepth, and RSI < rsiBuyMax.
 * A forming last candle is ignored for entries (live/intra-bar); fill is the next tick after close.
 * Already long → HOLD on reclaim (no pyramid). SELL when long and price ≥ middle
 * **and** the quote is high enough that the sell fill clears the entry after the exit-leg fee.
 * Flat → HOLD on mid.
 * Already short → BUY when perps fees are present, price is at or below the mid,
 * **and** the quote is low enough to clear the open fee, close fee, hourly borrow since
 * `openedAt`, and cover slippage. Missing fees keep the short on HOLD.
 * An upper-band short is not opened without that schedule.
 * Regime / ADX / RSI do not block exits.
 * An opening signal sets `tpPrices` to the middle band, then HOLDs unless the
 * fee-adjusted reward is positive and reward/risk ≥ `minRewardRisk`.
 * After `timeStopBars` closed bars, exit when the last close is at least
 * `timeStopAtr` × ATR against the entry. Wicks do not count.
 */
export function evaluateBollinger(input: BollingerInput): Signal {
  const { pair, candles, strategy, price } = input;
  const at = input.at ?? new Date();
  const forming = candles[candles.length - 1];
  const lastIsClosed =
    forming != null && isCandleClosed(forming, at.getTime() / 1000, strategy.timeframe);
  const signalCandles = lastIsClosed || forming == null ? candles : candles.slice(0, -1);
  const closes = signalCandles.map((c) => c.close);

  const bands = bollinger(closes, strategy.period, strategy.stdDev);
  const atrSeries = atr(signalCandles, strategy.atrPeriod);
  const dmiNow = dmi(signalCandles, strategy.adxPeriod);
  const rsiSeries = rsi(closes, strategy.rsiPeriod);

  const i = closes.length - 1;
  const prev = i - 1;
  const bbMid = bands.mid[i];
  const bbUpper = bands.upper[i];
  const bbLower = bands.lower[i];
  const bbLowerPrev = prev >= 0 ? bands.lower[prev] : null;
  const bbUpperPrev = prev >= 0 ? bands.upper[prev] : null;
  const atrNow = atrSeries[i];
  const adxNow = dmiNow.adx[i];
  const plusDi = dmiNow.plusDi[i];
  const minusDi = dmiNow.minusDi[i];
  const rsiNow = rsiSeries[i];
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
    strategyId: "bollinger",
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
    bbLowerPrev == null ||
    bbUpperPrev == null ||
    adxNow == null ||
    rsiNow == null ||
    lastBar == null ||
    prev < 0
  ) {
    return {
      ...base,
      side: "HOLD",
      reason: "Indicators not warm yet (need more candles)",
    };
  }

  const close = closes[i]!;
  const closePrev = closes[prev]!;
  const entry = input.entryPrice;
  const openSide = input.positionSide;
  const long = entry != null && entry > 0 && openSide !== "short";
  const short = openSide === "short" && entry != null && entry > 0;
  let side: SignalSide = "HOLD";

  if (long) {
    const exitFee = legFeePct(pair, "spot");
    const minExit = exitFee < 1 ? entry / (1 - exitFee) : entry;
    const profitablePrice = Math.max(bbMid, minExit);
    if (price >= profitablePrice) {
      return {
        ...base,
        side: "SELL",
        reason: `Price ${fmt(price)} > profitable price ${fmt(profitablePrice)}, (entry=${fmt(entry)}, minExit=${fmt(minExit)}, spotFee=${pct(exitFee)})`,
      };
    }
    const timed = adverseTimeStopReason({
      side: "long",
      entry,
      close,
      openedAt: input.openedAt,
      at,
      timeframe: strategy.timeframe,
      atrNow,
      timeStopBars: strategy.timeStopBars,
      timeStopAtr: strategy.timeStopAtr,
    });
    if (timed != null) {
      return { ...base, side: "SELL", reason: timed };
    }
    return {
      ...base,
      side: "HOLD",
      reason: `Waiting for profitable price at ${fmt(profitablePrice)}, mid=${fmt(bbMid)}, entry=${fmt(entry)}, minExit=${fmt(minExit)}, spotFee=${pct(exitFee)}`,
    };
  }

  if (short) {
    const timed = adverseTimeStopReason({
      side: "short",
      entry,
      close,
      openedAt: input.openedAt,
      at,
      timeframe: strategy.timeframe,
      atrNow,
      timeStopBars: strategy.timeStopBars,
      timeStopAtr: strategy.timeStopAtr,
    });
    const fees = input.perpsFees;
    if (fees != null) {
      const heldMs = input.openedAt != null ? at.getTime() - input.openedAt.getTime() : 0;
      const feePct = shortPositionFeePct({
        openFeePct: fees.openFeePct,
        closeFeePct: fees.closeFeePct,
        borrowFeePctPerHour: fees.borrowFeePctPerHour,
        heldMs,
      });
      const slip = legFeePct(pair, "perps");
      const minExit = slip > -1 ? (entry * (1 - feePct)) / (1 + slip) : entry * (1 - feePct);
      const profitablePrice = Math.min(bbMid, minExit);
      if (price <= profitablePrice) {
        return {
          ...base,
          side: "BUY",
          reason: `Price ${fmt(price)} < profitable price ${fmt(profitablePrice)}, (entry=${fmt(entry)}, minExit=${fmt(minExit)}, perpsFee=${pct(feePct)})`,
        };
      }
      if (timed != null) {
        return { ...base, side: "BUY", reason: timed };
      }
      return {
        ...base,
        side: "HOLD",
        reason: `Waiting for profitable price at ${fmt(profitablePrice)}, mid=${fmt(bbMid)}, entry=${fmt(entry)}, minExit=${fmt(minExit)}, perpsFee=${pct(feePct)}`,
      };
    }
    if (timed != null) {
      return { ...base, side: "BUY", reason: timed };
    }
    return {
      ...base,
      side: "HOLD",
      reason: "Short cover held: perps fee schedule missing",
    };
  }

  const rsiShortMin = 100 - strategy.rsiBuyMax;
  const belowMid = Math.max(close, price) < bbMid;
  const aboveMid = Math.min(close, price) > bbMid;

  let reason = lastIsClosed
    ? `No BB signal (close=${fmt(close)}, lower=${fmt(bbLower)}, mid=${fmt(bbMid)}, upper=${fmt(bbUpper)}, ADX=${fmt(adxNow)}, RSI=${fmt(rsiNow)})`
    : `No BB signal (waiting for closed 15m reclaim; close=${fmt(close)}, lower=${fmt(bbLower)}, mid=${fmt(bbMid)}, ADX=${fmt(adxNow)}, RSI=${fmt(rsiNow)})`;
  const closeReclaim = closePrev <= bbLowerPrev && close > bbLower;
  const wickReclaim = lastBar.low <= bbLower && close > bbLower && close > lastBar.open;
  const reclaimedLower = closeReclaim || wickReclaim;

  if (belowMid && reclaimedLower) {
    const bandWidth = bbMid - bbLower;
    const reclaimDepth = bandWidth > 0 ? (close - bbLower) / bandWidth : 0;

    if (isAdxTrendAgainst({ adxNow, adxMax: strategy.adxMax })) {
      reason = adxTrendAgainstReason("long", adxNow, strategy.adxMax);
    } else if (reclaimDepth < strategy.minReclaimDepth) {
      reason =
        `Lower reclaim ignored: depth ${pct(reclaimDepth)} < min ${pct(strategy.minReclaimDepth)} ` +
        `(close ${fmt(close)} vs lower ${fmt(bbLower)} → mid ${fmt(bbMid)})`;
    } else if (rsiNow >= strategy.rsiBuyMax) {
      reason = `Lower reclaim ignored: RSI ${fmt(rsiNow)} >= ${strategy.rsiBuyMax} (not oversold)`;
    } else {
      side = "BUY";
      const how = wickReclaim ? "wick reclaim" : "close reclaim";
      reason =
        `Lower BB ${how} (prev ${fmt(closePrev)}, close ${fmt(close)} > ${fmt(bbLower)}); ` +
        `${adxGateNote(adxNow, strategy.adxMax)}; ` +
        `depth ${pct(reclaimDepth)}; RSI ${fmt(rsiNow)} < ${strategy.rsiBuyMax}`;
    }
  }

  if (side === "HOLD" && aboveMid) {
    const closeReject = closePrev >= bbUpperPrev && close < bbUpper;
    const wickReject = lastBar.high >= bbUpper && close < bbUpper && close < lastBar.open;
    const rejectedUpper = closeReject || wickReject;

    const fees = input.perpsFees;
    if (rejectedUpper && fees == null) {
      reason = "Upper rejection ignored: perps fee schedule missing";
    } else if (rejectedUpper && fees != null) {
      const bandWidth = bbUpper - bbMid;
      const rejectDepth = bandWidth > 0 ? (bbUpper - close) / bandWidth : 0;
      if (isAdxTrendAgainst({ adxNow, adxMax: strategy.adxMax })) {
        reason = adxTrendAgainstReason("short", adxNow, strategy.adxMax);
      } else if (rejectDepth < strategy.minReclaimDepth) {
        reason =
          `Upper rejection ignored: depth ${pct(rejectDepth)} < min ${pct(strategy.minReclaimDepth)} ` +
          `(close ${fmt(close)} vs upper ${fmt(bbUpper)} → mid ${fmt(bbMid)})`;
      } else if (rsiNow <= rsiShortMin) {
        reason = `Upper rejection ignored: RSI ${fmt(rsiNow)} <= ${fmt(rsiShortMin)} (not overbought)`;
      } else {
        side = "SELL";
        const how = wickReject ? "wick rejection" : "close rejection";
        reason =
          `Upper BB ${how} (prev ${fmt(closePrev)}, close ${fmt(close)} < ${fmt(bbUpper)}); ` +
          `${adxGateNote(adxNow, strategy.adxMax)}; ` +
          `depth ${pct(rejectDepth)}; RSI ${fmt(rsiNow)} > ${fmt(rsiShortMin)}`;
      }
    } else {
      reason =
        `Above mid, no upper rejection ` +
        `(close=${fmt(close)}, price=${fmt(price)}, mid=${fmt(bbMid)}, upper=${fmt(bbUpper)}); ` +
        `BUY needs below mid, SELL needs upper reject`;
    }
  } else if (side === "HOLD" && !belowMid) {
    reason =
      `Price straddles mid ` +
      `(close=${fmt(close)}, price=${fmt(price)}, mid=${fmt(bbMid)}); ` +
      `BUY needs both below mid, SELL needs both above mid + upper reject`;
  }

  if ((side !== "BUY" && side !== "SELL") || atrNow == null || !(atrNow > 0)) {
    return { ...base, side, reason };
  }
  const extreme = side === "BUY" ? lastBar.low : lastBar.high;
  const positionSide = side === "BUY" ? "long" : "short";
  const slPrice = bollingerStopPrice(positionSide, extreme, atrNow, strategy.stopAtr);
  const tpPrices = bollingerTpPrices(positionSide, price, bbMid);
  const rewardHold = openingRewardHoldReason({
    side: positionSide,
    price,
    sl: slPrice,
    tp: tpPrices[0],
    pair,
    minRewardRisk: strategy.minRewardRisk,
    ...(input.perpsFees !== undefined ? { perpsFees: input.perpsFees } : {}),
  });
  if (rewardHold != null) {
    return { ...base, side: "HOLD", reason: rewardHold };
  }
  return {
    ...base,
    side,
    reason,
    slPrice,
    tpPrices,
  };
}

/** 15m mean-reversion: closed-bar BB wick/close reclaim + RSI; HOLD in bear or 1h high vol; exit at mid or on an adverse time stop. */
export class BollingerStrategy implements Strategy {
  private readonly params: BollingerParams;

  constructor(_trend: Trend = "flat", _volatility: Volatility = "low") {
    this.params = bollingerParamsFor();
  }

  getDisplayName(): string {
    const { timeframe, period, stdDev, adxMax, rsiBuyMax, timeStopBars } = this.params;
    const stop = timeStopBars > 0 ? ` tStop${timeStopBars}` : "";
    return `bollinger (${timeframe} BB${period}×${stdDev} ADX${adxMax} RSI${rsiBuyMax}${stop})`;
  }

  getId(): string {
    return "bollinger";
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, period, atrPeriod, adxPeriod, rsiPeriod } = this.params;
    const warm = Math.max(period, atrPeriod, adxPeriod * 2, rsiPeriod) + 5;
    return {
      timeframe,
      count: Math.max(warm, 160),
    };
  }

  evaluateSignal(
    pair: string,
    candles: Candle[],
    market: MarketIndicators,
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
    return evaluateBollinger({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
      trend: market.trend,
      volatility: market.volatility,
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

/**
 * High ADX blocks a mean-reversion entry. ADX at or below `adxMax` does not block.
 * +DI/−DI are not part of this gate.
 */
export function isAdxTrendAgainst(input: { adxNow: number; adxMax: number }): boolean {
  return input.adxNow > input.adxMax;
}

function adxTrendAgainstReason(side: "long" | "short", adxNow: number, adxMax: number): string {
  const head = side === "long" ? "Lower reclaim ignored" : "Upper rejection ignored";
  return `${head}: ADX ${fmt(adxNow)} > ${adxMax}`;
}

function adxGateNote(adxNow: number, adxMax: number): string {
  return `ADX ${fmt(adxNow)} <= ${adxMax}`;
}

/**
 * Failed mean-reversion: after `timeStopBars`, the last **close** is at least
 * `timeStopAtr` × ATR against the entry. The forming bar's wick does not count.
 */
function adverseTimeStopReason(input: {
  side: "long" | "short";
  entry: number;
  close: number;
  openedAt: Date | undefined;
  at: Date;
  timeframe: Timeframe;
  atrNow: number | null | undefined;
  timeStopBars: number;
  timeStopAtr: number;
}): string | null {
  if (
    input.timeStopBars <= 0 ||
    !(input.timeStopAtr > 0) ||
    input.openedAt == null ||
    input.atrNow == null ||
    !(input.atrNow > 0) ||
    !(input.entry > 0)
  ) {
    return null;
  }

  const intervalSec = candleIntervalSeconds(input.timeframe);
  if (intervalSec <= 0) {
    return null;
  }

  const elapsedSec = Math.max(0, (input.at.getTime() - input.openedAt.getTime()) / 1000);
  const barsHeld = Math.floor(elapsedSec / intervalSec);
  if (barsHeld < input.timeStopBars) {
    return null;
  }

  const adverse = input.side === "long" ? input.entry - input.close : input.close - input.entry;
  const minAdverse = input.timeStopAtr * input.atrNow;
  if (!(adverse >= minAdverse)) {
    return null;
  }

  return (
    `Time stop: close ${fmt(input.close)} is ${fmt(adverse)} against entry ${fmt(input.entry)} ` +
    `after ${input.timeStopBars} bars (>= ${fmt(minAdverse)} = ${input.timeStopAtr}×ATR)`
  );
}

function fmt(n: number): string {
  return n.toFixed(4);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}
