import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle } from "../types.js";
import { formingCandle, intraBarPrices, intraBarTicks, randomIntraBarPrices } from "./intra-bar.js";

function bar(open: number, high: number, low: number, close: number): Candle {
  return { time: 1_700_000_000, open, high, low, close, volume: 10 };
}

/** Midpoint of the high–low range (intra-bar volatility sample). */
function midBody(high: number, low: number): number {
  return low + (high - low) * 0.5;
}

describe("intraBarPrices", () => {
  it("walks green candles open → low → mid → high → close", () => {
    assert.deepEqual(intraBarPrices(bar(100, 104, 98, 103)), [100, 98, 101, 104, 103]);
  });

  it("walks red candles open → high → mid → low → close", () => {
    assert.deepEqual(intraBarPrices(bar(100, 104, 98, 99)), [100, 104, 101, 98, 99]);
  });

  it("treats a doji (close === open) as green", () => {
    assert.deepEqual(intraBarPrices(bar(100, 104, 98, 100)), [100, 98, 101, 104, 100]);
  });

  it("drops consecutive duplicate prices", () => {
    assert.deepEqual(intraBarPrices(bar(100, 100, 100, 100)), [100]);
    // open===low, close===high → mid stays between them
    assert.deepEqual(intraBarPrices(bar(100, 104, 100, 104)), [100, midBody(104, 100), 104]);
  });

  it("ignores position side (path is candle-color only)", () => {
    const green = bar(100, 104, 98, 103);
    const red = bar(100, 104, 98, 99);
    const greenPath = [100, 98, 101, 104, 103];
    const redPath = [100, 104, 101, 98, 99];
    assert.deepEqual(intraBarPrices(green, "flat"), greenPath);
    assert.deepEqual(intraBarPrices(green, "long"), greenPath);
    assert.deepEqual(intraBarPrices(green, "short"), greenPath);
    assert.deepEqual(intraBarPrices(red, "flat"), redPath);
    assert.deepEqual(intraBarPrices(red, "long"), redPath);
    assert.deepEqual(intraBarPrices(red, "short"), redPath);
  });
});

describe("formingCandle", () => {
  it("starts as an open-only bar, then expands high/low with each tick", () => {
    const closed = bar(100, 104, 98, 103);
    const atOpen = formingCandle(closed, [100]);
    assert.deepEqual(atOpen, { ...closed, high: 100, low: 100, close: 100 });

    const atLow = formingCandle(closed, [100, 98]);
    assert.deepEqual(atLow, { ...closed, high: 100, low: 98, close: 98 });

    const atMid = formingCandle(closed, [100, 98, 101]);
    assert.deepEqual(atMid, { ...closed, high: 101, low: 98, close: 101 });

    const atHigh = formingCandle(closed, [100, 98, 101, 104]);
    assert.deepEqual(atHigh, { ...closed, high: 104, low: 98, close: 104 });

    const atClose = formingCandle(closed, [100, 98, 101, 104, 103]);
    assert.deepEqual(atClose, closed);
  });
});

describe("intraBarTicks", () => {
  it("staggers timestamps inside the bar and keeps the last candle forming", () => {
    const closed = bar(100, 104, 98, 99);
    const ticks = intraBarTicks(closed, 900);
    assert.equal(ticks.length, 5);
    assert.deepEqual(
      ticks.map((t) => t.price),
      [100, 104, 101, 98, 99],
    );
    assert.deepEqual(
      ticks.map((t) => t.atSec),
      [closed.time, closed.time + 180, closed.time + 360, closed.time + 540, closed.time + 720],
    );
    assert.equal(ticks[0]!.forming.close, 100);
    assert.equal(ticks[0]!.forming.high, 100);
    assert.equal(ticks[1]!.forming.high, 104);
    assert.equal(ticks[1]!.forming.low, 100);
    assert.equal(ticks[2]!.forming.close, 101);
    assert.equal(ticks[2]!.forming.high, 104);
    assert.equal(ticks[2]!.forming.low, 100);
    assert.equal(ticks[3]!.forming.low, 98);
    assert.equal(ticks[3]!.forming.close, 98);
    assert.deepEqual(ticks[4]!.forming, closed);
  });
});

describe("randomIntraBarPrices", () => {
  /** Seeded deterministic RNG (Mulberry32 inline for the test). */
  function seededRng(seed: number): () => number {
    let s = seed >>> 0;
    return function (): number {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("starts at open and ends at close", () => {
    const candle = bar(100, 110, 90, 105);
    for (let seed = 0; seed < 20; seed++) {
      const path = randomIntraBarPrices(candle, seededRng(seed));
      assert.equal(path[0], candle.open, `seed ${seed}: first price should be open`);
      assert.equal(path[path.length - 1], candle.close, `seed ${seed}: last price should be close`);
    }
  });

  it("always visits both high and low", () => {
    const candle = bar(100, 110, 90, 105);
    for (let seed = 0; seed < 30; seed++) {
      const path = randomIntraBarPrices(candle, seededRng(seed));
      assert.ok(path.includes(candle.high), `seed ${seed}: path must include high`);
      assert.ok(path.includes(candle.low), `seed ${seed}: path must include low`);
    }
  });

  it("all prices stay within [low, high]", () => {
    const candle = bar(100, 110, 90, 105);
    for (let seed = 0; seed < 20; seed++) {
      const path = randomIntraBarPrices(candle, seededRng(seed));
      for (const p of path) {
        assert.ok(p >= candle.low && p <= candle.high, `seed ${seed}: price ${p} out of range`);
      }
    }
  });

  it("produces different orderings across seeds", () => {
    const candle = bar(100, 110, 90, 105);
    const paths = new Set<string>();
    for (let seed = 0; seed < 50; seed++) {
      paths.add(JSON.stringify(randomIntraBarPrices(candle, seededRng(seed))));
    }
    // With 50 seeds, we expect multiple distinct orderings.
    assert.ok(paths.size > 1, "expected more than one unique path across seeds");
  });

  it("drops consecutive duplicate prices", () => {
    // All-equal candle: open=high=low=close → single-element path
    const doji = bar(100, 100, 100, 100);
    const path = randomIntraBarPrices(doji, seededRng(0));
    assert.equal(path.length, 1);
    assert.equal(path[0], 100);
  });
});
