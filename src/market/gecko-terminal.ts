import type { Candle, StrategyParams } from "../types.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
/** Gecko often stalls on very large `limit` values; page in smaller chunks. */
const PAGE_LIMIT = 100;
const FETCH_RETRIES = 5;
const RETRY_BASE_MS = 4_000;
const FETCH_TIMEOUT_MS = 12_000;
const PAGE_GAP_MS = 2_500;

interface GeckoOhlcvResponse {
  data?: {
    attributes?: {
      ohlcv_list?: [number, number, number, number, number, number][];
    };
  };
}

/** Map strategy timeframe to GeckoTerminal path + aggregate. */
function geckoTimeframe(timeframe: StrategyParams["timeframe"]): {
  path: "minute" | "hour";
  aggregate: number;
} {
  if (timeframe === "4h") {
    return { path: "hour", aggregate: 4 };
  }
  return { path: "minute", aggregate: 15 };
}

/** Seconds per candle for the strategy timeframe. */
export function candleIntervalSeconds(timeframe: StrategyParams["timeframe"]): number {
  if (timeframe === "4h") {
    return 4 * 60 * 60;
  }
  return 15 * 60;
}

export interface FetchCandlesOptions {
  poolAddress: string;
  timeframe: StrategyParams["timeframe"];
  /** Number of candles to request (capped; Gecko stalls on large pages). */
  limit?: number;
  /** Return candles with open time strictly before this Unix timestamp (seconds). */
  beforeTimestamp?: number;
}

/**
 * Fetch OHLCV candles for a Solana pool from GeckoTerminal.
 * Candles are returned oldest → newest.
 */
export async function fetchCandles(options: FetchCandlesOptions): Promise<Candle[]> {
  const { poolAddress, timeframe, limit = 200, beforeTimestamp } = options;
  const { path, aggregate } = geckoTimeframe(timeframe);
  const cappedLimit = Math.min(Math.max(1, limit), PAGE_LIMIT);

  const url = new URL(`${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${path}`);
  url.searchParams.set("aggregate", String(aggregate));
  url.searchParams.set("limit", String(cappedLimit));
  url.searchParams.set("currency", "usd");
  if (beforeTimestamp !== undefined) {
    url.searchParams.set("before_timestamp", String(beforeTimestamp));
  }

  const json = await fetchOhlcvJson(url);
  const rows = json.data?.attributes?.ohlcv_list ?? [];

  // API returns newest first; normalize to chronological order.
  const candles: Candle[] = rows
    .map(([time, open, high, low, close, volume]) => ({
      time,
      open,
      high,
      low,
      close,
      volume,
    }))
    .sort((a, b) => a.time - b.time);

  // Live watch expects data; paginated range fetches tolerate empty pages.
  if (candles.length === 0 && beforeTimestamp === undefined) {
    throw new Error(`No OHLCV returned for pool ${poolAddress} (${timeframe})`);
  }

  return candles;
}

export interface FetchCandlesRangeOptions {
  poolAddress: string;
  timeframe: StrategyParams["timeframe"];
  /** Inclusive lower bound (Unix seconds). Defaults to unbounded past. */
  fromTime?: number;
  /** Exclusive upper bound for paging cursor (Unix seconds). Defaults to now. */
  toTime?: number;
  /** Max API pages to pull (each up to {@link PAGE_LIMIT} candles). */
  maxPages?: number;
  /** Called after each successful page with the merged series so far (oldest→newest). */
  onPage?: (candlesSoFar: Candle[]) => void | Promise<void>;
}

/**
 * Page backward with `before_timestamp` until `fromTime` is covered or pages run out.
 * Candles are returned oldest → newest, deduped by `time`.
 */
export async function fetchCandlesRange(options: FetchCandlesRangeOptions): Promise<Candle[]> {
  const { poolAddress, timeframe, fromTime, maxPages = 80, onPage } = options;
  const toTime = options.toTime ?? Math.floor(Date.now() / 1000);

  const byTime = new Map<number, Candle>();
  let before = toTime;

  try {
    for (let page = 0; page < maxPages; page++) {
      const batch = await fetchCandles({
        poolAddress,
        timeframe,
        limit: PAGE_LIMIT,
        beforeTimestamp: before,
      });

      if (batch.length === 0) {
        break;
      }

      const sizeBefore = byTime.size;
      for (const c of batch) {
        byTime.set(c.time, c);
      }

      const oldest = batch[0];
      const newest = batch[batch.length - 1];
      if (oldest === undefined || newest === undefined) {
        break;
      }

      console.log(
        `  OHLCV page ${page + 1}: ${batch.length} bars ` +
          `(${new Date(oldest.time * 1000).toISOString()} → ${new Date(newest.time * 1000).toISOString()}) ` +
          `total=${byTime.size}`,
      );

      const soFar = [...byTime.values()].sort((a, b) => a.time - b.time);
      if (onPage) {
        await onPage(soFar);
      }

      // No new bars (API returned an overlapping/identical page) — stop to avoid a loop.
      if (byTime.size === sizeBefore || oldest.time >= before) {
        break;
      }

      if (fromTime !== undefined && oldest.time <= fromTime) {
        break;
      }

      // `before_timestamp` includes the cursor candle; reuse oldest as next cursor.
      before = oldest.time;

      if (batch.length < PAGE_LIMIT) {
        break;
      }

      await sleep(PAGE_GAP_MS);
    }
  } catch (err) {
    // Persist whatever we collected so the next run can resume from cache.
    if (byTime.size > 0 && onPage) {
      const soFar = [...byTime.values()].sort((a, b) => a.time - b.time);
      await onPage(soFar);
    }
    throw err;
  }

  let candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (fromTime !== undefined) {
    candles = candles.filter((c) => c.time >= fromTime);
  }
  if (options.toTime !== undefined) {
    candles = candles.filter((c) => c.time < options.toTime!);
  }

  return candles;
}

/** Merge candle series by `time` (later values win), sorted oldest → newest. */
export function mergeCandles(...series: Candle[][]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const list of series) {
    for (const c of list) {
      byTime.set(c.time, c);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function fetchOhlcvJson(url: URL): Promise<GeckoOhlcvResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err;
      if (attempt === FETCH_RETRIES) {
        break;
      }
      const delay = RETRY_BASE_MS * 2 ** attempt;
      console.warn(
        `GeckoTerminal request failed (${err instanceof Error ? err.message : String(err)}); retry in ${delay}ms`,
      );
      await sleep(delay);
      continue;
    }

    if (response.status === 429) {
      lastError = new Error("GeckoTerminal rate limit (429)");
      if (attempt === FETCH_RETRIES) {
        break;
      }
      const delay = RETRY_BASE_MS * 2 ** attempt;
      console.warn(`GeckoTerminal rate limit (429); retry in ${delay}ms`);
      await sleep(delay);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GeckoTerminal OHLCV failed (${response.status}): ${body.slice(0, 200)}`);
    }

    return (await response.json()) as GeckoOhlcvResponse;
  }

  throw new Error(
    `GeckoTerminal OHLCV failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
