import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { candleCount, deleteCandles, readCandles, upsertCandles } from "../../db/candles.js";
import { resetSpeculatorDbCache } from "../../db/db.js";
import { truncateBotAndMarket, useTestDb } from "../../db/test-db.js";
import { createCandle } from "../candle.js";
import type { Candle, Market, PairConfig } from "../../types.js";
import { CachedMarket } from "./market.js";

const SOL_POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
const JUP_POOL = "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL";

const solPair: PairConfig = {
  symbol: "SOL/USDC",
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  baseDecimals: 9,
  quoteDecimals: 6,
  poolAddress: SOL_POOL,
};

function candle(time: number, close: number, source: Candle["source"] = "gecko-terminal"): Candle {
  return createCandle({ time, open: close, high: close, low: close, close, volume: 1, source });
}

class StubMarket implements Market {
  readonly source = "gecko-terminal" as const;
  fetched = 0;

  constructor(private readonly rows: Candle[] = []) {}

  fetchCandles(): Promise<Candle[]> {
    this.fetched += 1;
    return Promise.resolve(this.rows);
  }
}

describe("CachedMarket", () => {
  before(async () => {
    await useTestDb();
    await truncateBotAndMarket();
  });

  after(async () => {
    await resetSpeculatorDbCache();
  });

  it("returns cached candles without calling the inner market when the window is covered", async () => {
    const timeframe = "15m" as const;
    const interval = 15 * 60;
    const fromTime = 1_700_000_000;
    const count = 10;
    const candles = Array.from({ length: count }, (_, i) =>
      candle(fromTime + i * interval, 100 + i),
    );
    const toTime = fromTime + count * interval;

    await upsertCandles("gecko-terminal", SOL_POOL, timeframe, candles);
    const inner = new StubMarket();
    const loaded = await new CachedMarket(inner).fetchCandles({
      pair: solPair,
      timeframe,
      fromTime,
      toTime,
    });

    assert.equal(inner.fetched, 0);
    assert.equal(loaded.length, count);
    assert.equal(loaded[0]?.time, fromTime);
    assert.equal(loaded[0]?.source, "gecko-terminal");
    assert.equal(loaded[count - 1]?.close, 100 + count - 1);
    assert.equal(await candleCount("gecko-terminal", SOL_POOL, timeframe), count);
  });

  it("does not mix another source into the gecko series", async () => {
    const timeframe = "15m" as const;
    const t = 1_700_050_000;
    await upsertCandles("binance", SOL_POOL, timeframe, [candle(t, 77, "binance")]);

    const loaded = await readCandles("gecko-terminal", SOL_POOL, timeframe, t, t + 1);
    assert.equal(loaded.length, 0);
    const binance = await readCandles("binance", SOL_POOL, timeframe, t, t + 1);
    assert.equal(binance[0]?.close, 77);
    assert.equal(binance[0]?.source, "binance");
  });

  it("fills a gap from the inner market and upserts that source only", async () => {
    const timeframe = "1h" as const;
    const fromTime = 1_700_300_000;
    const interval = 60 * 60;
    const rows = [candle(fromTime, 10), candle(fromTime + interval, 11)];
    const inner = new StubMarket(rows);
    const loaded = await new CachedMarket(inner).fetchCandles({
      pair: solPair,
      timeframe,
      fromTime,
      toTime: fromTime + 2 * interval,
    });

    assert.equal(inner.fetched, 1);
    assert.equal(loaded.length, 2);
    assert.equal(await candleCount("gecko-terminal", SOL_POOL, timeframe), 2);
    assert.equal(await candleCount("binance", SOL_POOL, timeframe), 0);
  });

  it("delete removes only the named source", async () => {
    const timeframe = "4h" as const;
    const t = 1_700_400_000;
    await upsertCandles("gecko-terminal", SOL_POOL, timeframe, [candle(t, 1)]);
    await upsertCandles("binance", SOL_POOL, timeframe, [candle(t, 2, "binance")]);

    await deleteCandles("gecko-terminal", SOL_POOL, timeframe);

    assert.equal(await candleCount("gecko-terminal", SOL_POOL, timeframe), 0);
    assert.equal(await candleCount("binance", SOL_POOL, timeframe), 1);
  });

  it("upserts idempotently on the same primary key", async () => {
    const timeframe = "15m" as const;
    const t = 1_700_100_000;
    const first = candle(t, 50);
    const updated = createCandle({ ...first, close: 55, high: 56 });

    await upsertCandles("gecko-terminal", JUP_POOL, timeframe, [first]);
    await upsertCandles("gecko-terminal", JUP_POOL, timeframe, [updated]);

    assert.equal(await candleCount("gecko-terminal", JUP_POOL, timeframe), 1);
    const rows = await readCandles("gecko-terminal", JUP_POOL, timeframe, t, t + 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.close, 55);
  });

  it("upserts a batch that contains duplicate timestamps", async () => {
    const timeframe = "15m" as const;
    const t = 1_700_200_000;
    const dupes = [candle(t, 10), candle(t + 900, 11), candle(t, 12)];

    await upsertCandles("gecko-terminal", JUP_POOL, timeframe, dupes);

    const rows = await readCandles("gecko-terminal", JUP_POOL, timeframe, t, t + 1800);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.close, 12);
    assert.equal(rows[1]?.close, 11);
  });

  it("upserts more rows than a single parameterized statement can bind", async () => {
    const timeframe = "1d" as const;
    const fromTime = 1_600_000_000;
    const interval = 86_400;
    // 9 columns × 8192 rows > 65535 bind parameters (PostgreSQL protocol cap).
    const count = 8_192;
    const candles = Array.from({ length: count }, (_, i) =>
      candle(fromTime + i * interval, 100, "gecko-terminal"),
    );

    await upsertCandles("gecko-terminal", SOL_POOL, timeframe, candles);

    assert.equal(await candleCount("gecko-terminal", SOL_POOL, timeframe), count);
  });
});
