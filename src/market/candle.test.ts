import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candleIntervalSeconds, createCandle } from "./candle.js";

describe("candleIntervalSeconds", () => {
  it("maps 5m, 15m, 1h, 4h, and 1d", () => {
    assert.equal(candleIntervalSeconds("5m"), 5 * 60);
    assert.equal(candleIntervalSeconds("15m"), 15 * 60);
    assert.equal(candleIntervalSeconds("1h"), 60 * 60);
    assert.equal(candleIntervalSeconds("4h"), 4 * 60 * 60);
    assert.equal(candleIntervalSeconds("1d"), 24 * 60 * 60);
  });
});

describe("Candle.isClosed", () => {
  const candle = createCandle({
    time: 1_700_000_000,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    timeframe: "15m",
  });

  it("is forming until the interval elapses", () => {
    assert.equal(candle.isClosed(candle.time), false);
    assert.equal(candle.isClosed(candle.time + 15 * 60 - 1), false);
    assert.equal(candle.isClosed(candle.time + 15 * 60), true);
  });
});
