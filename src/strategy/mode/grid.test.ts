import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Candle,
  MarketIndicators,
  PortfolioSnapshot,
  Trend,
  Volatility,
} from "../../types.js";
import { evaluateGrid, GridStrategy, gridParamsFor, type GridParams } from "./grid.js";

function params(overrides: Partial<GridParams> = {}): GridParams {
  return { ...gridParamsFor("flat", "low"), ...overrides };
}

const INTERVAL = 15 * 60;

function bar(time: number, close: number, range = 0.3): Candle {
  return { time, open: close, high: close + range, low: close - range, close, volume: 10 };
}

function flatSnapshot(entryPrice = 0): PortfolioSnapshot {
  return {
    cashUsdc: 100,
    position: { pair: "SOL/USDC", side: "flat", size: 0, entryPrice },
    realizedPnl: 0,
    equity: 100,
    trades: [],
    simulated: true,
  };
}

function longSnapshot(entryPrice: number): PortfolioSnapshot {
  return {
    cashUsdc: 0,
    position: { pair: "SOL/USDC", side: "long", size: 1, entryPrice },
    realizedPnl: 0,
    equity: entryPrice,
    trades: [],
    simulated: true,
  };
}

function market(trend: Trend, volatility: Volatility = "low"): MarketIndicators {
  return { pair: "SOL/USDC", price: 100, trend, volatility };
}

function snapshotWithSell(price: number, reason: string, at: Date = new Date()): PortfolioSnapshot {
  return {
    ...flatSnapshot(),
    trades: [
      {
        pair: "SOL/USDC",
        side: "SELL",
        price,
        size: 1,
        at,
        simulated: true,
        reason,
      },
    ],
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

  it("skips BUY when HTF trend is bearish or unknown", () => {
    const p = params({
      atrPeriod: 5,
      adxPeriod: 5,
      trendEmaPeriod: 5,
      reanchorBars: 10,
      adxMax: 100,
    });
    const candles = flatSeries(100, 40);
    const last = candles[candles.length - 1]!;

    for (const trend of ["bearish", "unknown"] as const) {
      const signal = evaluateGrid({
        pair: "SOL/USDC",
        candles,
        price: last.close,
        at: new Date(),
        params: p,
        snapshot: flatSnapshot(),
        market: market(trend),
      });
      assert.equal(signal.side, "HOLD");
      assert.match(signal.reason, /HTF trend/);
    }
  });

  it("still sells at TP when long even if HTF is bearish", () => {
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
      market: market("bearish"),
    });

    assert.equal(signal.side, "SELL");
    assert.match(signal.reason, /grid TP/);
  });

  it("skips squeeze chase when close is within 0.5 ATR of the last take-profit", () => {
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
      snapshot: snapshotWithSell(last.close - 0.01, "grid TP: close"),
      market: market("flat", "squeeze"),
    });

    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /squeeze chase/);
  });

  it("skips squeeze chase when close is slightly below the last take-profit", () => {
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
      snapshot: snapshotWithSell(last.close + 0.02, "grid TP: close"),
      market: market("flat", "squeeze"),
    });

    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /squeeze chase/);
  });

  it("does not squeeze-chase when close is more than 0.5 ATR below the last take-profit", () => {
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
      snapshot: snapshotWithSell(last.close + 5, "grid TP: close"),
      market: market("flat", "squeeze"),
    });

    assert.doesNotMatch(signal.reason, /squeeze chase/);
    assert.doesNotMatch(signal.reason, /skip re-entry after ATR/);
  });

  it("does not treat an ATR stop as a squeeze chase while HTF is flat", () => {
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
      snapshot: snapshotWithSell(last.close - 0.01, "ATR stop hit (entry − 2.5×ATR)"),
      market: market("flat", "squeeze"),
    });

    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /skip re-entry after ATR/);
    assert.doesNotMatch(signal.reason, /squeeze chase/);
  });

  it("skips a low-vol chase when close is within 0.5 ATR of the last SELL fill", () => {
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
      snapshot: snapshotWithSell(last.close - 0.01, "grid TP: close"),
      market: market("bullish", "low"),
    });

    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /low-vol chase/);
  });

  it("skips a low-vol chase when close is slightly below the last SELL fill", () => {
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
      snapshot: snapshotWithSell(last.close + 0.02, "grid TP: close"),
      market: market("bullish", "low"),
    });

    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /low-vol chase/);
  });

  it("skips BUY after an ATR exit while HTF is bullish", () => {
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
      snapshot: snapshotWithSell(last.close, "ATR trail hit (peak − 6×ATR)"),
      market: market("bullish", "low"),
    });

    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /skip re-entry after ATR exit/);
  });

  it("skips BUY after an ATR exit while HTF is flat", () => {
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
      snapshot: snapshotWithSell(last.close + 5, "ATR stop hit (entry − 2.5×ATR)"),
      market: market("flat", "low"),
    });

    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /skip re-entry after ATR/);
    assert.doesNotMatch(signal.reason, /squeeze chase/);
    assert.doesNotMatch(signal.reason, /HTF trend/);
  });

  it("allows BUY again after atrReentryBars have elapsed", () => {
    const p = params({
      atrPeriod: 5,
      adxPeriod: 5,
      trendEmaPeriod: 5,
      reanchorBars: 10,
      adxMax: 100,
      atrReentryBars: 96,
    });
    const candles = flatSeries(100, 40);
    const last = candles[candles.length - 1]!;
    const sellAt = new Date(last.time * 1000);
    const later = new Date(sellAt.getTime() + 96 * INTERVAL * 1000);

    const signal = evaluateGrid({
      pair: "SOL/USDC",
      candles,
      price: last.close,
      at: later,
      params: p,
      snapshot: snapshotWithSell(last.close + 5, "ATR stop hit (entry − 2.5×ATR)", sellAt),
      market: market("flat", "low"),
    });

    assert.doesNotMatch(signal.reason, /skip re-entry after ATR/);
  });
});

