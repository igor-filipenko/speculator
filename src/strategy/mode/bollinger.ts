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
import { atr, bollinger, dmi, ema, rsi } from "../indicators.js";
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
  /** BUY only when ADX <= this (flat regime gate). */
  adxMax: number;
  /**
   * Minimum (mid − lower) / close for a BUY.
   * Skips setups where mean-reversion distance cannot cover ~RT fees.
   */
  minBandToMidPct: number;
  /**
   * Minimum (close − lower) / (mid − lower) after a reclaim.
   * Skips kisses that close only a tick back inside the band.
   */
  minReclaimDepth: number;
  /**
   * Mid-exit must clear the buy fill by this fraction so a falling SMA
   * cannot book a "TP" at a loss. ATR still stops failed reversion.
   */
  minExitAboveEntryPct: number;
  /** Fast EMA for the 15m work-trend gate. */
  workTrendEmaFast: number;
  /** Slow EMA for the 15m work-trend gate. */
  workTrendEmaSlow: number;
  /**
   * ADX floor for a tradable 15m downtrend (stacked oversold reclaim).
   * Below this, close under the fast EMA with -DI > +DI is treated as drift and skipped.
   */
  workTrendAdxFlatMax: number;
  /** When false, 15m drift does not block a reclaim or an upper rejection. */
  driftFilter: boolean;
  /** Wilder RSI period (oversold gate on lower-band reclaim). */
  rsiPeriod: number;
  /** BUY only when RSI < this (skip weak lower-band touches). */
  rsiBuyMax: number;
  /** Minimum reward per unit of stop risk. Mean-reversion targets sit close to the stop. */
  minRewardRisk: number;
  /**
   * Closed bars to wait before an adverse time stop. 0 disables.
   * Mean-reversion that is still going the wrong way is scratched here,
   * before the hard stop.
   */
  timeStopBars: number;
  /** Last closed bar must be at least this many ATRs against the entry. */
  timeStopAtr: number;
}

/** High vol is no-buy; slightly tighter bands in squeeze so touches still fire. */
const STD_DEV: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 1.6, low: 1.5, squeeze: 1.4, unknown: 1.5 },
  flat: { high: 1.6, low: 1.5, squeeze: 1.4, unknown: 1.5 },
  bearish: { high: 1.6, low: 1.5, squeeze: 1.5, unknown: 1.5 },
  unknown: { high: 1.6, low: 1.5, squeeze: 1.5, unknown: 1.5 },
};

/** Looser ADX in tradable regimes so 15m dips still count as mean-reversion. */
const ADX_MAX: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 44, low: 36, squeeze: 40, unknown: 36 },
  flat: { high: 32, low: 39, squeeze: 32, unknown: 36 },
  bearish: { high: 29, low: 29, squeeze: 29, unknown: 29 },
  unknown: { high: 29, low: 29, squeeze: 29, unknown: 29 },
};

/** Skip tiny squeeze TPs; high vol is no-buy so the row is unused for entries. */
const MIN_BAND_TO_MID: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 0.004, low: 0.0025, squeeze: 0.0025, unknown: 0.003 },
  flat: { high: 0.004, low: 0.0025, squeeze: 0.003, unknown: 0.003 },
  bearish: { high: 0.004, low: 0.003, squeeze: 0.005, unknown: 0.003 },
  unknown: { high: 0.004, low: 0.003, squeeze: 0.005, unknown: 0.003 },
};

/** Fraction of band width the close must reclaim; kisses stay out. */
const MIN_RECLAIM_DEPTH: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 0.1, low: 0.1, squeeze: 0.12, unknown: 0.1 },
  flat: { high: 0.1, low: 0.1, squeeze: 0.12, unknown: 0.1 },
  bearish: { high: 0.1, low: 0.1, squeeze: 0.1, unknown: 0.1 },
  unknown: { high: 0.1, low: 0.1, squeeze: 0.1, unknown: 0.1 },
};

/** HTF already gates trend; RSI just skips momentum touches that are not oversold. */
const RSI_BUY_MAX: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 55, low: 53, squeeze: 55, unknown: 50 },
  flat: { high: 45, low: 55, squeeze: 50, unknown: 50 },
  bearish: { high: 45, low: 45, squeeze: 45, unknown: 45 },
  unknown: { high: 45, low: 45, squeeze: 45, unknown: 45 },
};

