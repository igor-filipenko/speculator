import type {
  Candle,
  RequiredCandles,
  RiskParams,
  Signal,
  SignalSide,
  Strategy,
  Timeframe,
} from "../types.js";
import { buildBollingerSvg } from "./bollinger-svg.js";
import { adx, atr, bollinger, ema } from "./indicators.js";

export interface BollingerParams {
  timeframe: Timeframe;
  /** SMA / band lookback (typically 20). */
  period: number;
  /** Band width in population standard deviations (typically 2). */
  stdDev: number;
  /** Slow trend EMA; BUY only when close is above it (avoid catching knives). */
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
}

const BOLLINGER_RISK: Omit<RiskParams, "timeframe"> = {
  atrStopMult: 2.5,
  atrTrailMult: 3,
  cooldownBars: 4,
  minHoldBars: 1,
};

/** Signal-side defaults (for tests). */
export function bollingerParamsFor(): BollingerParams {
  return {
    timeframe: "4h",
    period: 20,
    stdDev: 2,
    trendEmaPeriod: 50,
    atrPeriod: 14,
    adxPeriod: 14,
    adxMax: 20,
    minBandToMidPct: 0.015,
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
 * ADX ≤ adxMax, close > trend EMA, and (mid − lower) / close ≥ minBandToMidPct.
 * SELL when close ≥ middle (SMA basis). ADX does not block exits.
 */
export function evaluateBollinger(input: BollingerInput): Signal {
  const { pair, candles, strategy, price } = input;
  const at = input.at ?? new Date();
  const closes = candles.map((c) => c.close);

  const bands = bollinger(closes, strategy.period, strategy.stdDev);
  const trendSeries = ema(closes, strategy.trendEmaPeriod);
  const atrSeries = atr(candles, strategy.atrPeriod);
  const adxSeries = adx(candles, strategy.adxPeriod);

  const i = closes.length - 1;
  const prev = i - 1;
  const bbMid = bands.mid[i];
  const bbUpper = bands.upper[i];
  const bbLower = bands.lower[i];
  const bbLowerPrev = prev >= 0 ? bands.lower[prev] : null;
  const trendEma = trendSeries[i];
  const atrNow = atrSeries[i];
  const adxNow = adxSeries[i];
  const lastBar = candles[i];

  const meta: NonNullable<Signal["meta"]> = {};
  if (bbMid != null) meta.bbMid = bbMid;
  if (bbUpper != null) meta.bbUpper = bbUpper;
  if (bbLower != null) meta.bbLower = bbLower;
  if (trendEma != null) meta.trendEma = trendEma;
  if (atrNow != null) meta.atr = atrNow;
  if (adxNow != null) meta.adx = adxNow;
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
    trendEma == null ||
    adxNow == null ||
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
  let reason = `No BB signal (close=${fmt(close)}, lower=${fmt(bbLower)}, mid=${fmt(bbMid)}, upper=${fmt(bbUpper)}, ADX=${fmt(adxNow)})`;

  if (reclaimedLower) {
    if (adxNow > strategy.adxMax) {
      reason = `Lower reclaim ignored: ADX ${fmt(adxNow)} > ${strategy.adxMax} (not flat)`;
    } else if (close <= trendEma) {
      reason = `Lower reclaim ignored: close ${fmt(close)} <= trend EMA${strategy.trendEmaPeriod} ${fmt(trendEma)}`;
    } else if (bandToMidPct < strategy.minBandToMidPct) {
      reason = `Lower reclaim ignored: band→mid ${pct(bandToMidPct)} < min ${pct(strategy.minBandToMidPct)}`;
    } else {
      side = "BUY";
      reason =
        `Reclaimed lower BB (prev ${fmt(closePrev)} ≤ ${fmt(bbLowerPrev)}, close ${fmt(close)} > ${fmt(bbLower)}); ` +
        `ADX ${fmt(adxNow)} <= ${strategy.adxMax}; close > trend EMA; band→mid ${pct(bandToMidPct)}`;
    }
  } else if (close >= bbMid) {
    side = "SELL";
    reason = `Close ${fmt(close)} >= BB mid ${fmt(bbMid)}`;
  }

  return { ...base, side, reason };
}

/** 4h mean-reversion: BB reclaim + trend EMA + ADX flat gate; exit at mid. */
export class BollingerStrategy implements Strategy {
  private readonly params: BollingerParams;
  private readonly risk: RiskParams;

  constructor() {
    this.params = bollingerParamsFor();
    this.risk = { timeframe: this.params.timeframe, ...BOLLINGER_RISK };
  }

  getDisplayName(): string {
    return `bollinger (${this.params.timeframe})`;
  }

  getMode(): "bollinger" {
    return "bollinger";
  }

  getRiskParams(): RiskParams {
    return this.risk;
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, period, trendEmaPeriod, atrPeriod, adxPeriod } = this.params;
    const warm = Math.max(period, trendEmaPeriod, atrPeriod, adxPeriod * 2) + 5;
    return {
      timeframe,
      count: Math.max(warm, 160),
    };
  }

  evaluateSignal(pair: string, candles: Candle[], price: number, at: Date): Signal {
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
