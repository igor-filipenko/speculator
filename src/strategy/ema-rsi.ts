import type { Candle, Signal, SignalSide, StrategyParams } from "../types.js";
import { ema, rsi } from "./indicators.js";

export interface EmaRsiInput {
  pair: string;
  candles: Candle[];
  strategy: StrategyParams;
  /** Spot price used in the signal (usually exchange quote). */
  price: number;
  at?: Date;
}

/**
 * EMA crossover with RSI filter.
 * BUY when fast crosses above slow and RSI < rsiBuyMax.
 * SELL when fast crosses below slow and RSI > rsiSellMin.
 */
export function evaluateEmaRsi(input: EmaRsiInput): Signal {
  const { pair, candles, strategy, price } = input;
  const at = input.at ?? new Date();
  const closes = candles.map((c) => c.close);

  const fastSeries = ema(closes, strategy.emaFast);
  const slowSeries = ema(closes, strategy.emaSlow);
  const rsiSeries = rsi(closes, strategy.rsiPeriod);

  const i = closes.length - 1;
  const prev = i - 1;

  const emaFast = fastSeries[i];
  const emaSlow = slowSeries[i];
  const emaFastPrev = prev >= 0 ? fastSeries[prev] : null;
  const emaSlowPrev = prev >= 0 ? slowSeries[prev] : null;
  const rsiNow = rsiSeries[i];

  const meta: NonNullable<Signal["meta"]> = {};
  if (emaFast != null) meta.emaFast = emaFast;
  if (emaSlow != null) meta.emaSlow = emaSlow;
  if (rsiNow != null) meta.rsi = rsiNow;

  const base = {
    pair,
    price,
    at,
    meta,
  };

  if (
    emaFast == null ||
    emaSlow == null ||
    emaFastPrev == null ||
    emaSlowPrev == null ||
    rsiNow == null
  ) {
    return {
      ...base,
      side: "HOLD",
      reason: "Indicators not warm yet (need more candles)",
    };
  }

  const crossedUp = emaFastPrev <= emaSlowPrev && emaFast > emaSlow;
  const crossedDown = emaFastPrev >= emaSlowPrev && emaFast < emaSlow;

  let side: SignalSide = "HOLD";
  let reason = `No crossover (EMA${strategy.emaFast}=${fmt(emaFast)}, EMA${strategy.emaSlow}=${fmt(emaSlow)}, RSI=${fmt(rsiNow)})`;

  if (crossedUp) {
    if (rsiNow < strategy.rsiBuyMax) {
      side = "BUY";
      reason = `EMA${strategy.emaFast} crossed above EMA${strategy.emaSlow}; RSI ${fmt(rsiNow)} < ${strategy.rsiBuyMax}`;
    } else {
      reason = `Bullish cross ignored: RSI ${fmt(rsiNow)} >= ${strategy.rsiBuyMax}`;
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
