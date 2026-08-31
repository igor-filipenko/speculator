import type { Candle, Timeframe } from "../types.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
/** Gecko often stalls on very large `limit` values; page in smaller chunks. */
const PAGE_LIMIT = 100;
const PAGE_GAP_MS = 3_000;

const INITIAL_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 120_000;
const INITIAL_RETRY_DELAY_MS = 3_000;
const MAX_RETRY_DELAY_MS = 60_000;

interface GeckoOhlcvJson {
  data?: {
    attributes?: {
      ohlcv_list?: [number, number, number, number, number, number][];
    };
  };
}

/** Map OHLCV timeframe to GeckoTerminal path + aggregate. */
function geckoTimeframe(timeframe: Timeframe): {
  path: "minute" | "hour" | "day";
  aggregate: number;
} {
  switch (timeframe) {
    case "1d":
      return { path: "day", aggregate: 1 };
    case "4h":
      return { path: "hour", aggregate: 4 };
    case "15m":
      return { path: "minute", aggregate: 15 };
  }
}

/** Seconds per candle for the timeframe. */
export function candleIntervalSeconds(timeframe: Timeframe): number {
  switch (timeframe) {
    case "1d":
      return 24 * 60 * 60;
    case "4h":
      return 4 * 60 * 60;
    case "15m":
      return 15 * 60;
  }
}

export interface FetchCandlesOptions {
  poolAddress: string;
  timeframe: Timeframe;
  /** Number of candles to request (capped; Gecko stalls on large pages). */
  limit?: number;
  /** Return candles with open time strictly before this Unix timestamp (seconds). */
  beforeTimestamp?: number;
  /** Per-request abort timeout in ms (default {@link INITIAL_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * Fetch OHLCV candles for a Solana pool from GeckoTerminal.
 * Candles are returned oldest → newest.
 */
export async function fetchCandles(options: FetchCandlesOptions): Promise<Candle[]> {
  const { poolAddress, timeframe, limit = 200, beforeTimestamp, timeoutMs } = options;
  const { path, aggregate } = geckoTimeframe(timeframe);
  const cappedLimit = Math.min(Math.max(1, limit), PAGE_LIMIT);

  const url = new URL(`${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${path}`);
  url.searchParams.set("aggregate", String(aggregate));
  url.searchParams.set("limit", String(cappedLimit));
  url.searchParams.set("currency", "usd");
  if (beforeTimestamp !== undefined) {
    url.searchParams.set("before_timestamp", String(beforeTimestamp));
  }

  const json = await fetchOhlcvJson(url, timeoutMs ?? INITIAL_TIMEOUT_MS);
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
  timeframe: Timeframe;
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
 * Each page is retried forever on transient failures with an increasing request timeout.
 * Candles are returned oldest → newest, deduped by `time`.
 */
export async function fetchCandlesRange(options: FetchCandlesRangeOptions): Promise<Candle[]> {
  const { poolAddress, timeframe, fromTime, maxPages = 80, onPage } = options;
  const toTime = options.toTime ?? Math.floor(Date.now() / 1000);

  const byTime = new Map<number, Candle>();
  let before = toTime;
  let timeoutMs = INITIAL_TIMEOUT_MS;
  let failStreak = 0;

  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchCandlesPageForever({
      poolAddress,
      timeframe,
      limit: PAGE_LIMIT,
      beforeTimestamp: before,
      getTimeoutMs: () => timeoutMs,
      onTransientFailure: async (err) => {
        failStreak += 1;
        timeoutMs = nextTimeoutMs(timeoutMs);
        const delay = nextRetryDelayMs(failStreak);
        console.warn(
          `GeckoTerminal page failed (${err instanceof Error ? err.message : String(err)}); ` +
            `retry in ${delay}ms (timeout=${timeoutMs}ms)`,
        );
        await sleep(delay);
      },
      onSuccess: () => {
        failStreak = 0;
        timeoutMs = INITIAL_TIMEOUT_MS;
      },
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

async function fetchCandlesPageForever(args: {
  poolAddress: string;
  timeframe: Timeframe;
  limit: number;
  beforeTimestamp: number;
  getTimeoutMs: () => number;
  onTransientFailure: (err: unknown) => Promise<void>;
  onSuccess: () => void;
}): Promise<Candle[]> {
  for (;;) {
    try {
      const batch = await fetchCandles({
        poolAddress: args.poolAddress,
        timeframe: args.timeframe,
        limit: args.limit,
        beforeTimestamp: args.beforeTimestamp,
        timeoutMs: args.getTimeoutMs(),
      });
      args.onSuccess();
      return batch;
    } catch (err) {
      if (!isRetryableFetchError(err)) {
        throw err;
      }
      await args.onTransientFailure(err);
    }
  }
}

function isRetryableFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return true;
  }
  const message = err.message;
  // Permanent client errors from Gecko (except rate limit).
  const clientErr = /GeckoTerminal OHLCV failed \((4\d\d)\)/.exec(message);
  if (clientErr) {
    const code = Number(clientErr[1]);
    return code === 429;
  }
  return true;
}

function nextTimeoutMs(current: number): number {
  return Math.min(Math.round(current * 1.5), MAX_TIMEOUT_MS);
}

function nextRetryDelayMs(failStreak: number): number {
  const exp = Math.min(Math.max(failStreak - 1, 0), 6);
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** exp, MAX_RETRY_DELAY_MS);
}

async function fetchOhlcvJson(url: URL, timeoutMs: number): Promise<GeckoOhlcvJson> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(
      `GeckoTerminal OHLCV request failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (response.status === 429) {
    throw new Error("GeckoTerminal rate limit (429)");
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GeckoTerminal OHLCV failed (${response.status}): ${body.slice(0, 200)}`);
  }

  return (await response.json()) as GeckoOhlcvJson;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
