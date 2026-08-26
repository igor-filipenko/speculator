import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SimpleRiskManager } from "../risk/risk-manager.js";
import type { Candle } from "../types.js";
import { evaluateMarketState, htfParamsFor, SimpleStrategyManager } from "./strategy-manager.js";

function bar(time: number, close: number, range = 0.5): Candle {
  return {
    time,
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume: 1,
  };
}

function series(count: number, startPrice: number, delta: number): Candle[] {
  const start = 1_700_000_000;
  const interval = 4 * 60 * 60;
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price += delta;
    candles.push(bar(start + i * interval, price, Math.abs(delta) + 0.2));
  }
  return candles;
}

const params = htfParamsFor("4h");
const at = new Date("2026-01-01T00:00:00.000Z");

describe("htfParamsFor / getRequiredCandles", () => {
  it("uses 200-EMA warmup of at least 220 bars on the given HTF", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "ema-rsi", htf: "4h" });
    const required = manager.getRequiredCandles();
    assert.equal(required.timeframe, "4h");
    assert.ok(required.count >= 200);
    assert.equal(htfParamsFor("1d").timeframe, "1d");
  });
});

describe("SimpleStrategyManager defaults", () => {
  it("returns env-style strategy and SimpleRiskManager from that strategy", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "grid", htf: "4h" });
    assert.equal(manager.getActiveStrategy().getMode(), "grid");
    assert.ok(manager.getActiveRiskManager() instanceof SimpleRiskManager);
    assert.equal(manager.getActiveRiskManager(), manager.getActiveRiskManager());
  });
});

describe("evaluateMarketState", () => {
  it("is unknown until EMA200 is warm", () => {
    const candles = series(50, 100, 0.1);
    const state = evaluateMarketState({
      pair: "SOL/USDC",
      candles,
      price: candles[candles.length - 1]!.close,
      at,
      params,
      strategyMode: "ema-rsi",
    });
    assert.equal(state.trend, "unknown");
    assert.equal(state.ema200, undefined);
  });

  it("is bullish when close is above EMA200 and ADX is trending", () => {
    const candles = series(250, 50, 0.8);
    const close = candles[candles.length - 1]!.close;
    const state = evaluateMarketState({
      pair: "SOL/USDC",
      candles,
      price: close,
      at,
      params,
      strategyMode: "ema-rsi",
    });
    assert.equal(state.trend, "bullish");
    assert.ok(state.ema200 != null && close > state.ema200);
    assert.ok(state.adx != null && state.adx >= params.adxFlatMax);
    assert.ok(state.ema50 != null);
    assert.ok(state.atr != null && state.atrPct != null);
    assert.ok(state.distEma200Pct != null && state.distEma200Pct > 0);
  });

  it("is bearish when close is below EMA200 and ADX is trending", () => {
    const candles = series(250, 250, -0.8);
    const close = candles[candles.length - 1]!.close;
    const state = evaluateMarketState({
      pair: "SOL/USDC",
      candles,
      price: close,
      at,
      params,
      strategyMode: "bollinger",
    });
    assert.equal(state.trend, "bearish");
    assert.ok(state.ema200 != null && close < state.ema200);
    assert.ok(state.adx != null && state.adx >= params.adxFlatMax);
    assert.equal(state.strategyMode, "bollinger");
  });

  it("is flat when ADX is below the threshold even if price is above EMA200", () => {
    const candles = series(250, 100, 0);
    const close = candles[candles.length - 1]!.close;
    const state = evaluateMarketState({
      pair: "SOL/USDC",
      candles,
      price: close,
      at,
      params,
      strategyMode: "ema-rsi",
    });
    assert.equal(state.trend, "flat");
    assert.ok(state.ema200 != null);
    assert.ok(state.adx == null || state.adx < params.adxFlatMax);
  });

  it("attaches pool stats when provided", () => {
    const state = evaluateMarketState({
      pair: "SOL/USDC",
      candles: [],
      price: 100,
      at,
      params,
      strategyMode: "ema-rsi",
      poolStats: { marketCapUsd: 1_000, fdvUsd: 2_000 },
    });
    assert.equal(state.marketCapUsd, 1_000);
    assert.equal(state.fdvUsd, 2_000);
    assert.equal(state.trend, "unknown");
  });
});
