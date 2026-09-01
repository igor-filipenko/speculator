import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adx, atr, bollinger, dmi, ema, rsi } from "./indicators.js";

describe("atr", () => {
  it("returns nulls until warm and matches Wilder smoothing", () => {
    const candles = [
      { high: 10, low: 8, close: 9 },
      { high: 11, low: 9, close: 10 },
      { high: 12, low: 10, close: 11 },
      { high: 13, low: 9, close: 10 },
      { high: 12, low: 10, close: 11 },
    ];
    const period = 3;
    const series = atr(candles, period);
    assert.equal(series.length, candles.length);
    assert.equal(series[0], null);
    assert.equal(series[1], null);
    assert.equal(series[2], null);
    assert.ok(series[3] != null);
    // First ATR = mean of TR[1..3]
    // TR1 = max(2, |11-9|, |9-9|) = 2
    // TR2 = max(2, |12-10|, |10-10|) = 2
    // TR3 = max(4, |13-11|, |9-11|) = 4
    const firstAtr = series[3];
    assert.ok(Math.abs(firstAtr - (2 + 2 + 4) / 3) < 1e-12);
    // Next: (prev*(n-1) + TR4) / n; TR4 = max(2, |12-10|, |10-10|) = 2
    const expectedNext = (firstAtr * 2 + 2) / 3;
    assert.ok(series[4] != null);
    assert.ok(Math.abs(series[4] - expectedNext) < 1e-12);
  });

  it("rejects invalid period", () => {
    assert.throws(() => atr([], 0), /ATR period/);
  });
});

describe("adx", () => {
  it("stays null until 2*period-1 and then produces values in [0, 100]", () => {
    const period = 3;
    const candles = [];
    let price = 50;
    for (let i = 0; i < 20; i++) {
      // Alternating directional bursts so +DM/−DM are non-trivial.
      price += i % 2 === 0 ? 2 : -1;
      candles.push({ high: price + 0.5, low: price - 0.5, close: price });
    }
    const series = adx(candles, period);
    const firstIdx = 2 * period - 1;
    for (let i = 0; i < firstIdx; i++) {
      assert.equal(series[i], null);
    }
    assert.ok(series[firstIdx] != null);
    const firstAdx = series[firstIdx];
    assert.ok(firstAdx >= 0 && firstAdx <= 100);
    assert.ok(series[series.length - 1] != null);
  });

  it("rejects invalid period", () => {
    assert.throws(() => adx([], 0), /ADX period/);
  });
});

describe("dmi", () => {
  it("has +DI > −DI on an uptrend and the reverse on a downtrend", () => {
    const up: { high: number; low: number; close: number }[] = [];
    let price = 50;
    for (let i = 0; i < 40; i++) {
      price += 2;
      up.push({ high: price + 0.3, low: price - 0.2, close: price });
    }
    const upDmi = dmi(up, 5);
    const lastUpPlus = upDmi.plusDi[upDmi.plusDi.length - 1];
    const lastUpMinus = upDmi.minusDi[upDmi.minusDi.length - 1];
    assert.ok(lastUpPlus != null && lastUpMinus != null);
    assert.ok(lastUpPlus > lastUpMinus);
    assert.deepEqual(adx(up, 5), upDmi.adx);

    const down: { high: number; low: number; close: number }[] = [];
    price = 120;
    for (let i = 0; i < 40; i++) {
      price -= 2;
      down.push({ high: price + 0.2, low: price - 0.3, close: price });
    }
    const downDmi = dmi(down, 5);
    const lastDownPlus = downDmi.plusDi[downDmi.plusDi.length - 1];
    const lastDownMinus = downDmi.minusDi[downDmi.minusDi.length - 1];
    assert.ok(lastDownPlus != null && lastDownMinus != null);
    assert.ok(lastDownMinus > lastDownPlus);
  });
});

describe("bollinger", () => {
  it("returns nulls until warm and matches SMA ± population std", () => {
    const values = [1, 2, 3, 4, 5];
    const { mid, upper, lower } = bollinger(values, 3, 2);
    assert.equal(mid[0], null);
    assert.equal(mid[1], null);
    // Window [1,2,3]: mean=2, pop-var=((1-2)^2+(2-2)^2+(3-2)^2)/3=2/3, sd=sqrt(2/3)
    const mean = 2;
    const sd = Math.sqrt(2 / 3);
    assert.ok(mid[2] != null);
    assert.ok(Math.abs(mid[2] - mean) < 1e-12);
    assert.ok(upper[2] != null && lower[2] != null);
    assert.ok(Math.abs(upper[2] - (mean + 2 * sd)) < 1e-12);
    assert.ok(Math.abs(lower[2] - (mean - 2 * sd)) < 1e-12);
    assert.ok(mid[4] != null);
  });

  it("rejects invalid period or stdDev", () => {
    assert.throws(() => bollinger([], 0, 2), /Bollinger period/);
    assert.throws(() => bollinger([1, 2, 3], 2, 0), /Bollinger stdDev/);
  });
});

describe("ema/rsi smoke", () => {
  it("ema warms at period-1", () => {
    const values = [1, 2, 3, 4, 5];
    const series = ema(values, 3);
    assert.equal(series[0], null);
    assert.equal(series[1], null);
    assert.equal(series[2], 2);
  });

  it("rsi warms at period", () => {
    const values = [1, 2, 3, 4, 5, 6];
    const series = rsi(values, 3);
    assert.equal(series[0], null);
    assert.equal(series[2], null);
    assert.ok(series[3] != null);
  });
});
