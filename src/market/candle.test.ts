import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candleIntervalSeconds, createCandle, expectedCandleCount } from "./candle.js";

describe("candleIntervalSeconds", () => {
  it("maps 1m, 5m, 15m, 1h, 4h, and 1d", () => {
    assert.equal(candleIntervalSeconds("1m"), 60);
    assert.equal(candleIntervalSeconds("5m"), 5 * 60);
    assert.equal(candleIntervalSeconds("15m"), 15 * 60);
    assert.equal(candleIntervalSeconds("1h"), 60 * 60);
    assert.equal(candleIntervalSeconds("4h"), 4 * 60 * 60);
    assert.equal(candleIntervalSeconds("1d"), 24 * 60 * 60);
  });
});

describe("expectedCandleCount", () => {
  it("counts 4 fifteen-minute candles in one hour", () => {
    const interval = candleIntervalSeconds("15m");
    const fromTime = 1_699_999_200;
    assert.equal(expectedCandleCount(fromTime, fromTime + 60 * 60, interval), 4);
    assert.equal(expectedCandleCount(fromTime + 100, fromTime + 100 + 60 * 60, interval), 4);
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
