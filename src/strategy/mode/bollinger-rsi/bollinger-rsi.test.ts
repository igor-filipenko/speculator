import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandle } from "../../../market/candle.js";
import type { Candle, PerpsFees } from "../../../types.js";
import {
  BollingerRsiStrategy,
  bollingerRsiParamsFor,
  strategyModule,
  evaluateBollingerRsi,
  type BollingerRsiParams,
} from "./bollinger-rsi.js";

const PERPS: PerpsFees = {
  openFeePct: 0.0006,
  closeFeePct: 0.0006,
  borrowFeePctPerHour: 0.000007,
};

function loose(overrides: Partial<BollingerRsiParams> = {}): BollingerRsiParams {
  return {
    ...bollingerRsiParamsFor(),
    period: 20,
    stdDev: 2,
    atrPeriod: 5,
    adxPeriod: 5,
    adxMax: 0,
    maxBreakAtr: 0,
    minRewardRisk: 0,
    rsiPeriod: 5,
    rsiThreshold: 30,
    ...overrides,
  };
}

function bar(time: number, close: number, range = 0.4): Candle {
  return createCandle({
    time,
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume: 10,
  });
}

/** Flat closes, then one print far through the lower band. RSI collapses. */
function crashThroughLower(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) candles.push(bar(start + i * 3600, 100));
  candles.push(bar(start + 40 * 3600, 90, 1));
  return candles;
}

/** Flat closes, then one print far through the upper band. RSI saturates. */
function spikeThroughUpper(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) candles.push(bar(start + i * 3600, 100));
  candles.push(bar(start + 40 * 3600, 110, 1));
  return candles;
}

function evalRsi(
  candles: Candle[],
  strategy: BollingerRsiParams,
  extra: Partial<Parameters<typeof evaluateBollingerRsi>[0]> = {},
) {
  const last = candles[candles.length - 1]!;
  return evaluateBollingerRsi({
    pair: "SOL/USDC",
    candles,
    strategy,
    price: last.close,
    at: new Date((last.time + last.intervalSeconds) * 1000),
    ...extra,
  });
}

