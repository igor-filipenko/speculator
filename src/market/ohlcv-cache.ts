import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Candle, StrategyParams } from "../types.js";
import { candleIntervalSeconds, fetchCandlesRange, mergeCandles } from "./gecko-terminal.js";

export interface OhlcvCacheFile {
  poolAddress: string;
  timeframe: StrategyParams["timeframe"];
  fetchedAt: string;
  candles: Candle[];
}

export interface LoadCachedCandlesOptions {
  poolAddress: string;
  timeframe: StrategyParams["timeframe"];
  /** Inclusive lower bound (Unix seconds) for the series returned to the caller. */
  fromTime: number;
  /** Exclusive upper bound (Unix seconds). Defaults to now. */
  toTime?: number;
  /** Directory for cache files (default: `data/ohlcv` under cwd). */
  cacheDir?: string;
  /** Ignore disk cache and refetch the full window. */
  forceRefresh?: boolean;
}

/**
 * Load OHLCV from disk cache, fetch any missing range from GeckoTerminal, rewrite cache,
 * and return candles in `[fromTime, toTime)`.
 */
export async function loadCachedCandles(options: LoadCachedCandlesOptions): Promise<Candle[]> {
  const toTime = options.toTime ?? Math.floor(Date.now() / 1000);
  const cacheDir = options.cacheDir ?? join(process.cwd(), "data", "ohlcv");
  const cachePath = join(cacheDir, `${options.poolAddress}-${options.timeframe}.json`);

  let cached: Candle[] = [];
  if (!options.forceRefresh) {
    const existing = await readCacheFile(cachePath);
    if (existing?.poolAddress === options.poolAddress && existing.timeframe === options.timeframe) {
      cached = existing.candles;
    }
  }

  const interval = candleIntervalSeconds(options.timeframe);
  const fetchWindows = missingWindows(cached, options.fromTime, toTime, interval);

  let merged = cached;
  const persist = async (extra: Candle[]): Promise<void> => {
    merged = mergeCandles(merged, extra);
    await writeCacheFile(cachePath, {
      poolAddress: options.poolAddress,
      timeframe: options.timeframe,
      fetchedAt: new Date().toISOString(),
      candles: merged,
    });
  };

  for (const window of fetchWindows) {
    console.log(
      `Fetching OHLCV ${options.timeframe} ${options.poolAddress.slice(0, 8)}… ` +
        `[${new Date(window.from * 1000).toISOString()} → ${new Date(window.to * 1000).toISOString()}]`,
    );
    try {
      const batch = await fetchCandlesRange({
        poolAddress: options.poolAddress,
        timeframe: options.timeframe,
        fromTime: window.from,
        toTime: window.to,
        onPage: persist,
      });
      merged = mergeCandles(merged, batch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `OHLCV fetch interrupted (${message}). Cached ${merged.length} candles; re-run to resume.`,
      );
      // Continue with whatever we have if the window is partially filled.
      break;
    }
  }

  if (fetchWindows.length > 0 || options.forceRefresh) {
    await writeCacheFile(cachePath, {
      poolAddress: options.poolAddress,
      timeframe: options.timeframe,
      fetchedAt: new Date().toISOString(),
      candles: merged,
    });
  }

  const result = merged.filter((c) => c.time >= options.fromTime && c.time < toTime);
  if (result.length === 0) {
    throw new Error(
      `No OHLCV candles available for ${options.poolAddress} (${options.timeframe}) in the requested window`,
    );
  }
  return result;
}

export function cacheFilePath(
  poolAddress: string,
  timeframe: StrategyParams["timeframe"],
  cacheDir = join(process.cwd(), "data", "ohlcv"),
): string {
  return join(cacheDir, `${poolAddress}-${timeframe}.json`);
}

async function readCacheFile(path: string): Promise<OhlcvCacheFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as OhlcvCacheFile;
    if (
      typeof parsed.poolAddress !== "string" ||
      typeof parsed.timeframe !== "string" ||
      !Array.isArray(parsed.candles)
    ) {
      return null;
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    console.warn(`Ignoring corrupt OHLCV cache at ${path}: ${String(err)}`);
    return null;
  }
}

async function writeCacheFile(path: string, data: OhlcvCacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
  cached: Candle[],
  fromTime: number,
  toTime: number,
  intervalSeconds: number,
): TimeWindow[] {
  if (cached.length === 0) {
    return [{ from: fromTime, to: toTime }];
  }

  const inRange = cached.filter((c) => c.time >= fromTime && c.time < toTime);
  if (inRange.length === 0) {
    return [{ from: fromTime, to: toTime }];
  }

  const windows: TimeWindow[] = [];
  const first = inRange[0]!;
  const last = inRange[inRange.length - 1]!;

  // Need history before the first cached bar in range.
  if (first.time > fromTime + intervalSeconds) {
    windows.push({ from: fromTime, to: first.time });
  }

  // Need bars after the last cached bar up to toTime.
  if (last.time + intervalSeconds < toTime) {
    windows.push({ from: last.time + intervalSeconds, to: toTime });
  }

  return windows;
}
