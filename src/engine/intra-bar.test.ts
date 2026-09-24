import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle } from "../types.js";
import { formingCandle, intraBarPrices, intraBarTicks } from "./intra-bar.js";

function bar(open: number, high: number, low: number, close: number): Candle {
  return { time: 1_700_000_000, open, high, low, close, volume: 10 };
}

describe("intraBarPrices", () => {
  it("walks green candles open → low → high → close", () => {
    assert.deepEqual(intraBarPrices(bar(100, 104, 98, 103)), [100, 98, 104, 103]);
  });

  it("walks red candles open → high → low → close", () => {
    assert.deepEqual(intraBarPrices(bar(100, 104, 98, 99)), [100, 104, 98, 99]);
  });

  it("treats a doji (close === open) as green", () => {
    assert.deepEqual(intraBarPrices(bar(100, 104, 98, 100)), [100, 98, 104, 100]);
  });

  it("drops consecutive duplicate prices", () => {
    assert.deepEqual(intraBarPrices(bar(100, 100, 100, 100)), [100]);
    assert.deepEqual(intraBarPrices(bar(100, 104, 100, 104)), [100, 104]);
  });
});

describe("formingCandle", () => {
  it("starts as an open-only bar, then expands high/low with each tick", () => {
    const closed = bar(100, 104, 98, 103);
    const atOpen = formingCandle(closed, [100]);
    assert.deepEqual(atOpen, { ...closed, high: 100, low: 100, close: 100 });

    const atLow = formingCandle(closed, [100, 98]);
    assert.deepEqual(atLow, { ...closed, high: 100, low: 98, close: 98 });

    const atHigh = formingCandle(closed, [100, 98, 104]);
    assert.deepEqual(atHigh, { ...closed, high: 104, low: 98, close: 104 });

    const atClose = formingCandle(closed, [100, 98, 104, 103]);
    assert.deepEqual(atClose, closed);
  });
});

describe("intraBarTicks", () => {
  it("staggers timestamps inside the bar and keeps the last candle forming", () => {
    const closed = bar(100, 104, 98, 99);
    const ticks = intraBarTicks(closed, 900);
    assert.equal(ticks.length, 4);
    assert.deepEqual(
      ticks.map((t) => t.price),
      [100, 104, 98, 99],
    );
    assert.deepEqual(
      ticks.map((t) => t.atSec),
      [closed.time, closed.time + 225, closed.time + 450, closed.time + 675],
    );
    assert.equal(ticks[0]!.forming.close, 100);
    assert.equal(ticks[0]!.forming.high, 100);
    assert.equal(ticks[1]!.forming.high, 104);
    assert.equal(ticks[1]!.forming.low, 100);
    assert.equal(ticks[2]!.forming.low, 98);
    assert.equal(ticks[2]!.forming.close, 98);
    assert.deepEqual(ticks[3]!.forming, closed);
  });
});
