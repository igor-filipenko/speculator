import type { Candle, CandleSource, Timeframe } from "../types.js";

/** Seconds per candle for the timeframe. */
const TIMEFRAME_LABELS: readonly Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export function candleIntervalSeconds(timeframe: Timeframe): number {
  switch (timeframe) {
    case "1d":
      return 24 * 60 * 60;
    case "4h":
      return 4 * 60 * 60;
    case "1h":
      return 60 * 60;
    case "15m":
      return 15 * 60;
    case "5m":
      return 5 * 60;
    case "1m":
      return 60;
  }
}

/** Candle label for a search-axis `timeframe` stored in minutes. */
export function timeframeFromMinutes(minutes: number): Timeframe | undefined {
  return TIMEFRAME_LABELS.find((label) => candleIntervalSeconds(label) === minutes * 60);
}

/**
 * Aligned candle opens in `[fromTime, toTime)`.
 * A 1h window of 15m bars is 4 candles, whatever the phase inside the hour.
 */
export function expectedCandleCount(
  fromTime: number,
  toTime: number,
  intervalSeconds: number,
): number {
  if (toTime <= fromTime || intervalSeconds <= 0) {
    return 0;
  }
  const first = Math.ceil(fromTime / intervalSeconds) * intervalSeconds;
  if (first >= toTime) {
    return 0;
  }
  return Math.floor((toTime - 1 - first) / intervalSeconds) + 1;
}

export interface CreateCandleInput {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Signal fixtures default to the 15m work timeframe. */
  timeframe?: Timeframe;
  /** Rows and fixtures that omit a vendor are gecko-terminal. */
  source?: CandleSource;
}

/** Build a candle with `intervalSeconds` and {@link Candle.isClosed}. */
export function createCandle(input: CreateCandleInput): Candle {
  const timeframe = input.timeframe ?? "15m";
  const source = input.source ?? "gecko-terminal";
  const intervalSeconds = candleIntervalSeconds(timeframe);
  return {
    time: input.time,
    open: input.open,
    high: input.high,
    low: input.low,
    close: input.close,
    volume: input.volume,
    timeframe,
    intervalSeconds,
    source,
    isClosed(atSec: number): boolean {
      return atSec - this.time >= this.intervalSeconds;
    },
  };
}

/**
 * A 15m wick longer than this fraction of the body edge is treated as a bad
 * vendor print (for example a 200 high on a 92 SOL bar). Longer bars scale the
 * limit by the square root of their length: 1h doubles it, 4h quadruples it.
 */
export const MAX_WICK_FRACTION = 0.03;

const WICK_REFERENCE_SECONDS = 15 * 60;

/**
 * Cut vendor spikes. A high above `max(open, close) × (1 + limit)` becomes the
 * body top; a low below `min(open, close) × (1 − limit)` becomes the body bottom.
 * `limit` is {@link MAX_WICK_FRACTION} scaled to the candle length. Everything else is kept. Returns the repaired series
 * and how many bars were changed. Input candles are not mutated.
 */
export function sanitizeCandles(
  candles: readonly Candle[],
  maxWickFraction = MAX_WICK_FRACTION,
): { candles: Candle[]; repaired: number } {
  let repaired = 0;
  const out = candles.map((candle) => {
    const bodyTop = Math.max(candle.open, candle.close);
    const bodyBottom = Math.min(candle.open, candle.close);
    const limit = maxWickFraction * Math.sqrt(candle.intervalSeconds / WICK_REFERENCE_SECONDS);
    const badHigh = candle.high > bodyTop * (1 + limit);
    const badLow = candle.low < bodyBottom * (1 - limit);
    if (!badHigh && !badLow) return candle;
    repaired += 1;
    return createCandle({
      time: candle.time,
      open: candle.open,
      high: badHigh ? bodyTop : candle.high,
      low: badLow ? bodyBottom : candle.low,
      close: candle.close,
      volume: candle.volume,
      timeframe: candle.timeframe,
      source: candle.source,
    });
  });
  return { candles: out, repaired };
}

/**
 * True when unix `time` falls in the first 60 seconds of the candle that contains it.
 * Opens are aligned to multiples of `intervalSeconds` from the epoch.
 */
export function isCandleFirstMinute(time: number, intervalSeconds: number): boolean {
  if (intervalSeconds <= 0) {
    return false;
  }
  return time % intervalSeconds < 60;
}
