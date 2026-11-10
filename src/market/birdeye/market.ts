import { candleIntervalSeconds, createCandle } from "../candle.js";
import type { Candle, FetchCandlesOptions, Market, Timeframe } from "../../types.js";

const BIRDEYE_OHLCV_PAIR = "https://public-api.birdeye.so/defi/v3/ohlcv/pair";
/** OHLCV v3 returns at most this many candles per request. */
const PAGE_LIMIT = 5000;
const REQUEST_TIMEOUT_MS = 15_000;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

interface BirdeyeCandleItem {
  unix_time?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  /** Base-token volume. `v_usd` is quote volume and is not stored. */
  v?: number;
}

interface BirdeyeOhlcvJson {
  success?: boolean;
  data?: {
    items?: BirdeyeCandleItem[];
  };
}

/**
 * Birdeye pair OHLCV (`GET /defi/v3/ohlcv/pair`) for a Solana pool.
 * `pair.poolAddress` is the pair address. Requires `BIRDEYE_API_KEY`.
 */
export class BirdeyeMarket implements Market {
  readonly source = "birdeye" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchCandles(options: FetchCandlesOptions): Promise<Candle[]> {
    if (!this.apiKey) {
      throw new Error("BIRDEYE_API_KEY is required for Birdeye OHLCV");
    }

    const { pair, timeframe } = options;
    const intervalSeconds = candleIntervalSeconds(timeframe);
    const toTime = options.toTime ?? Math.floor(Date.now() / 1000);
    const fromTime = options.fromTime ?? toTime - intervalSeconds;
    const type = birdeyeType(timeframe);

    const byTime = new Map<number, Candle>();
    let cursor = fromTime;

    while (cursor < toTime) {
      const batch = await this.fetchPage({
        poolAddress: pair.poolAddress,
        pairSymbol: pair.symbol,
        type,
        timeFrom: cursor,
      });
      if (batch.length === 0) {
        break;
      }

      let newest = Number.NEGATIVE_INFINITY;
      for (const item of batch) {
        const candle = itemToCandle(item, timeframe);
        if (candle === undefined) {
          continue;
        }
        if (candle.time > newest) {
          newest = candle.time;
        }
        if (candle.time >= fromTime && candle.time < toTime) {
          byTime.set(candle.time, candle);
        }
      }

      const next = newest + intervalSeconds;
      if (
        !Number.isFinite(newest) ||
        next <= cursor ||
        batch.length < PAGE_LIMIT ||
        next >= toTime
      ) {
        break;
      }
      cursor = next;
    }

    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  private async fetchPage(args: {
    poolAddress: string;
    pairSymbol: string;
    type: string;
    timeFrom: number;
  }): Promise<BirdeyeCandleItem[]> {
    const url = new URL(BIRDEYE_OHLCV_PAIR);
    url.searchParams.set("address", args.poolAddress);
    url.searchParams.set("type", args.type);
    url.searchParams.set("mode", "count");
    url.searchParams.set("time_from", String(args.timeFrom));
    url.searchParams.set("count_limit", String(PAGE_LIMIT));

    let failStreak = 0;
    for (;;) {
      try {
        return await this.requestCandles(url, args.pairSymbol);
      } catch (err) {
        if (!isRetryable(err)) {
          throw err;
        }
        failStreak += 1;
        const delay = nextRetryDelayMs(failStreak);
        console.warn(
          `Birdeye OHLCV failed (${err instanceof Error ? err.message : String(err)}); ` +
            `retry in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }

  private async requestCandles(url: URL, pairSymbol: string): Promise<BirdeyeCandleItem[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "X-API-KEY": this.apiKey,
          "x-chain": "solana",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `Birdeye OHLCV request failed for ${pairSymbol}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (response.status === 429 || response.status >= 500) {
      throw new Error(`Birdeye OHLCV failed (${response.status})`);
    }

    if (!response.ok) {
      throw new Error(`Birdeye OHLCV failed for ${pairSymbol} (${response.status})`);
    }

    const json = (await response.json()) as BirdeyeOhlcvJson;
    if (json.success === false) {
      throw new Error(`Birdeye OHLCV failed for ${pairSymbol} (unsuccessful response)`);
    }
    return json.data?.items ?? [];
  }
}

/** Birdeye v3 interval names. Hours and days are uppercase. */
function birdeyeType(timeframe: Timeframe): string {
  switch (timeframe) {
    case "1d":
      return "1D";
    case "4h":
      return "4H";
    case "1h":
      return "1H";
    case "15m":
      return "15m";
    case "5m":
      return "5m";
    case "1m":
      return "1m";
  }
}

function itemToCandle(item: BirdeyeCandleItem, timeframe: Timeframe): Candle | undefined {
  const time = Number(item.unix_time);
  const open = Number(item.o);
  const high = Number(item.h);
  const low = Number(item.l);
  const close = Number(item.c);
  const volume = Number(item.v);
  if (![time, open, high, low, close, volume].every(Number.isFinite)) {
    return undefined;
  }
  return createCandle({
    time,
    open,
    high,
    low,
    close,
    volume,
    timeframe,
    source: "birdeye",
  });
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return true;
  }
  return (
    /Birdeye OHLCV failed \((429|5\d\d)\)/.test(err.message) ||
    err.message.includes("request failed")
  );
}

function nextRetryDelayMs(failStreak: number): number {
  const exp = Math.min(Math.max(failStreak - 1, 0), 6);
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** exp, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