describe("evaluateBollingerRsi", () => {
  it("buys a lower-band exit when RSI is oversold", () => {
    const candles = crashThroughLower();
    const signal = evalRsi(candles, loose());
    assert.equal(signal.side, "BUY", signal.reason);
    assert.equal(signal.strategyId, "bollinger-rsi");
    assert.ok((signal.meta?.rsi ?? 100) <= 30, signal.reason);
    assert.ok(signal.slPrice != null && signal.slPrice < signal.price);
    assert.ok((signal.tpPrices[0] ?? 0) > signal.price);
  });

  it("does not buy the same closed bar again after its first minute", () => {
    const candles = crashThroughLower();
    const last = candles[candles.length - 1]!;
    const closedAt = (last.time + last.intervalSeconds) * 1000;
    const fresh = evalRsi(candles, loose(), { at: new Date(closedAt + 30_000) });
    assert.equal(fresh.side, "BUY", fresh.reason);
    const stale = evalRsi(candles, loose(), { at: new Date(closedAt + 90_000) });
    assert.equal(stale.side, "HOLD", stale.reason);
    assert.match(stale.reason, /one entry per closed bar/);
  });

  it("holds a lower-band exit when RSI is not oversold", () => {
    const signal = evalRsi(crashThroughLower(), loose({ rsiThreshold: -1 }));
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /RSI .* > -1/);
  });

  it("holds when price stays inside the band even if the RSI gate would pass", () => {
    const start = 1_700_000_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) candles.push(bar(start + i * 3600, 100, 0.05));
    const signal = evalRsi(candles, loose({ rsiThreshold: 100 }));
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /No BB\+RSI signal/);
  });

  it("shorts an upper-band exit when RSI is overbought", () => {
    const signal = evalRsi(spikeThroughUpper(), loose(), { perpsFees: PERPS });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.equal(signal.strategyId, "bollinger-rsi");
    assert.ok((signal.meta?.rsi ?? 0) >= 70, signal.reason);
    assert.ok(signal.slPrice != null && signal.slPrice > signal.price);
  });

  it("does not short without a perps fee schedule", () => {
    const signal = evalRsi(spikeThroughUpper(), loose());
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /perps fee schedule missing/);
  });

  it("holds an upper-band exit when RSI is not overbought", () => {
    const signal = evalRsi(spikeThroughUpper(), loose({ rsiThreshold: -1 }), {
      perpsFees: PERPS,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /RSI .* < 101/);
  });

  it("closes the whole long at the mid once RSI has reached 50", () => {
    const candles = crashThroughLower().slice(0, 40);
    const signal = evalRsi(candles, loose(), {
      price: 101,
      entryPrice: 95,
      positionSide: "long",
      slPrice: 90,
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.equal(signal.strategyId, "bollinger-rsi");
    assert.equal(signal.closeFraction, undefined);
    assert.ok((signal.meta?.rsi ?? 0) >= 50);
    assert.match(signal.reason, /closing the position/);
  });

  it("sells half at the mid while RSI is still below 50", () => {
    const candles = wave("down");
    const signal = evalRsi(candles, loose({ decayBars: 0, rsiMid: 50 }), {
      price: 108,
      entryPrice: 100,
      positionSide: "long",
      slPrice: 90,
    });
    assert.ok((signal.meta?.rsi ?? 100) < 50, signal.reason);
    assert.equal(signal.side, "SELL", signal.reason);
    assert.equal(signal.closeFraction, 0.5);
    assert.ok(signal.slPrice != null && signal.slPrice > 100);
  });

  it("sells the remainder at the upper band and scratches it at breakeven", () => {
    const candles = wave("down");
    const half = evalRsi(candles, loose({ decayBars: 0, rsiMid: 50 }), {
      price: 108,
      entryPrice: 100,
      positionSide: "long",
      slPrice: 90,
    });
    assert.equal(half.side, "SELL", half.reason);
    assert.equal(half.closeFraction, 0.5);
    const upper = half.meta?.bbUpper ?? 0;
    const breakeven = half.slPrice ?? 0;
    assert.ok(upper > 108, half.reason);
    assert.ok(breakeven > 100 && breakeven < 108);

    const hold = evalRsi(candles, loose({ decayBars: 0 }), {
      price: 108,
      entryPrice: 100,
      positionSide: "long",
      slPrice: breakeven,
    });
    assert.equal(hold.side, "HOLD", hold.reason);
    assert.equal(hold.meta?.barLow, 108);
    assert.equal(hold.closeFraction, undefined);

    const runner = evalRsi(candles, loose({ decayBars: 0 }), {
      price: upper,
      entryPrice: 100,
      positionSide: "long",
      slPrice: breakeven,
    });
    assert.equal(runner.side, "SELL", runner.reason);
    assert.equal(runner.closeFraction, undefined);
    assert.match(runner.reason, /upper band/);

    const scratch = evalRsi(candles, loose({ decayBars: 0 }), {
      price: breakeven,
      entryPrice: 100,
      positionSide: "long",
      slPrice: breakeven,
    });
    assert.equal(scratch.side, "SELL", scratch.reason);
    assert.match(scratch.reason, /breakeven/);
  });

  it("covers half of a short at the mid and the rest at the lower band", () => {
    const candles = wave("up");
    const half = evalRsi(candles, loose({ decayBars: 0, rsiMid: 50 }), {
      price: 102,
      entryPrice: 110,
      positionSide: "short",
      slPrice: 120,
      perpsFees: PERPS,
    });
    assert.ok((half.meta?.rsi ?? 0) > 50, half.reason);
    assert.equal(half.side, "BUY", half.reason);
    assert.equal(half.closeFraction, 0.5);
    const lower = half.meta?.bbLower ?? 0;
    const breakeven = half.slPrice ?? 0;
    assert.ok(lower < 102, half.reason);
    assert.ok(breakeven < 110 && breakeven > 102);

    const hold = evalRsi(candles, loose({ decayBars: 0 }), {
      price: 102,
      entryPrice: 110,
      positionSide: "short",
      slPrice: breakeven,
      perpsFees: PERPS,
    });
    assert.equal(hold.side, "HOLD", hold.reason);

    const runner = evalRsi(candles, loose({ decayBars: 0 }), {
      price: lower,
      entryPrice: 110,
      positionSide: "short",
      slPrice: breakeven,
      perpsFees: PERPS,
    });
    assert.equal(runner.side, "BUY", runner.reason);
    assert.equal(runner.closeFraction, undefined);
    assert.match(runner.reason, /lower band/);
  });

  it("covers the whole short at the mid once RSI has fallen to 50", () => {
    const signal = evalRsi(wave("down"), loose({ decayBars: 0 }), {
      price: 102,
      entryPrice: 110,
      positionSide: "short",
      slPrice: 120,
      perpsFees: PERPS,
    });
    assert.ok((signal.meta?.rsi ?? 100) <= 50, signal.reason);
    assert.equal(signal.side, "BUY", signal.reason);
    assert.equal(signal.closeFraction, undefined);
    assert.match(signal.reason, /closing the position/);
  });

  it("flattens the whole position when the decay horizon is reached", () => {
    const candles = wave("down");
    const last = candles[candles.length - 1]!;
    const openedAt = new Date(last.time * 1000);
    const at = new Date((last.time + 20 * 3600) * 1000);
    const signal = evalRsi(candles, loose({ decayBars: 12 }), {
      price: 100,
      entryPrice: 90,
      positionSide: "long",
      slPrice: 80,
      openedAt,
      at,
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.equal(signal.closeFraction, undefined);
    assert.match(signal.reason, /Time decay/);
  });
});

/**
 * Alternating closes so the mid sits near 105 and the bands stay wide.
 * `down` ends on the lower close, which leaves RSI below 50.
 */
function wave(end: "up" | "down"): Candle[] {
  const start = 1_700_000_000;
  const count = end === "up" ? 40 : 41;
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) candles.push(bar(start + i * 3600, i % 2 === 0 ? 100 : 110, 0.5));
  return candles;
}

describe("BollingerRsiStrategy", () => {
  it("uses registry id bollinger-rsi and names the RSI gates", () => {
    const strategy = new BollingerRsiStrategy();
    assert.equal(strategy.getId(), "bollinger-rsi");
    assert.equal(strategyModule.id, strategy.getId());
    assert.match(strategy.getDisplayName(), /bollinger-rsi \(1h BB20×2 RSI14 ≤30\/≥70/);
    assert.match(strategy.getDisplayName(), /decay12/);
    assert.equal(strategy.getRequiredCandles().timeframe, "1h");
  });

  it("keeps every default on a search level", () => {
    const strategy = new BollingerRsiStrategy();
    const defaults = strategy.getSearchDefaults();
    for (const axis of strategy.axes) {
      assert.ok(axis.levels.includes(defaults[axis.key] ?? Number.NaN), axis.key);
    }
  });

  it("patches RSI knobs and turns search minutes into a candle label", () => {
    const patch = new BollingerRsiStrategy().paramPatch({
      rsiPeriod: 7,
      rsiThreshold: 20,
      timeframe: 60,
    });
    assert.equal(patch.timeframe, "1h");
    assert.deepEqual(patch.values, { rsiPeriod: 7, rsiThreshold: 20 });
  });

  it("forwards an open position into the signal", () => {
    const candles = crashThroughLower().slice(0, 40);
    const last = candles[candles.length - 1]!;
    const at = new Date((last.time + 15 * 60) * 1000);
    const signal = new BollingerRsiStrategy(loose()).evaluateSignal("SOL/USDC", candles, 101, at, {
      cashUsdc: 1000,
      position: {
        pair: "SOL/USDC",
        side: "long",
        size: 1,
        entryPrice: 95,
        strategyId: "bollinger-rsi",
        slPrice: 90,
      },
      realizedPnl: 0,
      equity: 1000,
      trades: [],
      nativeSol: 0,
      insufficientSol: 0,
      simulated: true,
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.equal(signal.strategyId, "bollinger-rsi");
  });
});
