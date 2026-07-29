import type { StrategyParams } from "../config.js";
import type { Candle, Signal, SignalSide } from "../types.js";
import { ema, rsi } from "./indicators.js";

export interface EmaRsiInput {
  pair: string;
  candles: Candle[];
  params: StrategyParams;
  /** Spot price used in the signal (usually Jupiter quote). */
  price: number;
  at?: Date;
}

/**
 * EMA crossover with RSI filter.
 * BUY when fast crosses above slow and RSI < rsiBuyMax.
 * SELL when fast crosses below slow and RSI > rsiSellMin.
 */
export function evaluateEmaRsi(input: EmaRsiInput): Signal {
  const { pair, candles, params, price } = input;
  const at = input.at ?? new Date();
  const closes = candles.map((c) => c.close);

  const fastSeries = ema(closes, params.emaFast);
  const slowSeries = ema(closes, params.emaSlow);
  const rsiSeries = rsi(closes, params.rsiPeriod);

  const i = closes.length - 1;
  const prev = i - 1;

  const emaFast = fastSeries[i];
  const emaSlow = slowSeries[i];
  const emaFastPrev = prev >= 0 ? fastSeries[prev] : null;
  const emaSlowPrev = prev >= 0 ? slowSeries[prev] : null;
  const rsiNow = rsiSeries[i];

  const base = {
    pair,
    price,
    at,
    meta: {
      emaFast: emaFast ?? undefined,
      emaSlow: emaSlow ?? undefined,
      rsi: rsiNow ?? undefined,
    },
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
  let reason = `No crossover (EMA${params.emaFast}=${fmt(emaFast)}, EMA${params.emaSlow}=${fmt(emaSlow)}, RSI=${fmt(rsiNow)})`;

  if (crossedUp) {
    if (rsiNow < params.rsiBuyMax) {
      side = "BUY";
      reason = `EMA${params.emaFast} crossed above EMA${params.emaSlow}; RSI ${fmt(rsiNow)} < ${params.rsiBuyMax}`;
    } else {
      reason = `Bullish cross ignored: RSI ${fmt(rsiNow)} >= ${params.rsiBuyMax}`;
    }
  } else if (crossedDown) {
    if (rsiNow > params.rsiSellMin) {
      side = "SELL";
      reason = `EMA${params.emaFast} crossed below EMA${params.emaSlow}; RSI ${fmt(rsiNow)} > ${params.rsiSellMin}`;
    } else {
      reason = `Bearish cross ignored: RSI ${fmt(rsiNow)} <= ${params.rsiSellMin}`;
    }
  }

  return { ...base, side, reason };
}

function fmt(n: number): string {
  return n.toFixed(4);
}
