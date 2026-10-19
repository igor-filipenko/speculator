import type { Candle, CandleSource, Timeframe } from "../types.js";

/** Seconds per candle for the timeframe. */
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
