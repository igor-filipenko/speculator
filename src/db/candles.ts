import { createCandle } from "../market/candle.js";
import type { Candle, CandleSource, Timeframe } from "../types.js";
import { query, type SqlValue } from "./db.js";

export interface CandleRangeBounds {
  minTime?: number;
  maxTime?: number;
  /** `fetched_at` of the newest bar in the window (Unix seconds). */
  newestFetchedAt?: number;
  count: number;
}

interface CandleRow {
  time: string | number | bigint;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function asUnix(value: string | number | bigint): number {
  return Number(value);
}

export async function readCandles(
  source: CandleSource,
  poolAddress: string,
  timeframe: Timeframe,
  fromTime: number,
  toTime: number,
): Promise<Candle[]> {
  const rows = await query<CandleRow>(
    `
    SELECT
      EXTRACT(EPOCH FROM time)::BIGINT AS time,
      open, high, low, close, volume
    FROM market.candles
    WHERE source = $1
      AND pool_address = $2
      AND timeframe = $3
      AND time >= to_timestamp($4)
      AND time < to_timestamp($5)
    ORDER BY time
    `,
    [source, poolAddress, timeframe, fromTime, toTime],
  );
  return rows.map((row) =>
    createCandle({
      time: asUnix(row.time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      timeframe,
      source,
    }),
  );
}

export async function readRangeBounds(
  source: CandleSource,
  poolAddress: string,
  timeframe: Timeframe,
  fromTime: number,
  toTime: number,
): Promise<CandleRangeBounds> {
  const rows = await query<{
    min_time: string | number | bigint | null;
    max_time: string | number | bigint | null;
    newest_fetched_at: string | number | bigint | null;
    cnt: string | number | bigint;
  }>(
    `
    SELECT
      EXTRACT(EPOCH FROM min(time))::BIGINT AS min_time,
      EXTRACT(EPOCH FROM max(time))::BIGINT AS max_time,
      EXTRACT(EPOCH FROM (array_agg(fetched_at ORDER BY time DESC))[1])::BIGINT AS newest_fetched_at,
      count(*)::BIGINT AS cnt
    FROM market.candles
    WHERE source = $1
      AND pool_address = $2
      AND timeframe = $3
      AND time >= to_timestamp($4)
      AND time < to_timestamp($5)
    `,
    [source, poolAddress, timeframe, fromTime, toTime],
  );
  const row = rows[0];
  if (!row || Number(row.cnt) === 0) {
    return { count: 0 };
  }
  const bounds: CandleRangeBounds = { count: Number(row.cnt) };
  if (row.min_time != null) {
    bounds.minTime = asUnix(row.min_time);
  }
  if (row.max_time != null) {
    bounds.maxTime = asUnix(row.max_time);
  }
  if (row.newest_fetched_at != null) {
    bounds.newestFetchedAt = asUnix(row.newest_fetched_at);
  }
  return bounds;
}

/** PostgreSQL bind protocol rejects a statement with more than 65535 parameters. */
const MAX_BIND_PARAMS = 65_535;
const CANDLE_UPSERT_COLUMNS = 9;
const UPSERT_BATCH_SIZE = Math.floor(MAX_BIND_PARAMS / CANDLE_UPSERT_COLUMNS);

function valuesPlaceholders(rowCount: number, columnCount: number): string {
  const rows: string[] = [];
  let n = 1;
  for (let i = 0; i < rowCount; i++) {
    const cols: string[] = [];
    for (let j = 0; j < columnCount; j++) {
      cols.push(`$${n++}`);
    }
    rows.push(`(${cols.join(", ")})`);
  }
  return rows.join(", ");
}

export async function upsertCandles(
  source: CandleSource,
  poolAddress: string,
  timeframe: Timeframe,
  candles: Candle[],
): Promise<void> {
  if (candles.length === 0) {
    return;
  }
  // Postgres rejects INSERT … ON CONFLICT when the same conflict key appears twice in one statement.
  // Gecko pages can include duplicate timestamps (100 bars → 99 unique).
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    byTime.set(c.time, c);
  }
  const unique = [...byTime.values()];

  for (let i = 0; i < unique.length; i += UPSERT_BATCH_SIZE) {
    const batch = unique.slice(i, i + UPSERT_BATCH_SIZE);
    const values: SqlValue[] = [];
    for (const c of batch) {
      values.push(
        source,
        poolAddress,
        timeframe,
        new Date(c.time * 1000),
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume,
      );
    }
    await query(
      `
      INSERT INTO market.candles (source, pool_address, timeframe, time, open, high, low, close, volume)
      VALUES ${valuesPlaceholders(batch.length, CANDLE_UPSERT_COLUMNS)}
      ON CONFLICT (source, pool_address, timeframe, time) DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume,
        fetched_at = now()
      `,
      values,
    );
  }
}

export async function deleteCandles(
  source: CandleSource,
  poolAddress: string,
  timeframe: Timeframe,
): Promise<void> {
  await query(
    `
    DELETE FROM market.candles
    WHERE source = $1 AND pool_address = $2 AND timeframe = $3
    `,
    [source, poolAddress, timeframe],
  );
}

export async function candleCount(
  source: CandleSource,
  poolAddress: string,
  timeframe: Timeframe,
): Promise<number> {
  const rows = await query<{ cnt: string | number | bigint }>(
    `
    SELECT count(*)::BIGINT AS cnt
    FROM market.candles
    WHERE source = $1 AND pool_address = $2 AND timeframe = $3
    `,
    [source, poolAddress, timeframe],
  );
  return rows[0] ? Number(rows[0].cnt) : 0;
}
