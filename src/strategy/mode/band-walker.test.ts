import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandle } from "../../market/candle.js";
import type { Candle, PerpsFees } from "../../types.js";
import { atr } from "../indicators.js";
import {
  BandWalkerStrategy,
  bandWalkerParamsFor,
  bandWalkerStopPrice,
  bandWalkerTrailPrice,
  evaluateBandWalker,
  type BandWalkerParams,
} from "./band-walker.js";

const INTERVAL = 60 * 60;
const START = 1_700_000_000;
const FEES: PerpsFees = { openFeePct: 0.001, closeFeePct: 0.001, borrowFeePctPerHour: 0 };

function params(overrides: Partial<BandWalkerParams> = {}): BandWalkerParams {
  return {
    ...bandWalkerParamsFor(),
    period: 10,
    stdDev: 1,
    atrPeriod: 5,
    adxPeriod: 5,
    diRatio: 0,
    ...overrides,
  };
}

function bar(index: number, close: number, range = 0.3): Candle {
  return createCandle({
    time: START + index * INTERVAL,
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume: 10,
    timeframe: "1h",
  });
}

/**
 * Steep move with a wick against the trend so both +DI and −DI are non-zero.
 * Closes still run away from a lagging band.
 */
function trend(direction: 1 | -1): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) candles.push(bar(i, 100, 0.4));
  let price = 100;
  for (let i = 0; i < 8; i++) {
    price += direction * (3 + i);
    const close = price;
    const against = i < 4 ? 8 : 0;
    candles.push(
      createCandle({
        time: START + (30 + i) * INTERVAL,
        open: close,
        high: close + 0.4 + (direction < 0 ? against : 0),
        low: close - 0.4 - (direction > 0 ? against : 0),
        close,
        volume: 10,
        timeframe: "1h",
      }),
    );
  }
  return candles;
}

function rally(): Candle[] {
  return trend(1);
}

function selloff(): Candle[] {
  return trend(-1);
}

function evalWalk(
  candles: Candle[],
  strategy: BandWalkerParams,
  extra: Partial<Parameters<typeof evaluateBandWalker>[0]> = {},
) {
  const last = candles[candles.length - 1]!;
  return evaluateBandWalker({
    pair: "SOL/USDC",
    candles,
    strategy,
    price: last.close,
    at: new Date((last.time + last.intervalSeconds) * 1000),
    trend: "flat",
    volatility: "low",
    ...extra,
  });
}

/** First prefix whose closed bar opens a position. */
function firstEntry(
  candles: Candle[],
  strategy: BandWalkerParams,
  side: "BUY" | "SELL",
  extra: Partial<Parameters<typeof evaluateBandWalker>[0]> = {},
): { candles: Candle[]; signal: ReturnType<typeof evalWalk> } | null {
  for (let n = strategy.period + strategy.slopeBars; n <= candles.length; n++) {
    const slice = candles.slice(0, n);
    const signal = evalWalk(slice, strategy, extra);
    if (signal.side === side) return { candles: slice, signal };
  }
  return null;
}

describe("bandWalkerParamsFor", () => {
  it("uses the 1h walk defaults", () => {
    const p = bandWalkerParamsFor();
    assert.equal(p.timeframe, "1h");
    assert.equal(p.period, 20);
    assert.equal(p.stdDev, 2);
    assert.equal(p.atrPeriod, 14);
    assert.equal(p.adxPeriod, 14);
    assert.equal(p.diRatio, 1.2);
    assert.equal(p.slopeBars, 5);
    assert.equal(p.walkWindow, 5);
    assert.equal(p.walkHits, 3);
    assert.equal(p.percentBMin, 0.8);
    assert.equal(p.stopAtr, 0.5);
    assert.equal(p.trailArmAtr, 1.5);
    assert.equal(p.trailAtr, 2.5);
    assert.equal(p.trailLockEntry, true);
  });
});

