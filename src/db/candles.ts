import type { Candle, Timeframe } from "../types.js";
import { getSql } from "./db.js";

export interface CandleRangeBounds {
  minTime?: number;
  maxTime?: number;
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
  poolAddress: string,
  timeframe: Timeframe,
  fromTime: number,
  toTime: number,
): Promise<Candle[]> {
  const sql = getSql();
  const rows = await sql<CandleRow[]>`
    SELECT
      EXTRACT(EPOCH FROM time)::BIGINT AS time,
      open, high, low, close, volume
    FROM market.candles
    WHERE pool_address = ${poolAddress}
      AND timeframe = ${timeframe}
      AND time >= to_timestamp(${fromTime})
      AND time < to_timestamp(${toTime})
    ORDER BY time
  `;
  return rows.map((row) => ({
    time: asUnix(row.time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }));
}

export async function readRangeBounds(
  poolAddress: string,
  timeframe: Timeframe,
  fromTime: number,
  toTime: number,
): Promise<CandleRangeBounds> {
  const sql = getSql();
  const rows = await sql<
    {
      min_time: string | number | bigint | null;
      max_time: string | number | bigint | null;
      cnt: string | number | bigint;
    }[]
  >`
    SELECT
      EXTRACT(EPOCH FROM min(time))::BIGINT AS min_time,
      EXTRACT(EPOCH FROM max(time))::BIGINT AS max_time,
      count(*)::BIGINT AS cnt
    FROM market.candles
    WHERE pool_address = ${poolAddress}
      AND timeframe = ${timeframe}
      AND time >= to_timestamp(${fromTime})
      AND time < to_timestamp(${toTime})
  `;
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
  return bounds;
}

/** postgres.js rejects a statement with more than 65534 bind parameters. */
const MAX_BIND_PARAMS = 65_534;
const CANDLE_UPSERT_COLUMNS = 8;
const UPSERT_BATCH_SIZE = Math.floor(MAX_BIND_PARAMS / CANDLE_UPSERT_COLUMNS);

export async function upsertCandles(
  poolAddress: string,
  timeframe: Timeframe,
  candles: Candle[],
): Promise<void> {
  if (candles.length === 0) {
    return;
  }
  const sql = getSql();
  for (let i = 0; i < candles.length; i += UPSERT_BATCH_SIZE) {
    const batch = candles.slice(i, i + UPSERT_BATCH_SIZE);
    const rows = batch.map((c) => ({
      pool_address: poolAddress,
      timeframe,
      time: new Date(c.time * 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    await sql`
      INSERT INTO market.candles ${sql(rows)}
      ON CONFLICT (pool_address, timeframe, time) DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume,
        fetched_at = now()
    `;
  }
}

export async function deleteCandles(poolAddress: string, timeframe: Timeframe): Promise<void> {
  const sql = getSql();
  await sql`
    DELETE FROM market.candles
    WHERE pool_address = ${poolAddress} AND timeframe = ${timeframe}
  `;
}

export async function candleCount(poolAddress: string, timeframe: Timeframe): Promise<number> {
  const sql = getSql();
  const rows = await sql<{ cnt: string | number | bigint }[]>`
    SELECT count(*)::BIGINT AS cnt
    FROM market.candles
    WHERE pool_address = ${poolAddress} AND timeframe = ${timeframe}
  `;
  return rows[0] ? Number(rows[0].cnt) : 0;
}
