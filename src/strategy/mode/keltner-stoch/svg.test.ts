import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandle } from "../../../market/candle.js";
import type { Candle } from "../../../types.js";
import { keltnerStochParamsFor } from "./keltner-stoch.js";
import { buildKeltnerStochSvg } from "./svg.js";

const strategy = keltnerStochParamsFor();

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
        time: 1_700_000_000 + i * 900,
        open,
        high,
        low,
        close,
        volume: 1000 + i,
      }),
    );
    price = close;
  }
  return out;
}

describe("buildKeltnerStochSvg", () => {
  it("renders a non-empty SVG with KC and stochastic labels", () => {
    const svg = buildKeltnerStochSvg({
      pair: "SOL/USDC",
      candles: makeCandles(40),
      strategy,
    });
    assert.ok(svg.includes("<svg"));
    assert.match(svg, /KC mid/);
    assert.match(svg, /%K/);
    assert.match(svg, /%D/);
    assert.match(svg, new RegExp(`KC\\(${strategy.period}, ${strategy.atrMult}\\)`));
  });

  it("rejects an empty series", () => {
    assert.throws(
      () => buildKeltnerStochSvg({ pair: "SOL/USDC", candles: [], strategy }),
      /empty candle series/,
    );
  });
});
