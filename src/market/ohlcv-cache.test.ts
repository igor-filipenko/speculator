import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { candleCount, readCandles, upsertCandles } from "../db/candles.js";
import { resetSpeculatorDbCache, speculatorDbPath } from "../db/db.js";
import type { Candle } from "../types.js";
import { loadCachedCandles } from "./ohlcv-cache.js";

function candle(time: number, close: number): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1 };
}

describe("ohlcv cache (DuckDB)", () => {
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "speculator-db-"));
  });

  after(async () => {
    resetSpeculatorDbCache();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns cached candles without network when the window is covered", async () => {
    const symbol = "SOL/USDC";
    const timeframe = "15m" as const;
    const interval = 15 * 60;
    const fromTime = 1_700_000_000;
    const count = 10;
    const candles = Array.from({ length: count }, (_, i) =>
      candle(fromTime + i * interval, 100 + i),
    );
    const toTime = fromTime + count * interval;

    await upsertCandles(symbol, timeframe, candles, dataDir);

    const loaded = await loadCachedCandles({
      symbol,
      poolAddress: "unused-when-cache-covers",
      timeframe,
      fromTime,
      toTime,
      dataDir,
    });

    assert.equal(loaded.length, count);
    assert.equal(loaded[0]?.time, fromTime);
    assert.equal(loaded[count - 1]?.close, 100 + count - 1);
    assert.equal(await candleCount(symbol, timeframe, dataDir), count);
  });

  it("upserts idempotently on the same primary key", async () => {
    const symbol = "BONK/USDC";
    const timeframe = "15m" as const;
    const t = 1_700_100_000;
    const first = candle(t, 50);
    const updated = { ...first, close: 55, high: 56 };

    await upsertCandles(symbol, timeframe, [first], dataDir);
    await upsertCandles(symbol, timeframe, [updated], dataDir);

    assert.equal(await candleCount(symbol, timeframe, dataDir), 1);
    const rows = await readCandles(symbol, timeframe, t, t + 1, dataDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.close, 55);
  });

  it("creates speculator.duckdb under dataDir", () => {
    assert.ok(speculatorDbPath(dataDir).endsWith("speculator.duckdb"));
  });
});
