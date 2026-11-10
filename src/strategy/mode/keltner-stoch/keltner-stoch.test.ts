import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liquidityTierForPair, TIER_COSTS } from "../../../exchange/emulated/emulated-quote.js";
import { createCandle } from "../../../market/candle.js";
import type { Candle, MarketIndicators } from "../../../types.js";
import {
  KeltnerStochStrategy,
  evaluateKeltnerStoch,
  keltnerStochParamsFor,
  strategyModule,
  type KeltnerStochParams,
} from "./keltner-stoch.js";

function loose(overrides: Partial<KeltnerStochParams> = {}): KeltnerStochParams {
  return {
    ...keltnerStochParamsFor(),
    period: 20,
    atrMult: 2,
    atrPeriod: 5,
    adxPeriod: 5,
    adxMax: 0,
    atrSmaPeriod: 0,
    maxBreakAtr: 0,
    minRewardRisk: 0,
    kPeriod: 5,
    kSmooth: 1,
    dPeriod: 1,
    stochThreshold: 20,
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

/** Flat closes, then one print far through the lower channel. %K collapses. */
function crashThroughLower(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) candles.push(bar(start + i * 3600, 100));
  candles.push(bar(start + 40 * 3600, 90, 1));
  return candles;
}

function evalStoch(
  candles: Candle[],
  strategy: KeltnerStochParams,
  extra: Partial<Parameters<typeof evaluateKeltnerStoch>[0]> = {},
) {
  const last = candles[candles.length - 1]!;
  return evaluateKeltnerStoch({
    pair: "SOL/USDC",
    candles,
    strategy,
    price: last.close,
    at: new Date((last.time + last.intervalSeconds) * 1000),
    ...extra,
  });
}

describe("evaluateKeltnerStoch", () => {
  it("buys a lower-channel exit when %K is oversold", () => {
    const candles = crashThroughLower();
    const signal = evalStoch(candles, loose());
    assert.equal(signal.side, "BUY", signal.reason);
    assert.equal(signal.strategyId, "keltner-stoch");
    assert.ok((signal.meta?.stochK ?? 100) <= 20, signal.reason);
    assert.ok(signal.slPrice != null && signal.slPrice < signal.price);
    assert.ok((signal.tpPrices[0] ?? 0) > signal.price);
    const fee = TIER_COSTS[liquidityTierForPair("SOL/USDC")];
    const spot = fee.slippage + fee.poolFee;
    const price = signal.price;
    const sl = signal.slPrice ?? 0;
    const risk = price * (1 + spot) - sl * (1 - spot);
    assert.ok(risk > price - sl);
    assert.match(signal.reason, new RegExp(`risk=${risk.toFixed(4)}`));
  });

  it("does not buy the same closed bar again after its first minute", () => {
    const candles = crashThroughLower();
    const last = candles[candles.length - 1]!;
    const closedAt = (last.time + last.intervalSeconds) * 1000;
    const fresh = evalStoch(candles, loose(), { at: new Date(closedAt + 30_000) });
    assert.equal(fresh.side, "BUY", fresh.reason);
    const stale = evalStoch(candles, loose(), { at: new Date(closedAt + 90_000) });
    assert.equal(stale.side, "HOLD", stale.reason);
    assert.match(stale.reason, /one entry per closed bar/);
  });

  it("holds a lower-channel exit when %K is not oversold", () => {
    const signal = evalStoch(crashThroughLower(), loose({ stochThreshold: -1 }));
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /Stoch %K .* > -1/);
  });

  it("holds when price stays inside the channel even if the %K gate would pass", () => {
    const start = 1_700_000_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) candles.push(bar(start + i * 3600, 100, 0.05));
    const signal = evalStoch(candles, loose({ stochThreshold: 100 }));
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /No KC\+Stoch signal/);
  });

  it("holds a channel exit while ATR is not above its average", () => {
    const signal = evalStoch(driftDown(), atrGate());
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /ATR .* ≤ SMA5/);
  });

  it("buys a channel exit once ATR rises above its average", () => {
    const signal = evalStoch(flatThen(90, 2), atrGate());
    assert.equal(signal.side, "BUY", signal.reason);
  });

  it("ignores an open short", () => {
    const signal = evalStoch(wave("down"), loose(), {
      price: 102,
      entryPrice: 110,
      positionSide: "short",
      slPrice: 120,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /Short positions are not traded/);
  });

  it("closes the whole long at the mid once %K has reached 50", () => {
    const candles = crashThroughLower().slice(0, 40);
    const signal = evalStoch(candles, loose(), {
      price: 101,
      entryPrice: 95,
      positionSide: "long",
      slPrice: 90,
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.equal(signal.strategyId, "keltner-stoch");
    assert.equal(signal.closeFraction, undefined);
    assert.ok((signal.meta?.stochK ?? 0) >= 50);
    assert.match(signal.reason, /closing the position/);
    assert.match(signal.reason, /%K=/);
  });

  it("sells half at the mid while %K is still below 50", () => {
    const candles = wave("down");
    const signal = evalStoch(candles, loose({ decayBars: 0, stochMid: 50 }), {
      price: 108,
      entryPrice: 100,
      positionSide: "long",
      slPrice: 90,
    });
    assert.ok((signal.meta?.stochK ?? 100) < 50, signal.reason);
    assert.equal(signal.side, "SELL", signal.reason);
    assert.equal(signal.closeFraction, 0.5);
    assert.ok(signal.slPrice != null && signal.slPrice > 100);
  });

  it("sells the remainder at the upper channel and scratches it at breakeven", () => {
    const candles = wave("down");
    const half = evalStoch(candles, loose({ decayBars: 0, stochMid: 50 }), {
      price: 108,
      entryPrice: 100,
      positionSide: "long",
      slPrice: 90,
    });
    assert.equal(half.side, "SELL", half.reason);
    assert.equal(half.closeFraction, 0.5);
    const upper = half.meta?.kcUpper ?? 0;
    const breakeven = half.slPrice ?? 0;
    assert.ok(upper > 108, half.reason);
    assert.ok(breakeven > 100 && breakeven < 108);

    const hold = evalStoch(candles, loose({ decayBars: 0 }), {
      price: 108,
      entryPrice: 100,
      positionSide: "long",
      slPrice: breakeven,
    });
    assert.equal(hold.side, "HOLD", hold.reason);
    assert.equal(hold.meta?.barLow, 108);
    assert.equal(hold.closeFraction, undefined);

    const runner = evalStoch(candles, loose({ decayBars: 0 }), {
      price: upper,
      entryPrice: 100,
      positionSide: "long",
      slPrice: breakeven,
    });
    assert.equal(runner.side, "SELL", runner.reason);
    assert.equal(runner.closeFraction, undefined);
    assert.match(runner.reason, /upper channel/);
    assert.match(runner.reason, /%K=/);

    const scratch = evalStoch(candles, loose({ decayBars: 0 }), {
      price: breakeven,
      entryPrice: 100,
      positionSide: "long",
      slPrice: breakeven,
    });
    assert.equal(scratch.side, "SELL", scratch.reason);
    assert.match(scratch.reason, /breakeven/);
    assert.match(scratch.reason, /%K=/);
  });

  it("flattens the whole position when the decay horizon is reached", () => {
    const candles = wave("down");
    const last = candles[candles.length - 1]!;
    const openedAt = new Date(last.time * 1000);
    const at = new Date((last.time + 20 * 3600) * 1000);
    const signal = evalStoch(candles, loose({ decayBars: 12 }), {
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
    assert.match(signal.reason, /%K=/);
  });
});

/**
 * Alternating closes so the mid sits near 105 and the channel stays wide.
 * `down` ends on the lower close, which leaves %K below 50.
 */
function driftDown(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) candles.push(bar(start + i * 3600, 100 - i * 0.1, 0.4));
  return candles;
}

function flatThen(close: number, range: number): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) candles.push(bar(start + i * 3600, 100, 0.2));
  candles.push(bar(start + 30 * 3600, close, range));
  return candles;
}

