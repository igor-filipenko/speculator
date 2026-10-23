import {
  readCandles,
  readCloseBefore,
  readInteriorGaps,
  readRangeBounds,
  upsertCandles,
  type CandleRangeBounds,
} from "../../db/candles.js";
import { candleIntervalSeconds, createCandle, expectedCandleCount } from "../candle.js";
import type { Candle, CandleSource, FetchCandlesOptions, Market, Timeframe } from "../../types.js";

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

    if (options.tryUseCache) {
      const expected = expectedCandleCount(fromTime, toTime, interval);
      const cached = await readCandles(this.source, pair.poolAddress, timeframe, fromTime, toTime);
      if (expected > 0 && cached.length === expected) {
        return cached;
      }
    }

    for (;;) {
      const bounds = await readRangeBounds(
        this.source,
        pair.poolAddress,
        timeframe,
        fromTime,
        toTime,
      );
      const fetchWindows = await windowsToFill(
        this.source,
        pair.poolAddress,
        timeframe,
        bounds,
        fromTime,
        toTime,
        interval,
      );
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
        const candlesWithGaps = fillMissingCandles(
          page,
          timeframe,
          window.from,
          window.to,
          window.fromPrice,
        );
        const inserted = await upsertCandles(
          this.source,
          pair.poolAddress,
          timeframe,
          candlesWithGaps,
        );
        console.log(`Inserted ${inserted} candles from fetched ${page.length}`);
      }

      const nextBounds = await readRangeBounds(
        this.source,
        pair.poolAddress,
        timeframe,
        fromTime,
        toTime,
      );
      const nextWindows = await windowsToFill(
        this.source,
        pair.poolAddress,
        timeframe,
        nextBounds,
        fromTime,
        toTime,
        interval,
      );
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

/** Flat bars may run forward to the window end, but not past this far ahead of now. */
const FILL_AHEAD_LIMIT_SECONDS = 24 * 60 * 60;

/**
 * Insert a flat bar for every missing open from `fromTime` through `untilTime`.
 * A leading gap uses `fromPrice` (the last close stored before `fromTime`).
 * The forward run stops at `nowSeconds + 24h` when that is earlier.
 * OHLC is the previous close and volume is 0.
 */
export function fillMissingCandles(
  candles: Candle[],
  timeframe: Timeframe,
  fromTime: number,
  untilTime: number,
  fromPrice?: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Candle[] {
  const step = candleIntervalSeconds(timeframe);
  const end = Math.min(untilTime, nowSeconds + FILL_AHEAD_LIMIT_SECONDS);
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const filled: Candle[] = [];
  const first = sorted[0];
  if (fromPrice !== undefined && (first === undefined || first.time > fromTime)) {
    const seed = createCandle({
      time: fromTime - step,
      open: fromPrice,
      high: fromPrice,
      low: fromPrice,
      close: fromPrice,
      volume: 0,
      timeframe,
      ...(first !== undefined ? { source: first.source } : {}),
    });
    const leadUntil = first === undefined ? end : Math.min(first.time, end);
    appendFlat(filled, seed, fromTime, leadUntil, step, timeframe);
  }
  for (const candle of sorted) {
    const prev = filled.at(-1);
    if (prev !== undefined && candle.time > prev.time + step) {
      appendFlat(filled, prev, prev.time + step, Math.min(candle.time, end), step, timeframe);
    }
    if (candle.time === prev?.time) {
      filled[filled.length - 1] = candle;
      continue;
    }
    filled.push(candle);
  }
  const last = filled.at(-1);
  if (last !== undefined) {
    appendFlat(filled, last, last.time + step, end, step, timeframe);
  }
  return filled;
}

function appendFlat(
  filled: Candle[],
  prev: Candle,
  fromTime: number,
  untilTime: number,
  step: number,
  timeframe: Timeframe,
): void {
  for (let time = fromTime; time < untilTime; time += step) {
    filled.push(
      createCandle({
        time,
        open: prev.close,
        high: prev.close,
        low: prev.close,
        close: prev.close,
        volume: 0,
        timeframe,
        source: prev.source,
      }),
    );
  }
}

/** Edge holes plus any skip between two stored bars. */
async function windowsToFill(
  source: CandleSource,
  poolAddress: string,
  timeframe: FetchCandlesOptions["timeframe"],
  bounds: CandleRangeBounds,
  fromTime: number,
  toTime: number,
  intervalSeconds: number,
): Promise<TimeWindow[]> {
  const edges = missingWindows(bounds, fromTime, toTime, intervalSeconds);
  if (bounds.count >= expectedCandleCount(fromTime, toTime, intervalSeconds)) {
    return attachFromPrices(source, poolAddress, timeframe, edges);
  }
  const interior = await readInteriorGaps(
    source,
    poolAddress,
    timeframe,
    fromTime,
    toTime,
    intervalSeconds,
  );
  const windows = [...edges, ...interior].sort((a, b) => a.from - b.from);
  return attachFromPrices(source, poolAddress, timeframe, windows);
}

async function attachFromPrices(
  source: CandleSource,
  poolAddress: string,
  timeframe: FetchCandlesOptions["timeframe"],
  windows: TimeWindow[],
): Promise<TimeWindow[]> {
  const priced: TimeWindow[] = [];
  for (const window of windows) {
    const fromPrice = await readCloseBefore(source, poolAddress, timeframe, window.from);
    priced.push(fromPrice === undefined ? window : { ...window, fromPrice });
  }
  return priced;
}

interface TimeWindow {
  from: number;
  to: number;
  /** Close of the latest stored bar before `from`, when the database has one. */
  fromPrice?: number;
}

/**
 * Edge windows only. An interior hole between the oldest and newest stored bar
 * is invisible here; {@link readInteriorGaps} supplies those.
 * A closed bar that was stored while it was still forming is fetched again from its open.
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

  const coverageEnd = bounds.maxTime + intervalSeconds;
  const closed = coverageEnd <= toTime;
  const finalized = bounds.newestFetchedAt !== undefined && bounds.newestFetchedAt >= coverageEnd;

  if (closed && !finalized) {
    windows.push({ from: bounds.maxTime, to: toTime });
  } else if (coverageEnd < toTime) {
    windows.push({ from: coverageEnd, to: toTime });
  }

  return windows;
}
