import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle } from "../../types.js";
import { donchianParamsFor } from "./donchian.js";
import { buildDonchianSvg } from "./donchian-svg.js";

const strategy = donchianParamsFor();

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

describe("buildDonchianSvg", () => {
  it("renders a non-empty SVG with Donchian and volume labels", () => {
    const svg = buildDonchianSvg({
      pair: "SOL/USDC",
      candles: makeCandles(40),
      strategy,
    });
    assert.ok(svg.includes("<svg"));
    assert.ok(svg.includes("SOL/USDC"));
    assert.ok(svg.includes("Donchian mid"));
    assert.ok(svg.includes("volume SMA20"));
    assert.ok(svg.length > 500);
  });

  it("grows with candle count", () => {
    const small = buildDonchianSvg({
      pair: "SOL/USDC",
      candles: makeCandles(20),
      strategy,
    });
    const large = buildDonchianSvg({
      pair: "SOL/USDC",
      candles: makeCandles(80),
      strategy,
    });
    assert.ok(large.length > small.length);
  });

  it("rejects an empty series", () => {
    assert.throws(
      () => buildDonchianSvg({ pair: "SOL/USDC", candles: [], strategy }),
      /empty candle series/,
    );
  });
});