/** Stop distance beyond the entry-bar extreme, in ATRs. */
const ATR_STOP: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 3, low: 2.5, squeeze: 2.5, unknown: 2.5 },
  flat: { high: 2.5, low: 2.5, squeeze: 2.5, unknown: 2.5 },
  bearish: { high: 2, low: 2, squeeze: 2, unknown: 2 },
  unknown: { high: 2, low: 2, squeeze: 2, unknown: 2 },
};

/**
 * Hard stop beyond the signal bar. Longs sit under the bar low; shorts sit over
 * the bar high. Using the close would leave the reclaim wick already through the stop.
 */
export function bollingerStopPrice(
  side: "long" | "short",
  barExtreme: number,
  atrValue: number,
  trend: Trend = "flat",
  volatility: Volatility = "low",
): number {
  const distance = ATR_STOP[trend][volatility] * atrValue;
  return side === "long" ? barExtreme - distance : barExtreme + distance;
}

/** Middle-band take-profit. Empty when the mid is not beyond the fill. */
export function bollingerTpPrices(side: "long" | "short", price: number, bbMid: number): number[] {
  if (!(price > 0) || !(bbMid > 0)) return [];
  const beyond = side === "long" ? bbMid > price : bbMid < price;
  return beyond ? [bbMid] : [];
}

