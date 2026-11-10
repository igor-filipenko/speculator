import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  candleIntervalSeconds,
  createCandle,
  expectedCandleCount,
  isCandleFirstMinute,
  sanitizeCandles,
} from "./candle.js";

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

describe("isCandleFirstMinute", () => {
  const open = 20_000 * 24 * 60 * 60;

  it("is true through the opening 60 seconds of a 15m candle", () => {
    const interval = candleIntervalSeconds("15m");
    assert.equal(isCandleFirstMinute(open, interval), true);
    assert.equal(isCandleFirstMinute(open + 59, interval), true);
    assert.equal(isCandleFirstMinute(open + 60, interval), false);
    assert.equal(isCandleFirstMinute(open + interval - 1, interval), false);
    assert.equal(isCandleFirstMinute(open + interval, interval), true);
  });

  it("is true for the whole 1m candle", () => {
    const interval = candleIntervalSeconds("1m");
    assert.equal(isCandleFirstMinute(open, interval), true);
    assert.equal(isCandleFirstMinute(open + 59, interval), true);
  });

  it("uses the candle open on 5m, 1h, 4h, and 1d", () => {
    for (const timeframe of ["5m", "1h", "4h", "1d"] as const) {
      const interval = candleIntervalSeconds(timeframe);
      assert.equal(isCandleFirstMinute(open + 59, interval), true);
      assert.equal(isCandleFirstMinute(open + 60, interval), false);
      assert.equal(isCandleFirstMinute(open + interval - 1, interval), false);
      assert.equal(isCandleFirstMinute(open + interval + 10, interval), true);
    }
  });

  it("is false for a non-positive interval", () => {
    assert.equal(isCandleFirstMinute(open, 0), false);
    assert.equal(isCandleFirstMinute(open, -60), false);
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

describe("sanitizeCandles", () => {
  it("clamps a spike high to the body and leaves normal wicks alone", () => {
    const spike = createCandle({
      time: 0,
      open: 92.3,
      high: 200,
      low: 91.9,
      close: 92.0,
      volume: 1,
    });
    const normal = createCandle({
      time: 900,
      open: 92,
      high: 92.4,
      low: 91.5,
      close: 92.2,
      volume: 1,
    });
    const { candles, repaired } = sanitizeCandles([spike, normal]);
    assert.equal(repaired, 1);
    assert.equal(candles[0]?.high, 92.3);
    assert.equal(candles[0]?.low, 91.9);
    assert.equal(candles[1], normal);
    assert.equal(spike.high, 200);
  });

  it("clamps a spike low to the body", () => {
    const spike = createCandle({ time: 0, open: 92, high: 92.5, low: 10, close: 92.2, volume: 1 });
    const { candles, repaired } = sanitizeCandles([spike]);
    assert.equal(repaired, 1);
    assert.equal(candles[0]?.low, 92);
  });

  it("allows a wider wick on a 4h bar than on a 15m bar", () => {
    const wick = { time: 0, open: 100, high: 108, low: 99, close: 101, volume: 1 };
    const fourHour = createCandle({ ...wick, timeframe: "4h" });
    const quarter = createCandle({ ...wick, timeframe: "15m" });
    assert.equal(sanitizeCandles([fourHour]).repaired, 0);
    assert.equal(sanitizeCandles([quarter]).repaired, 1);
  });
});
