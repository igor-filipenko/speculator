/**
 * Lightweight technical indicators (no external TA library).
 */

/** Exponential moving average over `period` closes. Returns nulls until warm. */
export function ema(values: number[], period: number): (number | null)[] {
  if (period < 1) {
    throw new Error("EMA period must be >= 1");
  }

  const out: (number | null)[] = Array.from({ length: values.length }, () => null);
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
export function rsi(values: number[], period: number): (number | null)[] {
  if (period < 1) {
    throw new Error("RSI period must be >= 1");
  }

  const out: (number | null)[] = Array.from({ length: values.length }, () => null);
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

export interface AtrCandle {
  high: number;
  low: number;
  close: number;
}

/**
 * Wilder Average True Range. Returns nulls until `period` true ranges are available
 * (first ATR at index `period`).
 */
export function atr(candles: AtrCandle[], period: number): (number | null)[] {
  if (period < 1) {
    throw new Error("ATR period must be >= 1");
  }

  const out: (number | null)[] = Array.from({ length: candles.length }, () => null);
  if (candles.length <= period) {
    return out;
  }

  const trueRanges: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (i === 0) {
      trueRanges.push(c.high - c.low);
      continue;
    }
    const prevClose = candles[i - 1]!.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    trueRanges.push(tr);
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += trueRanges[i]!;
  }
  let prevAtr = sum / period;
  out[period] = prevAtr;

  for (let i = period + 1; i < candles.length; i++) {
    prevAtr = (prevAtr * (period - 1) + trueRanges[i]!) / period;
    out[i] = prevAtr;
  }

  return out;
}

export interface AdxCandle {
  high: number;
  low: number;
  close: number;
}

/**
 * Wilder ADX. Returns nulls until warm (first value at index `2 * period - 1`).
 * Uses +DM/−DM and true range with Wilder smoothing, then DX → ADX.
 */
export function adx(candles: AdxCandle[], period: number): (number | null)[] {
  if (period < 1) {
    throw new Error("ADX period must be >= 1");
  }

  const n = candles.length;
  const out: (number | null)[] = Array.from({ length: n }, () => null);
  // Need period TR/DM bars (indices 1..period) plus period DX values → first ADX at 2*period-1.
  if (n < 2 * period) {
    return out;
  }

  const tr: number[] = Array.from({ length: n }, () => 0);
  const plusDm: number[] = Array.from({ length: n }, () => 0);
  const minusDm: number[] = Array.from({ length: n }, () => 0);

  for (let i = 1; i < n; i++) {
    const cur = candles[i]!;
    const prev = candles[i - 1]!;
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
  }

  let smoothTr = 0;
  let smoothPlus = 0;
  let smoothMinus = 0;
  for (let i = 1; i <= period; i++) {
    smoothTr += tr[i]!;
    smoothPlus += plusDm[i]!;
    smoothMinus += minusDm[i]!;
  }

  const dx: (number | null)[] = Array.from({ length: n }, () => null);
  dx[period] = dxFromSmooth(smoothTr, smoothPlus, smoothMinus);

  for (let i = period + 1; i < n; i++) {
    smoothTr = smoothTr - smoothTr / period + tr[i]!;
    smoothPlus = smoothPlus - smoothPlus / period + plusDm[i]!;
    smoothMinus = smoothMinus - smoothMinus / period + minusDm[i]!;
    dx[i] = dxFromSmooth(smoothTr, smoothPlus, smoothMinus);
  }

  const firstAdxIndex = 2 * period - 1;
  let adxSum = 0;
  for (let i = period; i <= firstAdxIndex; i++) {
    adxSum += dx[i]!;
  }
  let prevAdx = adxSum / period;
  out[firstAdxIndex] = prevAdx;

  for (let i = firstAdxIndex + 1; i < n; i++) {
    prevAdx = (prevAdx * (period - 1) + dx[i]!) / period;
    out[i] = prevAdx;
  }

  return out;
}

function dxFromSmooth(smoothTr: number, smoothPlus: number, smoothMinus: number): number {
  if (!(smoothTr > 0)) {
    return 0;
  }
  const plusDi = (100 * smoothPlus) / smoothTr;
  const minusDi = (100 * smoothMinus) / smoothTr;
  const sum = plusDi + minusDi;
  if (!(sum > 0)) {
    return 0;
  }
  return (100 * Math.abs(plusDi - minusDi)) / sum;
}

export interface BollingerSeries {
  mid: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
}

/**
 * Bollinger Bands: SMA mid ± stdDev × population standard deviation of the
 * last `period` closes. Returns nulls until warm (first value at index period-1).
 */
export function bollinger(values: number[], period: number, stdDev: number): BollingerSeries {
  if (period < 1) {
    throw new Error("Bollinger period must be >= 1");
  }
  if (!(stdDev > 0)) {
    throw new Error("Bollinger stdDev must be > 0");
  }

  const mid: (number | null)[] = Array.from({ length: values.length }, () => null);
  const upper: (number | null)[] = Array.from({ length: values.length }, () => null);
  const lower: (number | null)[] = Array.from({ length: values.length }, () => null);

  if (values.length < period) {
    return { mid, upper, lower };
  }

  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += values[j]!;
    }
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j]! - mean;
      sq += d * d;
    }
    const sd = Math.sqrt(sq / period);
    mid[i] = mean;
    upper[i] = mean + stdDev * sd;
    lower[i] = mean - stdDev * sd;
  }

  return { mid, upper, lower };
}