function atrGate(): KeltnerStochParams {
  return loose({
    period: 5,
    atrPeriod: 5,
    atrSmaPeriod: 5,
    atrMult: 0.5,
    stochThreshold: 100,
    minRewardRisk: 0,
  });
}

function wave(end: "up" | "down"): Candle[] {
  const start = 1_700_000_000;
  const count = end === "up" ? 40 : 41;
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) candles.push(bar(start + i * 3600, i % 2 === 0 ? 100 : 110, 0.5));
  return candles;
}

describe("KeltnerStochStrategy", () => {
  it("uses registry id keltner-stoch and names the %K gates", () => {
    const strategy = new KeltnerStochStrategy();
    const params = keltnerStochParamsFor();
    assert.equal(strategy.getId(), "keltner-stoch");
    assert.equal(strategyModule.id, strategy.getId());
    assert.match(
      strategy.getDisplayName(),
      new RegExp(
        `keltner-stoch \\(${params.timeframe} KC${params.period}×${params.atrMult} Stoch${params.kPeriod},${params.kSmooth},${params.dPeriod} ≤${params.stochThreshold}`,
      ),
    );
    assert.match(strategy.getDisplayName(), /decay12/);
    assert.match(strategy.getDisplayName(), /ATR>SMA50/);
    assert.equal(strategy.getRequiredCandles().timeframe, "5m");
  });

  it("keeps every default on a search level", () => {
    const strategy = new KeltnerStochStrategy();
    const defaults = strategy.getSearchDefaults();
    for (const axis of strategy.axes) {
      assert.ok(axis.levels.includes(defaults[axis.key] ?? Number.NaN), axis.key);
    }
  });

  it("patches stochastic knobs and turns search minutes into a candle label", () => {
    const patch = new KeltnerStochStrategy().paramPatch({
      kPeriod: 7,
      stochThreshold: 30,
      timeframe: 5,
    });
    assert.equal(patch.timeframe, "5m");
    assert.deepEqual(patch.values, { kPeriod: 7, stochThreshold: 30 });
  });

  it("forwards an open position into the signal", () => {
    const candles = crashThroughLower().slice(0, 40);
    const last = candles[candles.length - 1]!;
    const at = new Date((last.time + 15 * 60) * 1000);
    const signal = new KeltnerStochStrategy("flat", "low", loose()).evaluateSignal(
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
          strategyId: "keltner-stoch",
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
    assert.equal(signal.strategyId, "keltner-stoch");
  });
});
