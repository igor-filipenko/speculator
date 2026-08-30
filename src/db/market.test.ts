import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Candle, MarketIndicators } from "../types.js";
import { resetSpeculatorDbCache, setSpeculatorDataDir } from "./db.js";
import {
  isMarketCacheFresh,
  loadFreshMarketIndicators,
  loadMarketIndicators,
  toMarketIndicators,
  toPersistedMarketIndicators,
  upsertMarketIndicators,
  type PersistedMarketIndicators,
} from "./market.js";

const INTERVAL_4H = 4 * 60 * 60;
const BAR_TIME = 1_704_067_200; // 2023-12-31T16:00:00.000Z

function bar(time: number, close: number): Candle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

function sampleIndicators(overrides?: Partial<MarketIndicators>): MarketIndicators {
  const candles = [bar(BAR_TIME - INTERVAL_4H, 99), bar(BAR_TIME, 101)];
  return {
    pair: "SOL/USDC",
    timeframe: "4h",
    at: new Date(BAR_TIME * 1000),
    price: 101,
    trend: "bullish",
    ema200: 90,
    ema50: 95,
    adx: 25,
    atr: 2,
    atrPct: 2 / 101,
    distEma200Pct: (101 - 90) / 90,
    marketCapUsd: 50_000_000_000,
    fdvUsd: 60_000_000_000,
    candles,
    ...overrides,
  };
}

function samplePersisted(
  overrides?: Partial<PersistedMarketIndicators>,
): PersistedMarketIndicators {
  return { ...toPersistedMarketIndicators(sampleIndicators()), ...overrides };
}

describe("isMarketCacheFresh", () => {
  it("is fresh until the stored HTF bar closes", () => {
    assert.equal(isMarketCacheFresh(BAR_TIME, BAR_TIME, INTERVAL_4H), true);
    assert.equal(isMarketCacheFresh(BAR_TIME, BAR_TIME + INTERVAL_4H - 1, INTERVAL_4H), true);
    assert.equal(isMarketCacheFresh(BAR_TIME, BAR_TIME + INTERVAL_4H, INTERVAL_4H), false);
  });
});

describe("toMarketIndicators", () => {
  it("overlays live price on ATR% and dist-EMA200", () => {
    const persisted = samplePersisted();
    const candles = sampleIndicators().candles;
    const livePrice = 110;
    const indicators = toMarketIndicators(persisted, candles, livePrice);
    assert.equal(indicators.price, livePrice);
    assert.equal(indicators.candles, candles);
    assert.ok(indicators.ema200 != null);
    assert.equal(indicators.distEma200Pct, (livePrice - indicators.ema200) / indicators.ema200);
    assert.ok(indicators.atr != null);
    assert.equal(indicators.atrPct, indicators.atr / livePrice);
  });
});

describe("market.indicators (DuckDB)", () => {
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "speculator-market-"));
    setSpeculatorDataDir(dataDir);
  });

  after(async () => {
    resetSpeculatorDbCache();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("round-trips a PersistedMarketIndicators", async () => {
    const persisted = samplePersisted();
    await upsertMarketIndicators(persisted);

    const loaded = await loadMarketIndicators(persisted.pair, persisted.timeframe);
    assert.ok(loaded);
    assert.equal(loaded.barTime, BAR_TIME);
    assert.equal(loaded.trend, "bullish");
    assert.equal(loaded.ema200, 90);
    assert.equal(loaded.marketCapUsd, 50_000_000_000);
    assert.equal(loaded.at, persisted.at);
  });

  it("returns the row while the HTF bar is open", async () => {
    const fresh = await loadFreshMarketIndicators({
      pair: "SOL/USDC",
      timeframe: "4h",
      nowSec: BAR_TIME + 60,
    });
    assert.ok(fresh);
    assert.equal(fresh.barTime, BAR_TIME);
  });

  it("returns null when the HTF bar has rolled", async () => {
    const missed = await loadFreshMarketIndicators({
      pair: "SOL/USDC",
      timeframe: "4h",
      nowSec: BAR_TIME + INTERVAL_4H,
    });
    assert.equal(missed, null);
  });

  it("upserts the same pair/timeframe in place", async () => {
    const updated = samplePersisted({ trend: "bearish", price: 80, ema200: 100 });
    await upsertMarketIndicators(updated);
    const loaded = await loadMarketIndicators("SOL/USDC", "4h");
    assert.ok(loaded);
    assert.equal(loaded.trend, "bearish");
    assert.equal(loaded.price, 80);
    assert.equal(loaded.ema200, 100);
  });
});
