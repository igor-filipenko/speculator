import type { DuckDBConnection } from "@duckdb/node-api";
import type { Candle, StrategyParams } from "../types.js";
import { getSpeculatorDb } from "./db.js";

export interface CandleRangeBounds {
  minTime?: number;
  maxTime?: number;
  count: number;
}

const UPSERT_SQL = `
  INSERT INTO candles (symbol, timeframe, time, open, high, low, close, volume)
  VALUES ($symbol, $timeframe, $time, $open, $high, $low, $close, $volume)
  ON CONFLICT (symbol, timeframe, time) DO UPDATE SET
    open = excluded.open,
    high = excluded.high,
    low = excluded.low,
    close = excluded.close,
    volume = excluded.volume,
    fetched_at = now()
`;

export async function readCandles(
  symbol: string,
  timeframe: StrategyParams["timeframe"],
  fromTime: number,
  toTime: number,
  dataDir?: string,
): Promise<Candle[]> {
  const conn = await getSpeculatorDb(dataDir);
  const reader = await conn.runAndReadAll(
    `
    SELECT time, open, high, low, close, volume
    FROM candles
    WHERE symbol = $symbol
      AND timeframe = $timeframe
      AND time >= $fromTime
      AND time < $toTime
    ORDER BY time
    `,
    {
      symbol,
      timeframe,
      fromTime,
      toTime,
    },
  );
  await reader.readAll();

  return reader.getRowObjectsJS().map((row) => ({
    time: Number(row["time"]),
    open: Number(row["open"]),
    high: Number(row["high"]),
    low: Number(row["low"]),
    close: Number(row["close"]),
    volume: Number(row["volume"]),
  }));
}

export async function readRangeBounds(
  symbol: string,
  timeframe: StrategyParams["timeframe"],
  fromTime: number,
  toTime: number,
  dataDir?: string,
): Promise<CandleRangeBounds> {
  const conn = await getSpeculatorDb(dataDir);
  const reader = await conn.runAndReadAll(
    `
    SELECT
      min(time) AS min_time,
      max(time) AS max_time,
      count(*)::BIGINT AS cnt
    FROM candles
    WHERE symbol = $symbol
      AND timeframe = $timeframe
      AND time >= $fromTime
      AND time < $toTime
    `,
    {
      symbol,
      timeframe,
      fromTime,
      toTime,
    },
  );
  await reader.readAll();
  const row = reader.getRowObjectsJS()[0];
  if (!row || Number(row["cnt"]) === 0) {
    return { count: 0 };
  }

  const bounds: CandleRangeBounds = { count: Number(row["cnt"]) };
  if (row["min_time"] != null) {
    bounds.minTime = Number(row["min_time"]);
  }
  if (row["max_time"] != null) {
    bounds.maxTime = Number(row["max_time"]);
  }
  return bounds;
}

export async function upsertCandles(
  symbol: string,
  timeframe: StrategyParams["timeframe"],
  candles: Candle[],
  dataDir?: string,
): Promise<void> {
  if (candles.length === 0) {
    return;
  }

  const conn = await getSpeculatorDb(dataDir);
  await conn.run("BEGIN TRANSACTION");
  try {
    for (const c of candles) {
      await conn.run(UPSERT_SQL, {
        symbol,
        timeframe,
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    }
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

export async function deleteCandles(
  symbol: string,
  timeframe: StrategyParams["timeframe"],
  dataDir?: string,
): Promise<void> {
  const conn = await getSpeculatorDb(dataDir);
  await conn.run(`DELETE FROM candles WHERE symbol = $symbol AND timeframe = $timeframe`, {
    symbol,
    timeframe,
  });
}

export async function candleCount(
  symbol: string,
  timeframe: StrategyParams["timeframe"],
  dataDir?: string,
): Promise<number> {
  const conn = await getSpeculatorDb(dataDir);
  const reader = await conn.runAndReadAll(
    `
    SELECT count(*)::BIGINT AS cnt
    FROM candles
    WHERE symbol = $symbol AND timeframe = $timeframe
    `,
    { symbol, timeframe },
  );
  await reader.readAll();
  const row = reader.getRowObjectsJS()[0];
  return row ? Number(row["cnt"]) : 0;
}

/** @internal Test helper — direct connection access. */
export async function withConnection<T>(
  dataDir: string | undefined,
  fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const conn = await getSpeculatorDb(dataDir);
  return fn(conn);
}