/** Signal-side params for HTF `trend` × 1h `volatility` (defaults: flat / low). */
export function bollingerParamsFor(
  trend: Trend = "flat",
  volatility: Volatility = "low",
): BollingerParams {
  return {
    timeframe: "15m",
    period: 14,
    stdDev: STD_DEV[trend][volatility],
    atrPeriod: 14,
    adxPeriod: 14,
    adxMax: ADX_MAX[trend][volatility],
    minBandToMidPct: MIN_BAND_TO_MID[trend][volatility],
    minReclaimDepth: MIN_RECLAIM_DEPTH[trend][volatility],
    minExitAboveEntryPct: 0.001,
    workTrendEmaFast: 20,
    workTrendEmaSlow: 50,
    workTrendAdxFlatMax: 20,
    driftFilter: false,
    rsiPeriod: 14,
    rsiBuyMax: RSI_BUY_MAX[trend][volatility],
    minRewardRisk: 0.1,
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
 * or prior close ≤ prior lower then close > lower, when ADX ≤ adxMax, close < mid,
 * reclaim depth ≥ minReclaimDepth, (mid − lower) / close ≥ minBandToMidPct, RSI < rsiBuyMax.
 * A forming last candle is ignored for entries (live/intra-bar); fill is the next tick after close.
 * Already long → HOLD on reclaim (no pyramid). SELL when long and close ≥ middle
 * **and** close is above the open fill after costs. Flat → HOLD on mid.
 * Already short → BUY when perps fees are present, price is at or below the mid,
 * **and** price is below entry by the open fee, close fee, and hourly borrow since `openedAt`.
 * Missing fees keep the short on HOLD. An upper-band short is not opened without that schedule,
 * and band→mid must still cover the open+close fee.
 * Regime / ADX / RSI do not block exits.
 * 15m stacked oversold (-DI > +DI, EMA fast < slow, ADX >= workTrendAdxFlatMax)
 * is allowed; other below-fast-EMA sells are drift and skipped unless `driftFilter` is false.
 * An opening signal sets `tpPrices` to the middle band.
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
  const workEmaFast = ema(closes, strategy.workTrendEmaFast);
  const workEmaSlow = ema(closes, strategy.workTrendEmaSlow);

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
  const emaFastNow = workEmaFast[i];
  const emaSlowNow = workEmaSlow[i];
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
    const minExit = entry * (1 + strategy.minExitAboveEntryPct);
    const profitablePrice = Math.max(bbMid, minExit);
    if (price >= profitablePrice) {
      return {
        ...base,
        side: "SELL",
        reason: `Price ${fmt(price)} > profitable price ${fmt(profitablePrice)}, (entry=${fmt(entry)}, minExit=${fmt(minExit)})`,
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
      reason: `Waiting for profitable price at ${fmt(profitablePrice)}, mid=${fmt(bbMid)}, entry=${fmt(entry)}, minExit=${fmt(minExit)}`,
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
      const minExit = entry * (1 - feePct);
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
  const blocked = input.volatility === "high" ? "1h volatility high" : undefined;

  if (belowMid && reclaimedLower) {
    const bandWidth = bbMid - bbLower;
    const bandToMidPct = bandWidth / close;
    const reclaimDepth = bandWidth > 0 ? (close - bbLower) / bandWidth : 0;
    const blockedLong =
      input.volatility == "squeeze" && input.trend == "bearish"
        ? "waiting for breakout down"
        : undefined;

    if (blocked != null) {
      reason = `Lower reclaim ignored: ${blocked}`;
    } else if (blockedLong) {
      reason = `Lower reclaim ignored: ${blockedLong}`;
    } else if (adxNow > strategy.adxMax) {
      reason = `Lower reclaim ignored: ADX ${fmt(adxNow)} > ${strategy.adxMax} (not flat)`;
    } else if (bandToMidPct < strategy.minBandToMidPct) {
      reason = `Lower reclaim ignored: band→mid ${pct(bandToMidPct)} < min ${pct(strategy.minBandToMidPct)}`;
    } else if (reclaimDepth < strategy.minReclaimDepth) {
      reason =
        `Lower reclaim ignored: depth ${pct(reclaimDepth)} < min ${pct(strategy.minReclaimDepth)} ` +
        `(close ${fmt(close)} vs lower ${fmt(bbLower)} → mid ${fmt(bbMid)})`;
    } else if (rsiNow >= strategy.rsiBuyMax) {
      reason = `Lower reclaim ignored: RSI ${fmt(rsiNow)} >= ${strategy.rsiBuyMax} (not oversold)`;
    } else if (
      strategy.driftFilter &&
      isWorkDriftDown({
        close,
        emaFast: emaFastNow,
        emaSlow: emaSlowNow,
        adxNow,
        plusDi,
        minusDi,
        adxFlatMax: strategy.workTrendAdxFlatMax,
      })
    ) {
      reason =
        `Lower reclaim ignored: 15m drift down ` +
        `(ADX ${fmt(adxNow)} < ${strategy.workTrendAdxFlatMax} or EMAs not stacked oversold; ` +
        `+DI ${fmt(plusDi ?? 0)} −DI ${fmt(minusDi ?? 0)})`;
    } else {
      side = "BUY";
      const how = wickReclaim ? "wick reclaim" : "close reclaim";
      reason =
        `Lower BB ${how} (prev ${fmt(closePrev)}, close ${fmt(close)} > ${fmt(bbLower)}); ` +
        `ADX ${fmt(adxNow)} <= ${strategy.adxMax}; band→mid ${pct(bandToMidPct)}; ` +
        `depth ${pct(reclaimDepth)}; RSI ${fmt(rsiNow)} < ${strategy.rsiBuyMax}`;
    }
  }

  if (side === "HOLD" && aboveMid) {
    const closeReject = closePrev >= bbUpperPrev && close < bbUpper;
    const wickReject = lastBar.high >= bbUpper && close < bbUpper && close < lastBar.open;
    const rejectedUpper = closeReject || wickReject;
    const blockedShort =
      input.volatility == "squeeze" && input.trend == "bullish"
        ? "waiting for breakout up"
        : undefined;

    const fees = input.perpsFees;
    if (rejectedUpper && fees == null) {
      reason = "Upper rejection ignored: perps fee schedule missing";
    } else if (rejectedUpper && fees != null) {
      const bandWidth = bbUpper - bbMid;
      const bandToMidPct = bandWidth / close;
      const rejectDepth = bandWidth > 0 ? (bbUpper - close) / bandWidth : 0;
      const shortRoundTripPct = fees.openFeePct + fees.closeFeePct;
      const minShortBand = Math.max(strategy.minBandToMidPct, shortRoundTripPct);
      if (blocked != null) {
        reason = `Upper rejection ignored: ${blocked}`;
      } else if (blockedShort) {
        reason = `Upper rejection ignored: ${blockedShort}`;
      } else if (adxNow > strategy.adxMax) {
        reason = `Upper rejection ignored: ADX ${fmt(adxNow)} > ${strategy.adxMax} (not flat)`;
      } else if (bandToMidPct < minShortBand) {
        reason =
          shortRoundTripPct > strategy.minBandToMidPct
            ? `Upper rejection ignored: band→mid ${pct(bandToMidPct)} < perps open+close ${pct(shortRoundTripPct)}`
            : `Upper rejection ignored: band→mid ${pct(bandToMidPct)} < min ${pct(strategy.minBandToMidPct)}`;
      } else if (rejectDepth < strategy.minReclaimDepth) {
        reason =
          `Upper rejection ignored: depth ${pct(rejectDepth)} < min ${pct(strategy.minReclaimDepth)} ` +
          `(close ${fmt(close)} vs upper ${fmt(bbUpper)} → mid ${fmt(bbMid)})`;
      } else if (rsiNow <= rsiShortMin) {
        reason = `Upper rejection ignored: RSI ${fmt(rsiNow)} <= ${fmt(rsiShortMin)} (not overbought)`;
      } else if (
        strategy.driftFilter &&
        isWorkDriftUp({
          close,
          emaFast: emaFastNow,
          emaSlow: emaSlowNow,
          adxNow,
          plusDi,
          minusDi,
          adxFlatMax: strategy.workTrendAdxFlatMax,
        })
      ) {
        reason =
          `Upper rejection ignored: 15m drift up ` +
          `(ADX ${fmt(adxNow)} < ${strategy.workTrendAdxFlatMax} or EMAs not stacked overbought; ` +
          `+DI ${fmt(plusDi ?? 0)} −DI ${fmt(minusDi ?? 0)})`;
      } else {
        side = "SELL";
        const how = wickReject ? "wick rejection" : "close rejection";
        reason =
          `Upper BB ${how} (prev ${fmt(closePrev)}, close ${fmt(close)} < ${fmt(bbUpper)}); ` +
          `ADX ${fmt(adxNow)} <= ${strategy.adxMax}; band→mid ${pct(bandToMidPct)}; ` +
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
  return {
    ...base,
    side,
    reason,
    slPrice: bollingerStopPrice(positionSide, extreme, atrNow, input.trend, input.volatility),
    tpPrices: bollingerTpPrices(positionSide, price, bbMid),
  };
}

/** 15m mean-reversion: closed-bar BB wick/close reclaim + RSI; HOLD in bear, 1h high vol, or 15m drift; exit at mid or on an adverse time stop. */
export class BollingerStrategy implements Strategy {
  private readonly params: BollingerParams;

  constructor(trend: Trend = "flat", volatility: Volatility = "low") {
    this.params = bollingerParamsFor(trend, volatility);
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
    const { timeframe, period, atrPeriod, adxPeriod, rsiPeriod, workTrendEmaSlow } = this.params;
    const warm = Math.max(period, atrPeriod, adxPeriod * 2, rsiPeriod, workTrendEmaSlow) + 5;
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
 * Skip 15m lower-band sells that are drift/chop, not a stacked oversold trend.
 * Stacked oversold (close < EMA fast < slow, -DI > +DI, ADX >= floor) is the
 * mean-reversion setup and is allowed.
 */
export function isWorkDriftDown(input: {
  close: number;
  emaFast: number | null | undefined;
  emaSlow: number | null | undefined;
  adxNow: number | null | undefined;
  plusDi: number | null | undefined;
  minusDi: number | null | undefined;
  adxFlatMax: number;
}): boolean {
  const { close, emaFast, emaSlow, adxNow, plusDi, minusDi, adxFlatMax } = input;
  if (emaFast == null || emaSlow == null || adxNow == null || plusDi == null || minusDi == null) {
    return false;
  }
  const stackedOversold =
    close < emaFast && emaFast < emaSlow && minusDi > plusDi && adxNow >= adxFlatMax;
  if (stackedOversold) {
    return false;
  }
  return close < emaFast && (minusDi > plusDi || emaFast < emaSlow);
}

/** Mirror of {@link isWorkDriftDown} for upper-band shorts. */
export function isWorkDriftUp(input: {
  close: number;
  emaFast: number | null | undefined;
  emaSlow: number | null | undefined;
  adxNow: number | null | undefined;
  plusDi: number | null | undefined;
  minusDi: number | null | undefined;
  adxFlatMax: number;
}): boolean {
  const { close, emaFast, emaSlow, adxNow, plusDi, minusDi, adxFlatMax } = input;
  if (emaFast == null || emaSlow == null || adxNow == null || plusDi == null || minusDi == null) {
    return false;
  }
  const stackedOverbought =
    close > emaFast && emaFast > emaSlow && plusDi > minusDi && adxNow >= adxFlatMax;
  if (stackedOverbought) {
    return false;
  }
  return close > emaFast && (plusDi > minusDi || emaFast > emaSlow);
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
