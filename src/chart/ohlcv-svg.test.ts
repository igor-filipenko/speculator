import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StrategyParams } from "../config.js";
import type { Candle } from "../types.js";
import { buildOhlcvSvg } from "./ohlcv-svg.js";

const params: StrategyParams = {
  timeframe: "15m",
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  rsiBuyMax: 70,
  rsiSellMin: 30,
};

function makeCandles(n: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + ((i % 3) - 1) * 0.5;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    out.push({
      time: 1_700_000_000 + i * 900,
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

describe("buildOhlcvSvg", () => {
  it("renders a non-empty SVG with EMA and RSI labels", () => {
    const svg = buildOhlcvSvg({
      pair: "SOL/USDC",
      candles: makeCandles(40),
      params,
    });
    assert.ok(svg.includes("<svg"));
    assert.ok(svg.includes("SOL/USDC"));
    assert.ok(svg.includes("EMA9"));
    assert.ok(svg.includes("EMA21"));
    assert.ok(svg.includes("RSI14"));
    assert.ok(svg.length > 500);
  });

  it("grows with candle count", () => {
    const small = buildOhlcvSvg({
      pair: "SOL/USDC",
      candles: makeCandles(20),
      params,
    });
    const large = buildOhlcvSvg({
      pair: "SOL/USDC",
      candles: makeCandles(80),
      params,
    });
    assert.ok(large.length > small.length);
  });

  it("rejects an empty series", () => {
    assert.throws(
      () => buildOhlcvSvg({ pair: "SOL/USDC", candles: [], params }),
      /empty candle series/,
    );
  });
});
