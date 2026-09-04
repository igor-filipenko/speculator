import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { candleCount, readCandles, upsertCandles } from "../db/candles.js";
import { resetSpeculatorDbCache } from "../db/db.js";
import { truncateBotAndMarket, useTestDb } from "../db/test-db.js";
import type { Candle } from "../types.js";
import { loadCachedCandles } from "./ohlcv-cache.js";

const SOL_POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
const JUP_POOL = "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL";

function candle(time: number, close: number): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1 };
}

describe("ohlcv cache", () => {
  before(async () => {
    await useTestDb();
    await truncateBotAndMarket();
  });

  after(async () => {
    await resetSpeculatorDbCache();
  });

  it("returns cached candles without network when the window is covered", async () => {
    const timeframe = "15m" as const;
    const interval = 15 * 60;
    const fromTime = 1_700_000_000;
    const count = 10;
    const candles = Array.from({ length: count }, (_, i) =>
      candle(fromTime + i * interval, 100 + i),
    );
    const toTime = fromTime + count * interval;

    await upsertCandles(SOL_POOL, timeframe, candles);

    const loaded = await loadCachedCandles({
      symbol: "SOL/USDC",
      poolAddress: SOL_POOL,
      timeframe,
      fromTime,
      toTime,
    });

    assert.equal(loaded.length, count);
    assert.equal(loaded[0]?.time, fromTime);
    assert.equal(loaded[count - 1]?.close, 100 + count - 1);
    assert.equal(await candleCount(SOL_POOL, timeframe), count);
  });

  it("upserts idempotently on the same primary key", async () => {
    const timeframe = "15m" as const;
    const t = 1_700_100_000;
    const first = candle(t, 50);
    const updated = { ...first, close: 55, high: 56 };

    await upsertCandles(JUP_POOL, timeframe, [first]);
    await upsertCandles(JUP_POOL, timeframe, [updated]);

    assert.equal(await candleCount(JUP_POOL, timeframe), 1);
    const rows = await readCandles(JUP_POOL, timeframe, t, t + 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.close, 55);
  });

  it("upserts more rows than a single parameterized statement can bind", async () => {
    const timeframe = "1d" as const;
    const fromTime = 1_600_000_000;
    const interval = 86_400;
    // 8 columns × 8192 rows > 65535 bind parameters (PostgreSQL protocol cap).
    const count = 8_192;
    const candles = Array.from({ length: count }, (_, i) => candle(fromTime + i * interval, 100));

    await upsertCandles(SOL_POOL, timeframe, candles);

    assert.equal(await candleCount(SOL_POOL, timeframe), count);
  });
});
