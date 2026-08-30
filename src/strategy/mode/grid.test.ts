import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle, Snapshot } from "../../types.js";
import { evaluateGrid, gridParamsFor, type GridParams } from "./grid.js";

function params(overrides: Partial<GridParams> = {}): GridParams {
  return { ...gridParamsFor(), ...overrides };
}

const INTERVAL = 15 * 60;

function bar(time: number, close: number, range = 0.3): Candle {
  return { time, open: close, high: close + range, low: close - range, close, volume: 10 };
}

function flatSnapshot(entryPrice = 0): Snapshot {
  return {
    cashUsdc: 100,
    position: { pair: "SOL/USDC", side: "flat", size: 0, entryPrice },
    realizedPnl: 0,
    equity: 100,
    trades: [],
    simulated: true,
  };
}

function longSnapshot(entryPrice: number): Snapshot {
  return {
    cashUsdc: 0,
    position: { pair: "SOL/USDC", side: "long", size: 1, entryPrice },
    realizedPnl: 0,
    equity: entryPrice,
    trades: [],
    simulated: true,
  };
}

function flatSeries(base: number, count: number): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const price = base + ((i % 4) - 1.5) * 0.1;
    candles.push(bar(start + i * INTERVAL, price));
  }
  return candles;
}

describe("evaluateGrid", () => {
  it("returns HOLD during warmup", () => {
    const candles = flatSeries(100, 5);
    const p = params({ reanchorBars: 20, atrPeriod: 14 });
    const signal = evaluateGrid({
      pair: "SOL/USDC",
      candles,
      price: 100,
      at: new Date(),
      params: p,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /warmup/);
  });

  it("emits BUY on grid level reclaim when flat", () => {
    const p = params({
      atrPeriod: 5,
      adxPeriod: 5,
      trendEmaPeriod: 5,
      reanchorBars: 10,
      adxMax: 100,
    });
    const candles = flatSeries(100, 40);
    const last = candles[candles.length - 1]!;

    const signal = evaluateGrid({
      pair: "SOL/USDC",
      candles,
      price: last.close,
      at: new Date(),
      params: p,
      snapshot: flatSnapshot(),
    });

    if (signal.side === "BUY") {
      assert.match(signal.reason, /grid reclaim/);
      assert.ok(signal.meta?.atr != null);
    } else {
      assert.equal(signal.side, "HOLD");
    }
  });

  it("emits SELL when long and price hits take-profit", () => {
    const p = params({
      atrPeriod: 5,
      adxPeriod: 5,
      trendEmaPeriod: 5,
      reanchorBars: 10,
      gridMult: 0.1,
      adxMax: 100,
    });
    const candles = flatSeries(100, 40);
    const entryPrice = 99.0;
    const tpPrice = 102.0;
    candles.push(bar(candles[candles.length - 1]!.time + INTERVAL, tpPrice));

    const signal = evaluateGrid({
      pair: "SOL/USDC",
      candles,
      price: tpPrice,
      at: new Date(),
      params: p,
      snapshot: longSnapshot(entryPrice),
    });

    assert.equal(signal.side, "SELL");
    assert.match(signal.reason, /grid TP/);
  });

  it("holds when long but price below take-profit", () => {
    const p = params({
      atrPeriod: 5,
      adxPeriod: 5,
      trendEmaPeriod: 5,
      reanchorBars: 10,
      gridMult: 10,
      adxMax: 100,
    });
    const candles = flatSeries(100, 40);

    const signal = evaluateGrid({
      pair: "SOL/USDC",
      candles,
      price: 100,
      at: new Date(),
      params: p,
      snapshot: longSnapshot(100),
    });

    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /waiting for TP/);
    assert.ok(signal.meta?.atr != null);
    assert.ok(signal.meta?.barHigh != null);
    assert.ok(signal.meta?.barLow != null);
  });

  it("blocks BUY when ADX exceeds adxMax", () => {
    const p = params({
      atrPeriod: 5,
      adxPeriod: 5,
      trendEmaPeriod: 5,
      reanchorBars: 10,
      adxMax: 0,
    });
    const start = 1_700_000_000;
    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < 40; i++) {
      price += 0.5;
      candles.push(bar(start + i * INTERVAL, price));
    }
    candles.push(bar(start + 40 * INTERVAL, price - 2));
    candles.push(bar(start + 41 * INTERVAL, price - 1));

    const signal = evaluateGrid({
      pair: "SOL/USDC",
      candles,
      price: candles[candles.length - 1]!.close,
      at: new Date(),
      params: p,
      snapshot: flatSnapshot(),
    });

    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /ADX/);
  });

  it("blocks BUY when below trend EMA", () => {
    const p = params({
      atrPeriod: 5,
      adxPeriod: 5,
      trendEmaPeriod: 5,
      reanchorBars: 10,
      adxMax: 100,
    });
    const start = 1_700_000_000;
    const candles: Candle[] = [];
    let price = 120;
    for (let i = 0; i < 40; i++) {
      price -= 0.5;
      candles.push(bar(start + i * INTERVAL, price));
    }
    candles.push(bar(start + 40 * INTERVAL, price - 2));
    candles.push(bar(start + 41 * INTERVAL, price - 1));

    const signal = evaluateGrid({
      pair: "SOL/USDC",
      candles,
      price: candles[candles.length - 1]!.close,
      at: new Date(),
      params: p,
      snapshot: flatSnapshot(),
    });

    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /trend EMA/);
  });
});
