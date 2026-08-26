import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Candle, MarketState } from "../types.js";
import { resetSpeculatorDbCache, setSpeculatorDataDir } from "./db.js";
import {
  isMarketCacheFresh,
  loadFreshMarketState,
  loadMarket,
  toMarketState,
  toPersistedMarket,
  upsertMarket,
  type PersistedMarket,
} from "./market.js";

const INTERVAL_4H = 4 * 60 * 60;
const BAR_TIME = 1_704_067_200; // 2023-12-31T16:00:00.000Z

function bar(time: number, close: number): Candle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

function sampleState(overrides?: Partial<MarketState>): MarketState {
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
    strategyMode: "grid",
    candles,
    ...overrides,
  };
}

function samplePersisted(overrides?: Partial<PersistedMarket>): PersistedMarket {
  return { ...toPersistedMarket(sampleState()), ...overrides };
}

describe("isMarketCacheFresh", () => {
  it("is fresh until the stored HTF bar closes", () => {
    assert.equal(isMarketCacheFresh(BAR_TIME, BAR_TIME, INTERVAL_4H), true);
    assert.equal(isMarketCacheFresh(BAR_TIME, BAR_TIME + INTERVAL_4H - 1, INTERVAL_4H), true);
    assert.equal(isMarketCacheFresh(BAR_TIME, BAR_TIME + INTERVAL_4H, INTERVAL_4H), false);
  });
});

describe("toMarketState", () => {
  it("overlays live price on ATR% and dist-EMA200", () => {
    const persisted = samplePersisted();
    const candles = sampleState().candles;
    const livePrice = 110;
    const state = toMarketState(persisted, candles, livePrice, "ema-rsi");
    assert.equal(state.price, livePrice);
    assert.equal(state.strategyMode, "ema-rsi");
    assert.equal(state.candles, candles);
    assert.ok(state.ema200 != null);
    assert.equal(state.distEma200Pct, (livePrice - state.ema200) / state.ema200);
    assert.ok(state.atr != null);
    assert.equal(state.atrPct, state.atr / livePrice);
  });
});

describe("market.states (DuckDB)", () => {
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "speculator-market-"));
    setSpeculatorDataDir(dataDir);
  });

  after(async () => {
    resetSpeculatorDbCache();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("round-trips a PersistedMarket", async () => {
    const persisted = samplePersisted();
    await upsertMarket(persisted);

    const loaded = await loadMarket(persisted.pair, persisted.timeframe);
    assert.ok(loaded);
    assert.equal(loaded.barTime, BAR_TIME);
    assert.equal(loaded.trend, "bullish");
    assert.equal(loaded.ema200, 90);
    assert.equal(loaded.marketCapUsd, 50_000_000_000);
    assert.equal(loaded.strategyMode, "grid");
    assert.equal(loaded.at, persisted.at);
  });

  it("returns the row while the HTF bar is open", async () => {
    const fresh = await loadFreshMarketState({
      pair: "SOL/USDC",
      timeframe: "4h",
      nowSec: BAR_TIME + 60,
    });
    assert.ok(fresh);
    assert.equal(fresh.barTime, BAR_TIME);
  });

  it("returns null when the HTF bar has rolled", async () => {
    const missed = await loadFreshMarketState({
      pair: "SOL/USDC",
      timeframe: "4h",
      nowSec: BAR_TIME + INTERVAL_4H,
    });
    assert.equal(missed, null);
  });

  it("upserts the same pair/timeframe in place", async () => {
    const updated = samplePersisted({ trend: "bearish", price: 80, ema200: 100 });
    await upsertMarket(updated);
    const loaded = await loadMarket("SOL/USDC", "4h");
    assert.ok(loaded);
    assert.equal(loaded.trend, "bearish");
    assert.equal(loaded.price, 80);
    assert.equal(loaded.ema200, 100);
  });
});
