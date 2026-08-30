import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GenericRiskManager, HighRiskManager } from "../risk/risk-manager.js";
import type { Candle } from "../types.js";
import {
  evaluateMarketIndicators,
  htfParamsFor,
  SimpleStrategyManager,
} from "./strategy-manager.js";

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
    const manager = new SimpleStrategyManager({ strategyMode: "bollinger", htf: "4h" });
    const required = manager.getRequiredCandles();
    assert.equal(required.timeframe, "4h");
    assert.ok(required.count >= 200);
    assert.equal(htfParamsFor("1d").timeframe, "1d");
  });
});

describe("SimpleStrategyManager defaults", () => {
  it("returns env-style strategy and GenericRiskManager from that strategy", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "grid", htf: "4h" });
    assert.equal(manager.getActiveStrategy().getMode(), "grid");
    assert.ok(manager.getActiveRiskManager() instanceof GenericRiskManager);
    assert.equal(manager.getActiveRiskManager(), manager.getActiveRiskManager());
  });
});

describe("applyMarketIndicators", () => {
  it("switches to HighRiskManager when trend is not bullish", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "bollinger", htf: "4h" });
    const bullish = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 50, 0.8),
      price: 250,
      at,
      params,
    });
    assert.equal(bullish.trend, "bullish");
    assert.equal(manager.applyMarketIndicators(bullish), true);
    assert.ok(manager.getActiveRiskManager() instanceof GenericRiskManager);

    const bearish = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 250, -0.8),
      price: 50,
      at,
      params,
    });
    assert.equal(bearish.trend, "bearish");
    assert.equal(manager.applyMarketIndicators(bearish, bullish), true);
    assert.ok(manager.getActiveRiskManager() instanceof HighRiskManager);
    assert.equal(manager.applyMarketIndicators(bearish, bearish), false);
    assert.ok(manager.getActiveRiskManager() instanceof HighRiskManager);
  });
});

describe("evaluateMarketIndicators", () => {
  it("is unknown until EMA200 is warm", () => {
    const candles = series(50, 100, 0.1);
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles,
      price: candles[candles.length - 1]!.close,
      at,
      params,
    });
    assert.equal(indicators.trend, "unknown");
    assert.equal(indicators.ema200, undefined);
    assert.equal(indicators.candles.length, 50);
  });

  it("is bullish when close is above EMA200 and ADX is trending", () => {
    const candles = series(250, 50, 0.8);
    const close = candles[candles.length - 1]!.close;
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles,
      price: close,
      at,
      params,
    });
    assert.equal(indicators.trend, "bullish");
    assert.ok(indicators.ema200 != null && close > indicators.ema200);
    assert.ok(indicators.adx != null && indicators.adx >= params.adxFlatMax);
    assert.ok(
      indicators.ema50 != null && close > indicators.ema50 && indicators.ema50 > indicators.ema200,
    );
    assert.ok(indicators.plusDi != null && indicators.minusDi != null);
    assert.ok(indicators.plusDi > indicators.minusDi);
    assert.ok(indicators.atr != null && indicators.atrPct != null);
    assert.ok(indicators.distEma200Pct != null && indicators.distEma200Pct > 0);
  });

  it("is bearish when close is below EMA200 and ADX is trending", () => {
    const candles = series(250, 250, -0.8);
    const close = candles[candles.length - 1]!.close;
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles,
      price: close,
      at,
      params,
    });
    assert.equal(indicators.trend, "bearish");
    assert.ok(indicators.ema200 != null && close < indicators.ema200);
    assert.ok(indicators.adx != null && indicators.adx >= params.adxFlatMax);
  });

  it("is flat when ADX is below the threshold even if price is above EMA200", () => {
    const candles = series(250, 100, 0);
    const close = candles[candles.length - 1]!.close;
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles,
      price: close,
      at,
      params,
    });
    assert.equal(indicators.trend, "flat");
    assert.ok(indicators.ema200 != null);
    assert.ok(indicators.adx == null || indicators.adx < params.adxFlatMax);
  });

  it("is flat when close is above EMA200 but EMA50 is still below EMA200", () => {
    const down = series(230, 400, -1);
    const lastTime = down[down.length - 1]!.time;
    const interval = 4 * 60 * 60;
    let price = down[down.length - 1]!.close;
    const bounce: Candle[] = [];
    for (let i = 1; i <= 12; i++) {
      price += 12;
      bounce.push(bar(lastTime + i * interval, price, 2));
    }
    const candles = [...down, ...bounce];
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles,
      price: candles[candles.length - 1]!.close,
      at,
      params,
    });
    assert.ok(indicators.ema200 != null && indicators.ema50 != null);
    assert.ok(indicators.ema50 < indicators.ema200);
    assert.ok(candles[candles.length - 1]!.close > indicators.ema200);
    assert.equal(indicators.trend, "flat");
  });

  it("attaches pool stats when provided", () => {
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: [],
      price: 100,
      at,
      params,
      poolStats: { marketCapUsd: 1_000, fdvUsd: 2_000 },
    });
    assert.equal(indicators.marketCapUsd, 1_000);
    assert.equal(indicators.fdvUsd, 2_000);
    assert.equal(indicators.trend, "unknown");
    assert.deepEqual(indicators.candles, []);
  });
});
