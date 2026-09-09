import type {
  Candle,
  MarketIndicators,
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
import { adx, atr, bollinger, ema, rsi } from "../indicators.js";

export interface BollingerParams {
  timeframe: Timeframe;
  /** SMA / band lookback. */
  period: number;
  /** Band width in population standard deviations. */
  stdDev: number;
  /** Slow trend EMA; BUY only when close is above it (avoid catching knives). 0 = skip. */
  trendEmaPeriod: number;
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
  /** Wilder RSI period (oversold gate on lower-band reclaim). */
  rsiPeriod: number;
  /** BUY only when RSI < this (skip weak lower-band touches). */
  rsiBuyMax: number;
}

/** High vol widens bands slightly so a reclaim is a real extreme. */
const STD_DEV: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 1.6, low: 1.5, squeeze: 1.5, unknown: 1.5 },
  flat: { high: 1.6, low: 1.5, squeeze: 1.5, unknown: 1.5 },
  bearish: { high: 1.6, low: 1.5, squeeze: 1.5, unknown: 1.5 },
  unknown: { high: 1.6, low: 1.5, squeeze: 1.5, unknown: 1.5 },
};

/** Looser ADX in bullish dips; tighter in flat squeeze so we do not fade the coil. */
const ADX_MAX: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 40, low: 28, squeeze: 34, unknown: 32 },
  flat: { high: 28, low: 32, squeeze: 24, unknown: 28 },
  bearish: { high: 25, low: 25, squeeze: 25, unknown: 25 },
  unknown: { high: 25, low: 25, squeeze: 25, unknown: 25 },
};

/** Skip tiny squeeze TPs; high vol needs enough mid-distance to cover noise. */
const MIN_BAND_TO_MID: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 0.005, low: 0.004, squeeze: 0.004, unknown: 0.004 },
  flat: { high: 0.005, low: 0.004, squeeze: 0.006, unknown: 0.004 },
  bearish: { high: 0.005, low: 0.004, squeeze: 0.006, unknown: 0.004 },
  unknown: { high: 0.005, low: 0.004, squeeze: 0.006, unknown: 0.004 },
};

/** Bullish/high washouts can be shallow (RSI 50); quiet bullish stays strict so we skip exhaustion. */
const RSI_BUY_MAX: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 50, low: 40, squeeze: 48, unknown: 45 },
  flat: { high: 40, low: 45, squeeze: 40, unknown: 45 },
  bearish: { high: 40, low: 40, squeeze: 40, unknown: 40 },
  unknown: { high: 40, low: 40, squeeze: 40, unknown: 40 },
};

const ATR_STOP: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 3, low: 2.5, squeeze: 2.5, unknown: 2.5 },
  flat: { high: 2.5, low: 2, squeeze: 2, unknown: 2 },
  bearish: { high: 2, low: 2, squeeze: 2, unknown: 2 },
  unknown: { high: 2, low: 2, squeeze: 2, unknown: 2 },
};

const ATR_TRAIL: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 3.5, low: 3, squeeze: 3, unknown: 2.5 },
  flat: { high: 3, low: 2.5, squeeze: 2.5, unknown: 2.5 },
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
    trendEmaPeriod: 50,
    atrPeriod: 14,
    adxPeriod: 14,
    adxMax: ADX_MAX[trend][volatility],
    minBandToMidPct: MIN_BAND_TO_MID[trend][volatility],
    rsiPeriod: 14,
    rsiBuyMax: RSI_BUY_MAX[trend][volatility],
  };
}

function riskParamsFor(trend: Trend, volatility: Volatility): RiskParams {
  return {
    timeframe: "15m",
    atrStopMult: ATR_STOP[trend][volatility],
    atrTrailMult: ATR_TRAIL[trend][volatility],
    cooldownBars: 4,
    minHoldBars: 3,
  };
}

export interface BollingerInput {
  pair: string;
  candles: Candle[];
  strategy: BollingerParams;
  /** Spot price used in the signal (usually exchange quote). */
  price: number;
  at?: Date;
}

/**
 * Mean-reversion Bollinger for flat markets.
 * BUY on lower-band **reclaim** (prev close ≤ lower, close > lower) when:
 * ADX ≤ adxMax, close > trend EMA (skipped when trendEmaPeriod is 0), (mid − lower) / close ≥ minBandToMidPct,
 * and RSI < rsiBuyMax (oversold; skip weak touches).
 * SELL when close ≥ middle (SMA basis). ADX / RSI do not block exits.
 */
