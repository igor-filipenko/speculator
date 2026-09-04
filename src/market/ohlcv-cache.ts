import {
  deleteCandles,
  readCandles,
  readRangeBounds,
  upsertCandles,
  type CandleRangeBounds,
} from "../db/candles.js";
import type { Candle, Timeframe } from "../types.js";
import { candleIntervalSeconds, fetchCandlesRange } from "./gecko-terminal.js";

export interface LoadCachedCandlesOptions {
  /** Pair symbol used in log lines (e.g. SOL/USDC). */
  symbol: string;
  /** GeckoTerminal pool address used as the cache key and for live OHLCV fetches. */
  poolAddress: string;
  timeframe: Timeframe;
  /** Inclusive lower bound (Unix seconds) for the series returned to the caller. */
  fromTime: number;
  /** Exclusive upper bound (Unix seconds). Defaults to now. */
  toTime?: number;
  /** Ignore cache and refetch the full window. */
  forceRefresh?: boolean;
}

/**
 * Load OHLCV from Timescale, fetch any missing range from GeckoTerminal, upsert incrementally,
 * and return candles in `[fromTime, toTime)`.
 */
export async function loadCachedCandles(options: LoadCachedCandlesOptions): Promise<Candle[]> {
  const toTime = options.toTime ?? Math.floor(Date.now() / 1000);
  const { symbol, poolAddress, timeframe } = options;

  if (options.forceRefresh) {
    await deleteCandles(poolAddress, timeframe);
  }

  const interval = candleIntervalSeconds(timeframe);

  for (;;) {
    const bounds = await readRangeBounds(poolAddress, timeframe, options.fromTime, toTime);
    const fetchWindows = missingWindows(bounds, options.fromTime, toTime, interval);
    if (fetchWindows.length === 0) {
      break;
    }

    const priorCount = bounds.count;
    const priorOldest = bounds.minTime;

    for (const window of fetchWindows) {
      console.log(
        `Fetching OHLCV ${timeframe} ${symbol} ` +
          `[${new Date(window.from * 1000).toISOString()} → ${new Date(window.to * 1000).toISOString()}]`,
      );

      await fetchCandlesRange({
        poolAddress,
        timeframe,
        fromTime: window.from,
        toTime: window.to,
        onPage: async (pageCandles) => {
          await upsertCandles(poolAddress, timeframe, pageCandles);
        },
      });
    }

    const nextBounds = await readRangeBounds(poolAddress, timeframe, options.fromTime, toTime);
    const nextWindows = missingWindows(nextBounds, options.fromTime, toTime, interval);
    if (nextWindows.length === 0) {
      break;
    }

    const grew = nextBounds.count > priorCount;
    const extendedOlder =
      nextBounds.minTime !== undefined &&
      (priorOldest === undefined || nextBounds.minTime < priorOldest);
    if (!grew && !extendedOlder) {
      console.warn(
        `OHLCV history exhausted before covering ` +
          `${new Date(options.fromTime * 1000).toISOString()} → ${new Date(toTime * 1000).toISOString()} ` +
          `(have ${nextBounds.count} candles). Continuing with available data.`,
      );
      break;
    }
  }

  const result = await readCandles(poolAddress, timeframe, options.fromTime, toTime);
  if (result.length === 0) {
    throw new Error(
      `No OHLCV candles available for ${symbol} (${timeframe}) in the requested window`,
    );
  }
  return result;
}

interface TimeWindow {
  from: number;
  to: number;
}

/**
 * Compute fetch windows for gaps relative to `[fromTime, toTime)`.
 * If cache is empty, returns a single full window.
 */
function missingWindows(
  bounds: CandleRangeBounds,
  fromTime: number,
  toTime: number,
  intervalSeconds: number,
): TimeWindow[] {
  if (bounds.count === 0 || bounds.minTime === undefined || bounds.maxTime === undefined) {
    return [{ from: fromTime, to: toTime }];
  }

  const windows: TimeWindow[] = [];

  if (bounds.minTime > fromTime + intervalSeconds) {
    windows.push({ from: fromTime, to: bounds.minTime });
  }

  if (bounds.maxTime + intervalSeconds < toTime) {
    windows.push({ from: bounds.maxTime + intervalSeconds, to: toTime });
  }

  return windows;
}
