import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { geckoBaseVolume } from "./market.js";

describe("geckoBaseVolume", () => {
  it("converts quote notional into base-token volume", () => {
    const close = 121.57;
    const quoteVolume = 14_778.15;
    const base = geckoBaseVolume(quoteVolume, close);
    assert.ok(Math.abs(base - quoteVolume / close) < 1e-9);
    assert.ok(Math.abs(base * close - quoteVolume) < 1e-6);
  });

  it("returns 0 when close cannot scale notional back to base", () => {
    assert.equal(geckoBaseVolume(100, 0), 0);
    assert.equal(geckoBaseVolume(100, -1), 0);
    assert.equal(geckoBaseVolume(Number.NaN, 10), 0);
  });
});