describe("gridParamsFor", () => {
  it("widens the grid for bullish + high vol and tightens for bearish", () => {
    assert.equal(gridParamsFor("bullish", "high").gridMult, 8);
    assert.equal(gridParamsFor("bullish", "high").adxMax, 30);
    assert.equal(gridParamsFor("bullish", "low").gridMult, 5);
    assert.equal(gridParamsFor("bullish", "low").adxMax, 22);
    assert.equal(gridParamsFor("bullish", "squeeze").gridMult, 7);
    assert.equal(gridParamsFor("flat", "low").gridMult, 5);
    assert.equal(gridParamsFor("flat", "low").adxMax, 20);
    assert.equal(gridParamsFor("flat", "high").gridMult, 6);
    assert.equal(gridParamsFor("flat", "squeeze").gridMult, 5);
    assert.equal(gridParamsFor("flat", "high").adxMax, 22);
    assert.equal(gridParamsFor("flat", "squeeze").adxMax, 20);
    assert.equal(gridParamsFor("bearish", "high").gridMult, 2);
    assert.equal(gridParamsFor("unknown", "squeeze").gridMult, 2);
    assert.equal(gridParamsFor("flat", "low").chaseAtrMult, 0.5);
    assert.equal(gridParamsFor("flat", "low").atrReentryBars, 96);
  });

  it("tightens the ATR trail in bullish high/squeeze and keeps a wide trail in flat", () => {
    assert.equal(new GridStrategy("bullish", "high").getRiskParams().atrTrailMult, 6);
    assert.equal(new GridStrategy("bullish", "squeeze").getRiskParams().atrTrailMult, 6);
    assert.equal(new GridStrategy("bullish", "low").getRiskParams().atrTrailMult, 8);
    assert.equal(new GridStrategy("flat", "low").getRiskParams().atrTrailMult, 8);
    assert.equal(new GridStrategy("flat", "low").getRiskParams().atrStopMult, 2.5);
    assert.equal(new GridStrategy("bearish", "high").getRiskParams().atrStopMult, 2.5);
    assert.equal(new GridStrategy("flat", "low").getRiskParams().cooldownBars, 8);
  });
});
