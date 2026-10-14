import { candleIntervalSeconds, createCandle } from "../candle.js";
import type { Candle, FetchCandlesOptions, Market, PairConfig, Timeframe } from "../../types.js";

const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";
const PAGE_LIMIT = 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

/** Binance kline tuple. Index 5 is base-asset volume. */
type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

/**
 * Binance spot klines (`GET /api/v3/klines`).
 * `pair.symbol` `SOL/USDC` becomes `SOLUSDC`. No API key.
 */
export class BinanceMarket implements Market {
  readonly source = "binance" as const;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async fetchCandles(options: FetchCandlesOptions): Promise<Candle[]> {
    const { pair, timeframe } = options;
    const symbol = binanceSymbol(pair);
    const interval = timeframe;
    const intervalSeconds = candleIntervalSeconds(timeframe);
    const toTime = options.toTime ?? Math.floor(Date.now() / 1000);
    const fromTime = options.fromTime ?? toTime - intervalSeconds;
    const endMs = toTime * 1000 - 1;

    const byTime = new Map<number, Candle>();
    let startMs = fromTime * 1000;

    while (startMs <= endMs) {
      const batch = await this.fetchPage({
        symbol,
        pairSymbol: pair.symbol,
        interval,
        startTime: startMs,
        endTime: endMs,
      });
      if (batch.length === 0) {
        break;
      }

      for (const row of batch) {
        const candle = klineToCandle(row, timeframe);
        if (candle.time >= fromTime && candle.time < toTime) {
          byTime.set(candle.time, candle);
        }
      }

      const last = batch[batch.length - 1];
      if (last === undefined) {
        break;
      }
      const nextStartMs = (Math.floor(last[0] / 1000) + intervalSeconds) * 1000;
      if (nextStartMs <= startMs || batch.length < PAGE_LIMIT) {
        break;
      }
      startMs = nextStartMs;
    }

    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  private async fetchPage(args: {
    symbol: string;
    pairSymbol: string;
    interval: Timeframe;
    startTime: number;
    endTime: number;
  }): Promise<BinanceKline[]> {
    const url = new URL(BINANCE_KLINES);
    url.searchParams.set("symbol", args.symbol);
    url.searchParams.set("interval", args.interval);
    url.searchParams.set("startTime", String(args.startTime));
    url.searchParams.set("endTime", String(args.endTime));
    url.searchParams.set("limit", String(PAGE_LIMIT));

    let failStreak = 0;
    for (;;) {
      try {
        return await this.requestKlines(url, args.pairSymbol, args.symbol);
      } catch (err) {
        if (!isRetryable(err)) {
          throw err;
        }
        failStreak += 1;
        const delay = nextRetryDelayMs(failStreak);
        console.warn(
          `Binance klines failed (${err instanceof Error ? err.message : String(err)}); ` +
            `retry in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }

  private async requestKlines(
    url: URL,
    pairSymbol: string,
    symbol: string,
  ): Promise<BinanceKline[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `Binance klines request failed for ${pairSymbol}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (response.status === 429 || response.status >= 500) {
      throw new Error(`Binance klines failed (${response.status})`);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Binance has no klines for ${pairSymbol} (${symbol}) (${response.status}): ${body.slice(0, 200)}`,
      );
    }

    return (await response.json()) as BinanceKline[];
  }
}

function binanceSymbol(pair: PairConfig): string {
  const parts = pair.symbol.split("/");
  const base = parts[0];
  const quote = parts[1];
  if (!base || !quote || parts.length !== 2) {
    throw new Error(`Cannot map "${pair.symbol}" to a Binance symbol. Expected BASE/QUOTE.`);
  }
  return `${base}${quote}`;
}

function klineToCandle(row: BinanceKline, timeframe: Timeframe): Candle {
  return createCandle({
    time: Math.floor(row[0] / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    timeframe,
    source: "binance",
  });
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return true;
  }
  return (
    /Binance klines failed \((429|5\d\d)\)/.test(err.message) ||
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
