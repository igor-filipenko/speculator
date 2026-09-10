import type {
  Candle,
  MarketIndicators,
  PortfolioSnapshot,
  RequiredCandles,
  RiskParams,
  Signal,
  SignalSide,
  Strategy,
  Timeframe,
  Trend,
  Volatility,
} from "../../types.js";
import { buildBollingerSvg } from "./bollinger-svg.js";
import { adx, atr, bollinger, rsi } from "../indicators.js";

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
  /** Wilder RSI period (oversold gate on lower-band reclaim). */
  rsiPeriod: number;
  /** BUY only when RSI < this (skip weak lower-band touches). */
  rsiBuyMax: number;
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
  bullish: { high: 40, low: 32, squeeze: 36, unknown: 32 },
  flat: { high: 28, low: 35, squeeze: 28, unknown: 32 },
  bearish: { high: 25, low: 25, squeeze: 25, unknown: 25 },
  unknown: { high: 25, low: 25, squeeze: 25, unknown: 25 },
};

/** Skip tiny squeeze TPs; high vol is no-buy so the row is unused for entries. */
const MIN_BAND_TO_MID: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 0.005, low: 0.0035, squeeze: 0.0035, unknown: 0.004 },
  flat: { high: 0.005, low: 0.0035, squeeze: 0.004, unknown: 0.004 },
  bearish: { high: 0.005, low: 0.004, squeeze: 0.006, unknown: 0.004 },
  unknown: { high: 0.005, low: 0.004, squeeze: 0.006, unknown: 0.004 },
};

/** Fraction of band width the close must reclaim; kisses stay out. */
const MIN_RECLAIM_DEPTH: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 0.15, low: 0.15, squeeze: 0.2, unknown: 0.15 },
  flat: { high: 0.15, low: 0.15, squeeze: 0.2, unknown: 0.15 },
  bearish: { high: 0.15, low: 0.15, squeeze: 0.15, unknown: 0.15 },
  unknown: { high: 0.15, low: 0.15, squeeze: 0.15, unknown: 0.15 },
};

/** HTF already gates trend; RSI just skips momentum touches that are not oversold. */
const RSI_BUY_MAX: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 50, low: 48, squeeze: 50, unknown: 45 },
  flat: { high: 40, low: 50, squeeze: 45, unknown: 45 },
  bearish: { high: 40, low: 40, squeeze: 40, unknown: 40 },
  unknown: { high: 40, low: 40, squeeze: 40, unknown: 40 },
};

const ATR_STOP: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 3, low: 2.5, squeeze: 2.5, unknown: 2.5 },
  flat: { high: 2.5, low: 2.5, squeeze: 2.5, unknown: 2.5 },
  bearish: { high: 2, low: 2, squeeze: 2, unknown: 2 },
  unknown: { high: 2, low: 2, squeeze: 2, unknown: 2 },
};

const ATR_TRAIL: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 3.5, low: 3, squeeze: 3, unknown: 2.5 },
  flat: { high: 3, low: 3, squeeze: 3, unknown: 2.5 },
  bearish: { high: 2, low: 2, squeeze: 2, unknown: 2 },
  unknown: { high: 2, low: 2, squeeze: 2, unknown: 2 },
};

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
    minExitAboveEntryPct: 0.002,
    rsiPeriod: 14,
    rsiBuyMax: RSI_BUY_MAX[trend][volatility],
  };
}

function riskParamsFor(trend: Trend, volatility: Volatility): RiskParams {
  return {
    timeframe: "15m",
    atrStopMult: ATR_STOP[trend][volatility],
    atrTrailMult: ATR_TRAIL[trend][volatility],
    cooldownBars: 2,
    minHoldBars: 1,
  };
}

/**
 * Mean-reversion is off in HTF bear/unknown and in 1h high vol.
 * Exits (close ≥ mid, ATR) still fire.
 */
export function bollingerDoNotBuyReason(trend: Trend, volatility: Volatility): string | undefined {
  if (trend === "bearish" || trend === "unknown") {
    return `HTF trend ${trend}`;
  }
  if (volatility === "high") {
    return `1h volatility ${volatility}`;
  }
  return undefined;
}

export interface BollingerInput {
  pair: string;
  candles: Candle[];
  strategy: BollingerParams;
  /** Spot price used in the signal (usually exchange quote). */
  price: number;
  at?: Date;
  /** When true, lower-band reclaims are ignored. Exits still fire. */
  doNotBuy?: boolean;
  /** Extra text for the HOLD reason when {@link doNotBuy} is set. */
  doNotBuyReason?: string;
  /** Open-long fill; required for mid-exit. Skipped when close is not above this after costs. */
  entryPrice?: number;
}

/**
 * Mean-reversion Bollinger for bullish/flat × low/squeeze.
 * BUY on lower-band **reclaim** when flat: same-bar wick (low ≤ lower, close back inside, green)
 * or prior close ≤ prior lower then close > lower, when ADX ≤ adxMax, close < mid,
 * reclaim depth ≥ minReclaimDepth, (mid − lower) / close ≥ minBandToMidPct, RSI < rsiBuyMax.
 * Already long → HOLD on reclaim (no pyramid). SELL when long and close ≥ middle
 * **and** close is above the open fill after costs. Flat → HOLD on mid.
 * Regime / ADX / RSI do not block exits.
 */
