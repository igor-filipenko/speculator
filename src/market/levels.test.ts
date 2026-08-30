import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle } from "../types.js";
import { keyLevels, type KeyLevelsParams } from "./levels.js";

function c(time: number, high: number, low: number, close: number, volume = 1): Candle {
  return { time, open: close, high, low, close, volume };
}

function params(overrides?: Partial<KeyLevelsParams>): KeyLevelsParams {
  return {
    swingLeftRight: 2,
    clusterAtrMult: 0.5,
    atPriceAtrMult: 1,
    maxDistAtr: 8,
    maxLevelsEach: 3,
    ...overrides,
  };
}

describe("keyLevels", () => {
  it("maps swing high/low to resistance above and support below price", () => {
    const candles: Candle[] = [
      c(1, 101, 99, 100),
      c(2, 101, 99, 100),
      c(3, 110, 100, 105), // swing high
      c(4, 101, 99, 100),
      c(5, 101, 99, 100),
      c(6, 100, 90, 95), // swing low
      c(7, 101, 99, 100),
      c(8, 101, 99, 100),
      c(9, 102, 98, 100),
    ];
    const found = keyLevels(candles, 100, 2, params());
    assert.equal(found.resistance, 110);
    assert.equal(found.support, 90);
    assert.ok(found.levels.some((l) => l.kind === "resistance" && l.price === 110));
    assert.ok(found.levels.some((l) => l.kind === "support" && l.price === 90));
  });

  it("clusters nearby swing highs into one resistance with multiple touches", () => {
    const candles: Candle[] = [
      c(1, 100, 98, 99),
      c(2, 100, 98, 99),
      c(3, 110, 100, 105),
      c(4, 100, 98, 99),
      c(5, 100, 98, 99),
      c(6, 100, 98, 99),
      c(7, 110.4, 100, 105),
      c(8, 100, 98, 99),
      c(9, 100, 98, 99),
      c(10, 101, 90, 95),
      c(11, 100, 98, 99),
      c(12, 100, 98, 99),
    ];
    const found = keyLevels(candles, 100, 2, params());
    const clustered = found.levels.find(
      (l) => l.kind === "resistance" && Math.abs(l.price - 110.2) < 0.3,
    );
    assert.ok(clustered);
    assert.ok(clustered.touches >= 2);
  });

  it("prefers a nearby high-volume swing over a distant historical low", () => {
    const candles: Candle[] = [
      c(1, 72, 70, 71, 1),
      c(2, 72, 70, 71, 1),
      c(3, 71, 50, 55, 2), // distant swing low
      c(4, 72, 70, 71, 1),
      c(5, 72, 70, 71, 1),
      c(6, 101, 99, 100, 1),
      c(7, 101, 99, 100, 1),
      c(8, 100, 94, 96, 40), // nearby swing low, heavy volume
      c(9, 101, 99, 100, 30),
      c(10, 101, 99, 100, 20),
    ];
    const found = keyLevels(candles, 100, 2, params());
    assert.ok(found.support != null);
    assert.ok(found.support > 90, `expected nearby support, got ${found.support}`);
    assert.ok(Math.abs(found.support - 94) < 1);
  });

  it("weights cluster price toward the higher-volume pivot", () => {
    const candles: Candle[] = [
      c(1, 100, 98, 99, 1),
      c(2, 100, 98, 99, 1),
      c(3, 110, 100, 105, 1),
      c(4, 100, 98, 99, 1),
      c(5, 100, 98, 99, 1),
      c(6, 100, 98, 99, 1),
      c(7, 110.8, 100, 105, 50),
      c(8, 100, 98, 99, 40),
      c(9, 100, 98, 99, 40),
      c(10, 101, 90, 95, 1),
      c(11, 100, 98, 99, 1),
      c(12, 100, 98, 99, 1),
    ];
    const found = keyLevels(candles, 100, 2, params());
    const clustered = found.levels.find((l) => l.kind === "resistance" && l.touches >= 2);
    assert.ok(clustered);
    assert.ok(clustered.price > 110.3, `expected volume-weighted price, got ${clustered.price}`);
  });
});
