/**
 * Lightweight technical indicators (no external TA library).
 */

/** Exponential moving average over `period` closes. Returns nulls until warm. */
export function ema(values: number[], period: number): Array<number | null> {
  if (period < 1) {
    throw new Error("EMA period must be >= 1");
  }

  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) {
    return out;
  }

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i]!;
  }

  let prev = sum / period;
  out[period - 1] = prev;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }

  return out;
}

/**
 * Wilder RSI. Returns nulls until the period is warm.
 * Standard formula: RSI = 100 - 100 / (1 + RS), RS = avgGain / avgLoss.
 */
export function rsi(values: number[], period: number): Array<number | null> {
  if (period < 1) {
    throw new Error("RSI period must be >= 1");
  }

  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length <= period) {
    return out;
  }

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) {
      gain += change;
    } else {
      loss -= change;
    }
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    const g = change > 0 ? change : 0;
    const l = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }

  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