describe("evaluateBandWalker entries", () => {
  it("buys the first closed bar of an upper walk and sets an empty target", () => {
    const strategy = params();
    const found = firstEntry(rally(), strategy, "BUY");
    assert.ok(found, "expected an upper-walk entry");
    const { candles, signal } = found;
    assert.deepEqual(signal.tpPrices, []);
    assert.equal(signal.minRewardRisk, 0);
    assert.equal(signal.strategyId, "band-walker");
    assert.ok(signal.slPrice != null && signal.slPrice < signal.price);
    const lows = candles.slice(-strategy.walkWindow).map((c) => c.low);
    const extreme = Math.min(...lows);
    const atrNow = atr(candles, strategy.atrPeriod).at(-1);
    assert.ok(atrNow != null);
    assert.ok(
      Math.abs(signal.slPrice - bandWalkerStopPrice("long", extreme, atrNow, strategy.stopAtr)) <
        1e-8,
    );
  });

  it("does not open again on the next bar of the same walk", () => {
    const strategy = params();
    const series = rally();
    const found = firstEntry(series, strategy, "BUY");
    assert.ok(found, "expected an upper-walk entry");
    const next = series[found.candles.length];
    assert.ok(next);
    const second = evalWalk([...found.candles, next], strategy);
    assert.equal(second.side, "HOLD", second.reason);
    assert.match(second.reason, /previous bar already qualified/);
  });

  it("ignores a single close outside the band", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) candles.push(bar(i, 100, 0.4));
    candles.push(bar(30, 120, 0.4));
    const signal = evalWalk(candles, params());
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /closes with %B/);
  });

  it("ignores an upper close when +DI does not lead", () => {
    const open = params();
    const found = firstEntry(rally(), open, "BUY");
    assert.ok(found, "expected an upper-walk entry");
    const signal = evalWalk(found.candles, params({ diRatio: 100 }));
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /\+DI/);
  });

  it("ignores a lower walk without a perps fee schedule", () => {
    const withFees = firstEntry(selloff(), params(), "SELL", { perpsFees: FEES });
    assert.ok(withFees, "expected a lower-walk entry");
    const signal = evalWalk(withFees.candles, params());
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /perps fee schedule missing/);
  });

  it("sells the first closed bar of a lower walk when perps fees are present", () => {
    const strategy = params();
    const found = firstEntry(selloff(), strategy, "SELL", { perpsFees: FEES });
    assert.ok(found, "expected a lower-walk entry");
    const { candles, signal } = found;
    assert.deepEqual(signal.tpPrices, []);
    assert.equal(signal.minRewardRisk, 0);
    assert.ok(signal.slPrice != null && signal.slPrice > signal.price);
    const highs = candles.slice(-strategy.walkWindow).map((c) => c.high);
    const extreme = Math.max(...highs);
    const atrNow = atr(candles, strategy.atrPeriod).at(-1);
    assert.ok(atrNow != null);
    assert.ok(
      Math.abs(signal.slPrice - bandWalkerStopPrice("short", extreme, atrNow, strategy.stopAtr)) <
        1e-8,
    );
  });

  it("does not enter on a forming bar", () => {
    const strategy = params();
    const found = firstEntry(rally(), strategy, "BUY");
    assert.ok(found, "expected an upper-walk entry");
    const entry = found.candles[found.candles.length - 1]!;
    const prior = found.candles.slice(0, -1);
    const signal = evalWalk([...prior, entry], strategy, {
      at: new Date((entry.time + 10) * 1000),
      price: entry.close,
    });
    assert.notEqual(signal.side, "BUY", signal.reason);
  });
});

