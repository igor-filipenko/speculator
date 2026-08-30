import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle } from "../../types.js";
import { evaluateBollinger, bollingerParamsFor, type BollingerParams } from "./bollinger.js";
import { rsi } from "../indicators.js";

function baseParams(overrides: Partial<BollingerParams> = {}): BollingerParams {
  return { ...bollingerParamsFor(), ...overrides };
}

/** Loose filters so fixtures still fire BUY/SELL without the live oversold/ADX gates. */
function looseFilters(overrides: Partial<BollingerParams> = {}): BollingerParams {
  return baseParams({
    period: 10,
    stdDev: 2,
    trendEmaPeriod: 10,
    atrPeriod: 5,
    adxPeriod: 5,
    adxMax: 100,
    minBandToMidPct: 0.001,
    rsiPeriod: 5,
    rsiBuyMax: 100,
    ...overrides,
  });
}

function bar(time: number, close: number, range = 0.2): Candle {
  return {
    time,
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume: 10,
  };
}

const INTERVAL = 4 * 60 * 60;

/**
 * Flat range (trend EMA ~100), pierce lower, then reclaim well above EMA
 * but still below a typical mid after a deep spike.
 */
function reclaimLowerBand(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    const price = 100 + ((i % 6) - 2.5) * 0.35;
    candles.push(bar(start + i * INTERVAL, price, 0.25));
  }
  const t = start + 50 * INTERVAL;
  // Pierce lower band hard so std widens, then reclaim above trend EMA (~100).
  candles.push(bar(t, 96.5, 0.5));
  candles.push(bar(t + INTERVAL, 100.8, 0.35));
  return candles;
}

/** Same pierce as reclaim fixture but ends still below lower (no reclaim). */
function stuckBelowLower(): Candle[] {
  const candles = reclaimLowerBand();
  candles.pop();
  return candles;
}

/** Flat series ending near/above the middle of the band. */
function reboundToMid(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const price = 100 + ((i % 4) - 1.5) * 0.2;
    candles.push(bar(start + i * INTERVAL, price, 0.15));
  }
  candles.push(bar(start + 40 * INTERVAL, 100.4, 0.15));
  return candles;
}

/** Downtrend then lower reclaim — should fail trend EMA filter. */
function reclaimInDowntrend(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  let price = 120;
  for (let i = 0; i < 60; i++) {
    price -= 0.4;
    candles.push(bar(start + i * INTERVAL, price, 0.25));
  }
  const t = start + 60 * INTERVAL;
  candles.push(bar(t, price - 2, 0.4));
  candles.push(bar(t + INTERVAL, price - 0.5, 0.3));
  return candles;
}

describe("evaluateBollinger filters", () => {
  it("emits BUY on lower-band reclaim when filters pass", () => {
    const candles = reclaimLowerBand();
    const strategy = looseFilters();
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /Reclaimed lower BB/i);
    assert.ok(signal.meta?.bbLower != null);
    assert.ok(signal.meta?.trendEma != null);
    assert.ok(signal.meta?.atr != null);
    assert.ok(signal.meta?.rsi != null);
  });

  it("does not BUY while still below lower (no reclaim)", () => {
    const candles = stuckBelowLower();
    const strategy = looseFilters();
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD");
  });

  it("ignores reclaim when ADX exceeds adxMax", () => {
    const candles = reclaimLowerBand();
    const strategy = looseFilters({ adxMax: 0 });
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /ADX/);
  });

  it("ignores reclaim when close is below trend EMA", () => {
    const candles = reclaimInDowntrend();
    const strategy = looseFilters({ trendEmaPeriod: 20 });
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /trend EMA/);
  });

  it("ignores reclaim when band→mid distance is too small", () => {
    const candles = reclaimLowerBand();
    const strategy = looseFilters({ minBandToMidPct: 0.5 });
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /band→mid/);
  });

  it("emits SELL when close is at or above BB mid", () => {
    const candles = reboundToMid();
    const strategy = looseFilters();
    const last = candles[candles.length - 1]!;
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: last.close,
    });
    assert.ok(signal.meta?.bbMid != null);
    assert.ok(last.close >= signal.meta.bbMid);
    assert.equal(signal.side, "SELL");
    assert.match(signal.reason, /BB mid/);
  });

  it("ignores reclaim when RSI is not oversold", () => {
    const candles = reclaimLowerBand();
    const rsiPeriod = 5;
    const rsiNow = rsi(
      candles.map((c) => c.close),
      rsiPeriod,
    ).at(-1);
    assert.ok(rsiNow != null);
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ rsiPeriod, rsiBuyMax: rsiNow }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /RSI/);
    assert.match(signal.reason, /not oversold/);
  });

  it("emits BUY when reclaim RSI is below rsiBuyMax", () => {
    const candles = reclaimLowerBand();
    const rsiPeriod = 5;
    const rsiNow = rsi(
      candles.map((c) => c.close),
      rsiPeriod,
    ).at(-1);
    assert.ok(rsiNow != null);
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ rsiPeriod, rsiBuyMax: rsiNow + 1 }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /RSI/);
  });
});
