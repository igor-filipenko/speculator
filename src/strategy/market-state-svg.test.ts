import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle, MarketIndicators } from "../types.js";
import { buildMarketStateSvg } from "./market-state-svg.js";
import { htfParamsFor } from "./strategy-manager.js";

function makeCandles(n: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + ((i % 3) - 1) * 0.5;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    out.push({
      time: 1_700_000_000 + i * 4 * 3600,
      open,
      high,
      low,
      close,
      volume: 1000 + i,
    });
    price = close;
  }
  return out;
}

function sampleState(candles: Candle[], levels?: MarketIndicators["levels"]): MarketIndicators {
  return {
    pair: "SOL/USDC",
    timeframe: "4h",
    at: new Date("2026-01-01T00:00:00.000Z"),
    price: candles[candles.length - 1]?.close ?? 100,
    trend: "bullish",
    support: 95,
    resistance: 108,
    ...(levels !== undefined ? { levels } : {}),
    candles,
  };
}

describe("buildMarketStateSvg", () => {
  it("renders candles with EMA50/200 and ADX labels", () => {
    const svg = buildMarketStateSvg({
      state: sampleState(makeCandles(40)),
      params: htfParamsFor("4h"),
    });
    assert.ok(svg.includes("<svg"));
    assert.ok(svg.includes("SOL/USDC"));
    assert.ok(svg.includes("EMA50"));
    assert.ok(svg.includes("EMA200"));
    assert.ok(svg.includes("ADX14"));
    assert.ok(svg.includes("bullish"));
    assert.ok(svg.includes("limegreen"));
    assert.ok(svg.includes("tomato"));
    assert.ok(svg.includes("skyblue"));
    assert.ok(svg.includes("gold"));
    assert.ok(svg.length > 500);
  });

  it("draws support and resistance level prices", () => {
    const levels: MarketIndicators["levels"] = [
      { price: 95.25, kind: "support", touches: 3, lastTime: 1_700_000_000, volume: 12 },
      { price: 108.5, kind: "resistance", touches: 2, lastTime: 1_700_100_000, volume: 9 },
    ];
    const svg = buildMarketStateSvg({
      state: sampleState(makeCandles(40), levels),
      params: htfParamsFor("4h"),
    });
    assert.ok(svg.includes("limegreen"));
    assert.ok(svg.includes("tomato"));
    assert.ok(svg.includes("95.25"));
    assert.ok(svg.includes("108.50"));
  });

  it("grows with candle count", () => {
    const small = buildMarketStateSvg({ state: sampleState(makeCandles(20)) });
    const large = buildMarketStateSvg({ state: sampleState(makeCandles(80)) });
    assert.ok(large.length > small.length);
  });

  it("rejects an empty series", () => {
    assert.throws(() => buildMarketStateSvg({ state: sampleState([]) }), /empty candle series/);
  });
});
