import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandle } from "../../market/candle.js";
import type { Candle, MarketIndicators, PerpsFees } from "../../types.js";
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
    rsiOversold: 30,
    rsiOverbought: 70,
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

  it("holds a lower-band exit when RSI is not oversold", () => {
    const signal = evalRsi(crashThroughLower(), loose({ rsiOversold: -1 }));
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /RSI .* > -1/);
  });

  it("holds when price stays inside the band even if the RSI gate would pass", () => {
    const start = 1_700_000_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) candles.push(bar(start + i * 3600, 100, 0.05));
    const signal = evalRsi(candles, loose({ rsiOversold: 100 }));
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
    const signal = evalRsi(spikeThroughUpper(), loose({ rsiOverbought: 101 }), {
      perpsFees: PERPS,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /RSI .* < 101/);
  });

  it("exits an open long through the Bollinger mid and keeps its own id", () => {
    const candles = crashThroughLower().slice(0, 40);
    const signal = evalRsi(candles, loose(), {
      price: 101,
      entryPrice: 95,
      positionSide: "long",
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.equal(signal.strategyId, "bollinger-rsi");
    assert.ok(signal.meta?.rsi != null);
  });
});

describe("BollingerRsiStrategy", () => {
  it("uses registry id bollinger-rsi and names the RSI gates", () => {
    const strategy = new BollingerRsiStrategy();
    assert.equal(strategy.getId(), "bollinger-rsi");
    assert.equal(strategyModule.id, strategy.getId());
    assert.match(strategy.getDisplayName(), /bollinger-rsi \(1h BB20×2 RSI14 ≤30\/≥70/);
    assert.match(strategy.getDisplayName(), /decay12/);
    assert.equal(strategy.getRequiredCandles().timeframe, "1h");
  });

  it("keeps every default on a search level and rejects an inverted RSI gate", () => {
    const strategy = new BollingerRsiStrategy();
    const defaults = strategy.getSearchDefaults();
    for (const axis of strategy.axes) {
      assert.ok(axis.levels.includes(defaults[axis.key] ?? Number.NaN), axis.key);
    }
    assert.equal(strategy.accept({ ...defaults, rsiOversold: 80, rsiOverbought: 70 }), false);
    assert.equal(strategy.accept(defaults), true);
  });

  it("patches RSI knobs and turns search minutes into a candle label", () => {
    const patch = new BollingerRsiStrategy().paramPatch({
      rsiPeriod: 7,
      rsiOversold: 20,
      timeframe: 60,
    });
    assert.equal(patch.timeframe, "1h");
    assert.deepEqual(patch.values, { rsiPeriod: 7, rsiOversold: 20 });
  });

  it("forwards an open position into the signal", () => {
    const candles = crashThroughLower().slice(0, 40);
    const last = candles[candles.length - 1]!;
    const at = new Date((last.time + 15 * 60) * 1000);
    const signal = new BollingerRsiStrategy("flat", "low", loose()).evaluateSignal(
      "SOL/USDC",
      candles,
      { pair: "SOL/USDC", price: 101, trend: "flat", volatility: "low" } satisfies MarketIndicators,
      101,
      at,
      {
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
      },
    );
    assert.equal(signal.side, "SELL", signal.reason);
    assert.equal(signal.strategyId, "bollinger-rsi");
  });
});
