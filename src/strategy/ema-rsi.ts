import type { Candle, Signal, SignalSide, StrategyParams } from "../types.js";
import { adx, atr, ema, rsi } from "./indicators.js";

export interface EmaRsiInput {
  pair: string;
  candles: Candle[];
  strategy: StrategyParams;
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

function fmt(n: number): string {
  return n.toFixed(4);
}