describe("evaluateBandWalker exits", () => {
  it("sells a long when the closed bar is back through the middle", () => {
    const candles = rally();
    const last = candles[candles.length - 1]!;
    candles.push(bar(candles.length, 90, 0.4));
    const signal = evalWalk(candles, params(), {
      entryPrice: last.close,
      positionSide: "long",
      openedAt: new Date((last.time + INTERVAL) * 1000),
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /Walk over/);
    assert.deepEqual(signal.tpPrices, []);
  });

  it("covers a short when the closed bar is back through the middle", () => {
    const candles = selloff();
    const last = candles[candles.length - 1]!;
    candles.push(bar(candles.length, 110, 0.4));
    const signal = evalWalk(candles, params(), {
      entryPrice: last.close,
      positionSide: "short",
      openedAt: new Date((last.time + INTERVAL) * 1000),
      perpsFees: FEES,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /Walk over/);
  });

  it("holds a long and proposes the chandelier once the move has armed", () => {
    const candles = rally();
    const strategy = params({ trailArmAtr: 0, trailAtr: 1, trailLockEntry: true });
    const entryIndex = 32;
    const entryBar = candles[entryIndex]!;
    const openedAt = new Date((entryBar.time + INTERVAL) * 1000);
    const signal = evalWalk(candles, strategy, {
      entryPrice: entryBar.close,
      positionSide: "long",
      openedAt,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    const atrNow = atr(candles, strategy.atrPeriod).at(-1);
    assert.ok(atrNow != null);
    let extreme = entryBar.close;
    for (const candle of candles) {
      if (candle.time + INTERVAL <= openedAt.getTime() / 1000) continue;
      extreme = Math.max(extreme, candle.high);
    }
    const expected = bandWalkerTrailPrice({
      side: "long",
      entryPrice: entryBar.close,
      extreme,
      atrValue: atrNow,
      trailAtr: strategy.trailAtr,
      trailArmAtr: strategy.trailArmAtr,
      trailLockEntry: true,
    });
    assert.ok(expected != null);
    assert.equal(signal.slPrice, expected);
    assert.ok(signal.slPrice != null && signal.slPrice >= entryBar.close);
  });

  it("does not propose a trail before the move has armed", () => {
    const candles = rally();
    const entryBar = candles[32]!;
    const signal = evalWalk(candles, params({ trailArmAtr: 100 }), {
      entryPrice: entryBar.close,
      positionSide: "long",
      openedAt: new Date((entryBar.time + INTERVAL) * 1000),
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.equal(signal.slPrice, undefined);
    assert.match(signal.reason, /trail not armed/);
  });

  it("ignores a forming bar's high when placing the trail", () => {
    const candles = rally();
    const strategy = params({ trailArmAtr: 0, trailAtr: 1, trailLockEntry: false });
    const entryBar = candles[32]!;
    const openedAt = new Date((entryBar.time + INTERVAL) * 1000);
    const without = evalWalk(candles, strategy, {
      entryPrice: entryBar.close,
      positionSide: "long",
      openedAt,
    });
    const last = candles[candles.length - 1]!;
    const forming = createCandle({
      time: last.time + INTERVAL,
      open: last.close,
      high: last.high + 50,
      low: last.close - 0.2,
      close: last.close + 1,
      volume: 10,
      timeframe: "1h",
    });
    const withForming = evalWalk([...candles, forming], strategy, {
      entryPrice: entryBar.close,
      positionSide: "long",
      openedAt,
      at: new Date((forming.time + 10) * 1000),
      price: forming.close,
    });
    assert.equal(withForming.slPrice, without.slPrice);
    assert.equal(withForming.meta?.barHigh, forming.high);
  });
});

describe("bandWalkerTrailPrice", () => {
  it("locks the armed long stop at the fill", () => {
    const level = bandWalkerTrailPrice({
      side: "long",
      entryPrice: 100,
      extreme: 106,
      atrValue: 4,
      trailAtr: 2.5,
      trailArmAtr: 1,
      trailLockEntry: true,
    });
    assert.equal(level, 100);
  });

  it("stays off until the extreme clears the arm distance", () => {
    const level = bandWalkerTrailPrice({
      side: "short",
      entryPrice: 100,
      extreme: 99,
      atrValue: 2,
      trailAtr: 2.5,
      trailArmAtr: 1.5,
      trailLockEntry: true,
    });
    assert.equal(level, null);
  });
});

describe("BandWalkerStrategy", () => {
  it("names the 1h walk and charts Bollinger bands", () => {
    const strategy = new BandWalkerStrategy();
    assert.equal(strategy.getId(), "band-walker");
    assert.match(strategy.getDisplayName(), /1h BB20×2 %B0\.8 3\/5 DI1\.2/);
    assert.equal(strategy.getRequiredCandles().timeframe, "1h");
    const svg = strategy.buildChartSvg("SOL/USDC", rally());
    assert.match(svg, /1h/);
    assert.match(svg, /BB\(20, 2\)/);
  });
});
