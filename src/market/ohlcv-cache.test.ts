import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Candle } from "../types.js";
import { cacheFilePath, loadCachedCandles, type OhlcvCacheFile } from "./ohlcv-cache.js";

function candle(time: number, close: number): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1 };
}

describe("ohlcv cache", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "speculator-ohlcv-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns cached candles without network when the window is covered", async () => {
    const pool = "TestPool1111111111111111111111111111111";
    const timeframe = "15m" as const;
    const interval = 15 * 60;
    const fromTime = 1_700_000_000;
    const count = 10;
    const candles = Array.from({ length: count }, (_, i) =>
      candle(fromTime + i * interval, 100 + i),
    );
    const toTime = fromTime + count * interval;

    const path = cacheFilePath(pool, timeframe, dir);
    const file: OhlcvCacheFile = {
      poolAddress: pool,
      timeframe,
      fetchedAt: new Date().toISOString(),
      candles,
    };
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");

    const loaded = await loadCachedCandles({
      poolAddress: pool,
      timeframe,
      fromTime,
      toTime,
      cacheDir: dir,
    });

    assert.equal(loaded.length, count);
    assert.equal(loaded[0]?.time, fromTime);
    assert.equal(loaded[count - 1]?.close, 100 + count - 1);

    // Cache file should still be the same (no rewrite without fetch).
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as OhlcvCacheFile;
    assert.equal(parsed.fetchedAt, file.fetchedAt);
  });
});
