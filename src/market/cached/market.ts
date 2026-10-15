import {
  readCandles,
  readRangeBounds,
  upsertCandles,
  type CandleRangeBounds,
} from "../../db/candles.js";
import { candleIntervalSeconds } from "../candle.js";
import type { Candle, CandleSource, FetchCandlesOptions, Market } from "../../types.js";

/**
 * Read OHLCV from Timescale and fill gaps through an inner {@link Market}.
 * Each vendor is cached under its own `source`, so series do not overwrite each other.
 */
export class CachedMarket implements Market {
  readonly source: CandleSource;

  constructor(private readonly inner: Market) {
    this.source = inner.source;
  }

  async fetchCandles(options: FetchCandlesOptions): Promise<Candle[]> {
    const toTime = options.toTime ?? Math.floor(Date.now() / 1000);
    const fromTime = options.fromTime;
    if (fromTime === undefined) {
      throw new Error(
        `fetchCandles requires fromTime (${options.pair.symbol} ${options.timeframe})`,
      );
    }

    const { pair, timeframe } = options;
    const interval = candleIntervalSeconds(timeframe);
    const freshForSec = options.freshForSec ?? 0;

    for (;;) {
      const bounds = await readRangeBounds(
        this.source,
        pair.poolAddress,
        timeframe,
        fromTime,
        toTime,
      );
      const fetchWindows = missingWindows(bounds, fromTime, toTime, interval, freshForSec);
      if (fetchWindows.length === 0) {
        break;
      }

      const priorCount = bounds.count;
      const priorOldest = bounds.minTime;

      for (const window of fetchWindows) {
        console.log(
          `Fetching OHLCV ${this.source} ${timeframe} ${pair.symbol} ` +
            `[${new Date(window.from * 1000).toISOString()} → ${new Date(window.to * 1000).toISOString()}]`,
        );

        const page = await this.inner.fetchCandles({
          pair,
          timeframe,
          fromTime: window.from,
          toTime: window.to,
        });
        await upsertCandles(this.source, pair.poolAddress, timeframe, page);
      }

      const nextBounds = await readRangeBounds(
        this.source,
        pair.poolAddress,
        timeframe,
        fromTime,
        toTime,
      );
      const nextWindows = missingWindows(nextBounds, fromTime, toTime, interval, freshForSec);
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
            `${new Date(fromTime * 1000).toISOString()} → ${new Date(toTime * 1000).toISOString()} ` +
            `(have ${nextBounds.count} candles). Continuing with available data.`,
        );
        break;
      }
    }

    const result = await readCandles(this.source, pair.poolAddress, timeframe, fromTime, toTime);
    if (result.length === 0) {
      throw new Error(
        `No OHLCV candles available for ${pair.symbol} (${this.source} ${timeframe}) in the requested window`,
      );
    }
    return result;
  }
}

interface TimeWindow {
  from: number;
  to: number;
}

/**
 * Compute fetch windows for gaps relative to `[fromTime, toTime)`.
 * If cache is empty, returns a single full window.
 *
 * `freshForSec` shortens only the still-open tail: the cache is enough when it
 * already reaches `max(last closed bar, toTime - freshForSec)`. A closed bar
 * that was stored while it was still forming is fetched again from its open.
 */
function missingWindows(
  bounds: CandleRangeBounds,
  fromTime: number,
  toTime: number,
  intervalSeconds: number,
  freshForSec: number,
): TimeWindow[] {
  if (bounds.count === 0 || bounds.minTime === undefined || bounds.maxTime === undefined) {
    return [{ from: fromTime, to: toTime }];
  }

  const windows: TimeWindow[] = [];

  if (bounds.minTime > fromTime + intervalSeconds) {
    windows.push({ from: fromTime, to: bounds.minTime });
  }

  const coverageEnd = bounds.maxTime + intervalSeconds;
  const closedCoverageEnd = toTime - (toTime % intervalSeconds);
  const requiredEnd = Math.max(closedCoverageEnd, toTime - freshForSec);
  const closed = coverageEnd <= toTime;
  const finalized = bounds.newestFetchedAt !== undefined && bounds.newestFetchedAt >= coverageEnd;

  if (closed && !finalized) {
    windows.push({ from: bounds.maxTime, to: toTime });
  } else if (coverageEnd < requiredEnd) {
    windows.push({ from: coverageEnd, to: toTime });
  }

  return windows;
}