export function evaluateBollinger(input: BollingerInput): Signal {
  const { pair, candles, strategy, price } = input;
  const at = input.at ?? new Date();
  const closes = candles.map((c) => c.close);

  const bands = bollinger(closes, strategy.period, strategy.stdDev);
  const atrSeries = atr(candles, strategy.atrPeriod);
  const adxSeries = adx(candles, strategy.adxPeriod);
  const rsiSeries = rsi(closes, strategy.rsiPeriod);

  const i = closes.length - 1;
  const prev = i - 1;
  const bbMid = bands.mid[i];
  const bbUpper = bands.upper[i];
  const bbLower = bands.lower[i];
  const bbLowerPrev = prev >= 0 ? bands.lower[prev] : null;
  const atrNow = atrSeries[i];
  const adxNow = adxSeries[i];
  const rsiNow = rsiSeries[i];
  const lastBar = candles[i];

  const meta: NonNullable<Signal["meta"]> = {};
  if (bbMid != null) meta.bbMid = bbMid;
  if (bbUpper != null) meta.bbUpper = bbUpper;
  if (bbLower != null) meta.bbLower = bbLower;
  if (atrNow != null) meta.atr = atrNow;
  if (adxNow != null) meta.adx = adxNow;
  if (rsiNow != null) meta.rsi = rsiNow;
  if (lastBar != null) {
    meta.barLow = lastBar.low;
    meta.barHigh = lastBar.high;
  }

  const base = {
    pair,
    price,
    at,
    meta,
  };

  if (
    bbMid == null ||
    bbUpper == null ||
    bbLower == null ||
    bbLowerPrev == null ||
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
  const bandWidth = bbMid - bbLower;
  const bandToMidPct = bandWidth / close;
  const reclaimDepth = bandWidth > 0 ? (close - bbLower) / bandWidth : 0;
  const roomToMid = close < bbMid;
  const closeReclaim = closePrev <= bbLowerPrev && close > bbLower && roomToMid;
  const wickReclaim =
    lastBar.low <= bbLower && close > bbLower && close > lastBar.open && roomToMid;
  const reclaimedLower = closeReclaim || wickReclaim;
  const entry = input.entryPrice;
  const long = entry != null && entry > 0;
  const minExit = long ? entry * (1 + strategy.minExitAboveEntryPct) : undefined;
  const profitableMid = long && close >= bbMid && minExit != null && close >= minExit;

  let side: SignalSide = "HOLD";
  let reason = `No BB signal (close=${fmt(close)}, lower=${fmt(bbLower)}, mid=${fmt(bbMid)}, upper=${fmt(bbUpper)}, ADX=${fmt(adxNow)}, RSI=${fmt(rsiNow)})`;

  if (profitableMid) {
    side = "SELL";
    reason = `Close ${fmt(close)} >= BB mid ${fmt(bbMid)}`;
  } else if (reclaimedLower) {
    const blocked = input.doNotBuy === true ? (input.doNotBuyReason ?? "regime") : undefined;
    if (blocked != null) {
      reason = `Lower reclaim ignored: ${blocked}`;
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
    } else if (long) {
      reason = `Lower reclaim ignored: already long`;
    } else {
      side = "BUY";
      const how = wickReclaim ? "wick reclaim" : "close reclaim";
      reason =
        `Lower BB ${how} (prev ${fmt(closePrev)}, close ${fmt(close)} > ${fmt(bbLower)}); ` +
        `ADX ${fmt(adxNow)} <= ${strategy.adxMax}; band→mid ${pct(bandToMidPct)}; ` +
        `depth ${pct(reclaimDepth)}; RSI ${fmt(rsiNow)} < ${strategy.rsiBuyMax}`;
    }
  } else if (long && close >= bbMid && minExit != null && close < minExit) {
    reason =
      `Close ${fmt(close)} >= BB mid ${fmt(bbMid)} but below entry ${fmt(entry)} + ` +
      `${pct(strategy.minExitAboveEntryPct)}; wait ATR`;
  }

  return { ...base, side, reason };
}

/** 15m mean-reversion: BB wick/close reclaim + RSI; HOLD in bear or 1h high vol; exit at mid. */
export class BollingerStrategy implements Strategy {
  private readonly params: BollingerParams;
  private readonly risk: RiskParams;
  private readonly trend: Trend;
  private readonly volatility: Volatility;

  constructor(trend: Trend = "flat", volatility: Volatility = "low") {
    this.trend = trend;
    this.volatility = volatility;
    this.params = bollingerParamsFor(trend, volatility);
    this.risk = riskParamsFor(trend, volatility);
  }

  getDisplayName(): string {
    const { timeframe, period, stdDev, adxMax, rsiBuyMax } = this.params;
    const gate = bollingerDoNotBuyReason(this.trend, this.volatility) == null ? "mr" : "no-buy";
    return `bollinger (${timeframe} BB${period}×${stdDev} ADX${adxMax} RSI${rsiBuyMax} ${gate})`;
  }

  getMode(): "bollinger" {
    return "bollinger";
  }

  getRiskParams(): RiskParams {
    return this.risk;
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
  ): Signal {
    const blocked = bollingerDoNotBuyReason(market.trend, market.volatility);
    const position = portfolio?.position;
    const entryPrice =
      position?.side === "long" && position.entryPrice > 0 ? position.entryPrice : undefined;
    return evaluateBollinger({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
      ...(blocked != null ? { doNotBuy: true, doNotBuyReason: blocked } : {}),
      ...(entryPrice != null ? { entryPrice } : {}),
    });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildBollingerSvg({ pair, candles, strategy: this.params });
  }
}

function fmt(n: number): string {
  return n.toFixed(4);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}
