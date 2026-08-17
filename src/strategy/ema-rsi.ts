import type {
  Candle,
  RequiredCandles,
  RiskParams,
  Signal,
  SignalSide,
  Strategy,
  Timeframe,
} from "../types.js";
import { adx, atr, ema, rsi } from "./indicators.js";
import { buildOhlcvSvg } from "./ema-rsi-svg.js";

export interface EmaRsiParams {
  timeframe: Timeframe;
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  /** BUY only when RSI >= this (with rsiBuyMax forms a band). */
  rsiBuyMin: number;
  rsiBuyMax: number;
  rsiSellMin: number;
  /** Slow trend EMA; BUY only when close is above it. */
  trendEmaPeriod: number;
  /** Wilder ATR period (strategy computes ATR into Signal.meta). */
  atrPeriod: number;
  /** Wilder ADX period (typically 14). */
  adxPeriod: number;
  /** BUY only when ADX >= this (regime / trend-strength gate). */
  adxMin: number;
}

const EMA_RSI_RISK: Omit<RiskParams, "timeframe"> = {
  atrStopMult: 2,
  atrTrailMult: 2.5,
  cooldownBars: 2,
  minHoldBars: 1,
};

/** Signal-side defaults (for tests / chart helpers). */
export function emaRsiParamsFor(): EmaRsiParams {
  return {
    timeframe: "4h",
    emaFast: 12,
    emaSlow: 26,
    rsiPeriod: 14,
    rsiBuyMin: 40,
    rsiBuyMax: 60,
    rsiSellMin: 45,
    trendEmaPeriod: 50,
    atrPeriod: 14,
    adxPeriod: 14,
    adxMin: 20,
  };
}

export interface EmaRsiInput {
  pair: string;
  candles: Candle[];
  strategy: EmaRsiParams;
  /** Spot price used in the signal (usually exchange quote). */
  price: number;
  at?: Date;
}

/**
 * EMA crossover with RSI band, trend EMA, and ADX regime filter.
 * BUY when fast crosses above slow, RSI in [rsiBuyMin, rsiBuyMax), close > trend EMA,
 * and ADX >= adxMin. SELL on bearish cross with RSI > rsiSellMin (ADX does not block exits).
 */
export function evaluateEmaRsi(input: EmaRsiInput): Signal {
  const { pair, candles, strategy, price } = input;
  const at = input.at ?? new Date();
  const closes = candles.map((c) => c.close);

  const fastSeries = ema(closes, strategy.emaFast);
  const slowSeries = ema(closes, strategy.emaSlow);
  const trendSeries = ema(closes, strategy.trendEmaPeriod);
  const rsiSeries = rsi(closes, strategy.rsiPeriod);
  const atrSeries = atr(candles, strategy.atrPeriod);
  const adxSeries = adx(candles, strategy.adxPeriod);

  const i = closes.length - 1;
  const prev = i - 1;

  const emaFast = fastSeries[i];
  const emaSlow = slowSeries[i];
  const trendEma = trendSeries[i];
  const emaFastPrev = prev >= 0 ? fastSeries[prev] : null;
  const emaSlowPrev = prev >= 0 ? slowSeries[prev] : null;
  const rsiNow = rsiSeries[i];
  const atrNow = atrSeries[i];
  const adxNow = adxSeries[i];
  const lastBar = candles[i];

  const meta: NonNullable<Signal["meta"]> = {};
  if (emaFast != null) meta.emaFast = emaFast;
  if (emaSlow != null) meta.emaSlow = emaSlow;
  if (trendEma != null) meta.trendEma = trendEma;
  if (rsiNow != null) meta.rsi = rsiNow;
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
    emaFast == null ||
    emaSlow == null ||
    trendEma == null ||
    emaFastPrev == null ||
    emaSlowPrev == null ||
    rsiNow == null ||
    adxNow == null
  ) {
    return {
      ...base,
      side: "HOLD",
      reason: "Indicators not warm yet (need more candles)",
    };
  }

  const close = closes[i]!;
  const crossedUp = emaFastPrev <= emaSlowPrev && emaFast > emaSlow;
  const crossedDown = emaFastPrev >= emaSlowPrev && emaFast < emaSlow;

  let side: SignalSide = "HOLD";
  let reason = `No crossover (EMA${strategy.emaFast}=${fmt(emaFast)}, EMA${strategy.emaSlow}=${fmt(emaSlow)}, trendEMA=${fmt(trendEma)}, RSI=${fmt(rsiNow)}, ADX=${fmt(adxNow)})`;

  if (crossedUp) {
    if (rsiNow < strategy.rsiBuyMin || rsiNow >= strategy.rsiBuyMax) {
      reason = `Bullish cross ignored: RSI ${fmt(rsiNow)} outside [${strategy.rsiBuyMin}, ${strategy.rsiBuyMax})`;
    } else if (close <= trendEma) {
      reason = `Bullish cross ignored: close ${fmt(close)} <= trend EMA${strategy.trendEmaPeriod} ${fmt(trendEma)}`;
    } else if (adxNow < strategy.adxMin) {
      reason = `Bullish cross ignored: ADX ${fmt(adxNow)} < ${strategy.adxMin}`;
    } else {
      side = "BUY";
      reason = `EMA${strategy.emaFast} crossed above EMA${strategy.emaSlow}; RSI ${fmt(rsiNow)} in [${strategy.rsiBuyMin}, ${strategy.rsiBuyMax}); close > trend EMA; ADX ${fmt(adxNow)} >= ${strategy.adxMin}`;
    }
  } else if (crossedDown) {
    if (rsiNow > strategy.rsiSellMin) {
      side = "SELL";
      reason = `EMA${strategy.emaFast} crossed below EMA${strategy.emaSlow}; RSI ${fmt(rsiNow)} > ${strategy.rsiSellMin}`;
    } else {
      reason = `Bearish cross ignored: RSI ${fmt(rsiNow)} <= ${strategy.rsiSellMin}`;
    }
  }

  return { ...base, side, reason };
}

/** 4h trend: EMA 12/26 + RSI 14 + trend/ADX filters. */
export class EmaRsiStrategy implements Strategy {
  private readonly params: EmaRsiParams;
  private readonly risk: RiskParams;

  constructor() {
    this.params = emaRsiParamsFor();
    this.risk = { timeframe: this.params.timeframe, ...EMA_RSI_RISK };
  }

  getDisplayName(): string {
    return `ema-rsi (${this.params.timeframe})`;
  }

  getMode(): "ema-rsi" {
    return "ema-rsi";
  }

  getRiskParams(): RiskParams {
    return this.risk;
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, emaSlow, rsiPeriod, trendEmaPeriod, atrPeriod, adxPeriod } = this.params;
    const warm = Math.max(emaSlow, trendEmaPeriod, atrPeriod, adxPeriod * 2) + rsiPeriod + 5;
    return {
      timeframe,
      count: Math.max(warm, 160),
    };
  }

  evaluateSignal(pair: string, candles: Candle[], price: number, at: Date): Signal {
    return evaluateEmaRsi({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
    });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildOhlcvSvg({ pair, candles, strategy: this.params });
  }
}

function fmt(n: number): string {
  return n.toFixed(4);
}
