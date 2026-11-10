import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandle } from "../../../market/candle.js";
import type { Candle } from "../../../types.js";
import { macdCrossoverParamsFor } from "./macd-crossover.js";
import { buildMacdCrossoverSvg } from "./svg.js";

const strategy = macdCrossoverParamsFor();

function makeCandles(n: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + ((i % 3) - 1) * 0.5;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    out.push(
      createCandle({
        time: 1_700_000_000 + i * 4 * 60 * 60,
        open,
        high,
        low,
        close,
        volume: 1000 + i,
        timeframe: "4h",
      }),
    );
    price = close;
  }
  return out;
}

describe("buildMacdCrossoverSvg", () => {
  it("renders candles, both EMAs, and the histogram", () => {
    const svg = buildMacdCrossoverSvg({
      pair: "SOL/USDC",
      candles: makeCandles(40),
      strategy,
    });
    assert.match(svg, /<svg/);
    assert.match(svg, /EMA2/);
    assert.match(svg, /EMA200/);
    assert.match(svg, /MACD histogram/);
    assert.match(svg, /MACD 12\/26\/9/);
  });

  it("rejects an empty series", () => {
    assert.throws(
      () => buildMacdCrossoverSvg({ pair: "SOL/USDC", candles: [], strategy }),
      /empty candle series/,
    );
  });
});
