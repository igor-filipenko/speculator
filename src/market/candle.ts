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
  }
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