export function evaluateBollinger(input: BollingerInput): Signal {
  const { pair, candles, strategy, price } = input;
  const at = input.at ?? new Date();
  const closes = candles.map((c) => c.close);

  const bands = bollinger(closes, strategy.period, strategy.stdDev);
  const trendSeries = strategy.trendEmaPeriod > 0 ? ema(closes, strategy.trendEmaPeriod) : [];
  const atrSeries = atr(candles, strategy.atrPeriod);
  const adxSeries = adx(candles, strategy.adxPeriod);
  const rsiSeries = rsi(closes, strategy.rsiPeriod);

  const i = closes.length - 1;
  const prev = i - 1;
  const bbMid = bands.mid[i];
  const bbUpper = bands.upper[i];
  const bbLower = bands.lower[i];
  const bbLowerPrev = prev >= 0 ? bands.lower[prev] : null;
  const trendEma = strategy.trendEmaPeriod > 0 ? trendSeries[i] : undefined;
  const atrNow = atrSeries[i];
  const adxNow = adxSeries[i];
  const rsiNow = rsiSeries[i];
  const lastBar = candles[i];

  const meta: NonNullable<Signal["meta"]> = {};
  if (bbMid != null) meta.bbMid = bbMid;
  if (bbUpper != null) meta.bbUpper = bbUpper;
  if (bbLower != null) meta.bbLower = bbLower;
  if (trendEma != null) meta.trendEma = trendEma;
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
    (strategy.trendEmaPeriod > 0 && trendEma == null) ||
    adxNow == null ||
    rsiNow == null ||
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
  const bandToMidPct = (bbMid - bbLower) / close;
  const reclaimedLower = closePrev <= bbLowerPrev && close > bbLower;

  let side: SignalSide = "HOLD";
  let reason = `No BB signal (close=${fmt(close)}, lower=${fmt(bbLower)}, mid=${fmt(bbMid)}, upper=${fmt(bbUpper)}, ADX=${fmt(adxNow)}, RSI=${fmt(rsiNow)})`;

  if (reclaimedLower) {
    if (adxNow > strategy.adxMax) {
      reason = `Lower reclaim ignored: ADX ${fmt(adxNow)} > ${strategy.adxMax} (not flat)`;
    } else if (strategy.trendEmaPeriod > 0 && trendEma != null && close <= trendEma) {
      reason = `Lower reclaim ignored: close ${fmt(close)} <= trend EMA${strategy.trendEmaPeriod} ${fmt(trendEma)}`;
    } else if (bandToMidPct < strategy.minBandToMidPct) {
      reason = `Lower reclaim ignored: band→mid ${pct(bandToMidPct)} < min ${pct(strategy.minBandToMidPct)}`;
    } else if (rsiNow >= strategy.rsiBuyMax) {
      reason = `Lower reclaim ignored: RSI ${fmt(rsiNow)} >= ${strategy.rsiBuyMax} (not oversold)`;
    } else {
      side = "BUY";
      const emaNote = strategy.trendEmaPeriod > 0 && trendEma != null ? `close > trend EMA; ` : "";
      reason =
        `Reclaimed lower BB (prev ${fmt(closePrev)} ≤ ${fmt(bbLowerPrev)}, close ${fmt(close)} > ${fmt(bbLower)}); ` +
        `ADX ${fmt(adxNow)} <= ${strategy.adxMax}; ${emaNote}band→mid ${pct(bandToMidPct)}; ` +
        `RSI ${fmt(rsiNow)} < ${strategy.rsiBuyMax}`;
    }
  } else if (close >= bbMid) {
    side = "SELL";
    reason = `Close ${fmt(close)} >= BB mid ${fmt(bbMid)}`;
  }

  return { ...base, side, reason };
}

/** 15m mean-reversion: BB reclaim + RSI oversold + trend EMA + ADX flat gate; exit at mid. */
export class BollingerStrategy implements Strategy {
  private readonly params: BollingerParams;
  private readonly risk: RiskParams;

  constructor(trend: Trend = "flat", volatility: Volatility = "low") {
    this.params = bollingerParamsFor(trend, volatility);
    this.risk = riskParamsFor(trend, volatility);
  }

  getDisplayName(): string {
    const { timeframe, period, stdDev, adxMax, rsiBuyMax } = this.params;
    return `bollinger (${timeframe} BB${period}×${stdDev} ADX${adxMax} RSI${rsiBuyMax})`;
  }

  getMode(): "bollinger" {
    return "bollinger";
  }

  getRiskParams(): RiskParams {
    return this.risk;
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, period, trendEmaPeriod, atrPeriod, adxPeriod, rsiPeriod } = this.params;
    const warm = Math.max(period, trendEmaPeriod, atrPeriod, adxPeriod * 2, rsiPeriod) + 5;
    return {
      timeframe,
      count: Math.max(warm, 160),
    };
  }

  evaluateSignal(
    pair: string,
    candles: Candle[],
    _market: MarketIndicators,
    price: number,
    at: Date,
  ): Signal {
    return evaluateBollinger({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
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
