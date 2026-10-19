import { createCandle } from "../candle.js";
import type { Candle, FetchCandlesOptions, Market, Timeframe } from "../../types.js";

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
    case "1h":
      return { path: "hour", aggregate: 1 };
    case "15m":
      return { path: "minute", aggregate: 15 };
    case "5m":
      return { path: "minute", aggregate: 5 };
    case "1m":
      return { path: "minute", aggregate: 1 };
  }
}

/**
 * GeckoTerminal OHLCV for a Solana pool.
 * Candles are returned oldest → newest for `[fromTime, toTime)`.
 */
export class GeckoTerminalMarket implements Market {
  readonly source = "gecko-terminal" as const;

  async fetchCandles(options: FetchCandlesOptions): Promise<Candle[]> {
    const { pair, timeframe } = options;
    const fromTime = options.fromTime;
    const toTime = options.toTime ?? Math.floor(Date.now() / 1000);
    const maxPages = defaultMaxPages(timeframe);

    const byTime = new Map<number, Candle>();
    let before = toTime;
    let timeoutMs = INITIAL_TIMEOUT_MS;
    let failStreak = 0;

    for (let page = 0; page < maxPages; page++) {
      const batch = await fetchCandlesPageForever({
        poolAddress: pair.poolAddress,
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
    candles = candles.filter((c) => c.time < toTime);
    return candles;
  }
}

/** 1m windows need more pages (100 bars/page ≈ 1.7h; 500 pages ≈ 35 days). */
function defaultMaxPages(timeframe: Timeframe): number {
  switch (timeframe) {
    case "1m":
      return 500;
    case "5m":
      return 150;
    case "15m":
      return 80;
    case "1h":
    case "4h":
    case "1d":
      return 80;
  }
}

async function fetchPage(args: {
  poolAddress: string;
  timeframe: Timeframe;
  limit: number;
  beforeTimestamp: number;
  timeoutMs: number;
}): Promise<Candle[]> {
  const { path, aggregate } = geckoTimeframe(args.timeframe);
  const cappedLimit = Math.min(Math.max(1, args.limit), PAGE_LIMIT);

  const url = new URL(`${GECKO_BASE}/networks/solana/pools/${args.poolAddress}/ohlcv/${path}`);
  url.searchParams.set("aggregate", String(aggregate));
  url.searchParams.set("limit", String(cappedLimit));
  url.searchParams.set("currency", "usd");
  url.searchParams.set("before_timestamp", String(args.beforeTimestamp));

  const json = await fetchOhlcvJson(url, args.timeoutMs);
  const rows = json.data?.attributes?.ohlcv_list ?? [];

  // API returns newest first and can repeat a timestamp within a page; keep last, sort oldest→newest.
  const byTime = new Map<number, Candle>();
  for (const [time, open, high, low, close, volume] of rows) {
    byTime.set(
      time,
      createCandle({
        time,
        open,
        high,
        low,
        close,
        volume,
        timeframe: args.timeframe,
        source: "gecko-terminal",
      }),
    );
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
      const batch = await fetchPage({
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
