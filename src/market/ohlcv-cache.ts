import { join } from "node:path";
import {
  deleteCandles,
  readCandles,
  readRangeBounds,
  upsertCandles,
  type CandleRangeBounds,
} from "../db/candles.js";
import { defaultDataDir } from "../db/speculator-db.js";
import type { Candle, StrategyParams } from "../types.js";
import { candleIntervalSeconds, fetchCandlesRange } from "./gecko-terminal.js";

export interface LoadCachedCandlesOptions {
  /** Pair symbol used as the DuckDB cache key (e.g. SOL/USDC). */
  symbol: string;
  /** GeckoTerminal pool address used for live OHLCV fetches. */
  poolAddress: string;
  timeframe: StrategyParams["timeframe"];
  /** Inclusive lower bound (Unix seconds) for the series returned to the caller. */
  fromTime: number;
  /** Exclusive upper bound (Unix seconds). Defaults to now. */
  toTime?: number;
  /** Directory containing `speculator.duckdb` (default: `data/` under cwd). */
  dataDir?: string;
  /** @deprecated Use `dataDir`. */
  cacheDir?: string;
  /** Ignore disk cache and refetch the full window. */
  forceRefresh?: boolean;
}

/**
 * Load OHLCV from DuckDB, fetch any missing range from GeckoTerminal, upsert incrementally,
 * and return candles in `[fromTime, toTime)`.
 */
export async function loadCachedCandles(options: LoadCachedCandlesOptions): Promise<Candle[]> {
  const dataDir = resolveDataDir(options);
  const toTime = options.toTime ?? Math.floor(Date.now() / 1000);
  const { symbol, poolAddress, timeframe } = options;

  if (options.forceRefresh) {
    await deleteCandles(symbol, timeframe, dataDir);
  }

  const interval = candleIntervalSeconds(timeframe);

  // Recompute gaps after each full pass. Stop when covered, or when Gecko has no more history.
  for (;;) {
    const bounds = await readRangeBounds(symbol, timeframe, options.fromTime, toTime, dataDir);
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
          await upsertCandles(symbol, timeframe, pageCandles, dataDir);
        },
      });
    }

    const nextBounds = await readRangeBounds(symbol, timeframe, options.fromTime, toTime, dataDir);
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

  const result = await readCandles(symbol, timeframe, options.fromTime, toTime, dataDir);
  if (result.length === 0) {
    throw new Error(
      `No OHLCV candles available for ${symbol} (${timeframe}) in the requested window`,
    );
  }
  return result;
}

function resolveDataDir(options: LoadCachedCandlesOptions): string {
  if (options.dataDir !== undefined) {
    return options.dataDir;
  }
  if (options.cacheDir !== undefined) {
    return join(options.cacheDir, "..");
  }
  return defaultDataDir();
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
