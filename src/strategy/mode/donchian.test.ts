import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle } from "../../types.js";
import {
  DonchianStrategy,
  donchianParamsFor,
  evaluateDonchian,
  type DonchianParams,
} from "./donchian.js";

function baseParams(overrides: Partial<DonchianParams> = {}): DonchianParams {
  return { ...donchianParamsFor(), ...overrides };
}

/** Short windows so fixtures do not need 50+ bars. */
function testParams(overrides: Partial<DonchianParams> = {}): DonchianParams {
  return baseParams({
    entryPeriod: 5,
    exitPeriod: 3,
    volumeSmaPeriod: 5,
    volumeSmaMult: 1.0,
    trendEmaPeriod: 5,
    atrPeriod: 5,
    minBreakAtrMult: 0,
    enableBuy: true,
    ...overrides,
  });
}

const INTERVAL = 15 * 60;

function bar(time: number, close: number, range = 0.3, volume = 10): Candle {
  return {
    time,
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume,
  };
}

/** Quiet range so the last 5-bar high is well defined, then a close above it. */
function rangeThenBreakout(opts: {
  lastClose: number;
  lastVolume: number;
  lastRange?: number;
}): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const price = 100 + ((i % 4) - 1.5) * 0.1;
    candles.push(bar(start + i * INTERVAL, price, 0.2, 10));
  }
  const t = start + 40 * INTERVAL;
  candles.push(bar(t, opts.lastClose, opts.lastRange ?? 0.4, opts.lastVolume));
  return candles;
}

/** Downtrend then a local 5-bar high break that stays under a slower EMA. */
function breakoutBelowEma(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  let price = 150;
  for (let i = 0; i < 40; i++) {
    price -= 1.2;
    candles.push(bar(start + i * INTERVAL, price, 0.3, 10));
  }
  for (let i = 0; i < 8; i++) {
    const p = 100 + ((i % 4) - 1.5) * 0.1;
    candles.push(bar(start + (40 + i) * INTERVAL, p, 0.2, 10));
  }
  candles.push(bar(start + 48 * INTERVAL, 101.2, 0.5, 40));
  return candles;
}

/** Quiet range then a close through the prior 3-bar low. */
function rangeThenBreakdown(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const price = 100 + ((i % 4) - 1.5) * 0.1;
    candles.push(bar(start + i * INTERVAL, price, 0.2, 10));
  }
  const t = start + 40 * INTERVAL;
  candles.push(bar(t, 99.2, 0.3, 10));
  return candles;
}

describe("evaluateDonchian", () => {
  it("returns HOLD during warmup", () => {
    const candles = [bar(1, 100), bar(2, 101), bar(3, 102)];
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: 102,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /warmup/i);
  });

  it("emits BUY on upper-channel breakout when volume and EMA pass", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /Donchian breakout/i);
    assert.ok(signal.meta?.donchianUpper != null);
    assert.ok(signal.meta?.volumeSma != null);
    assert.ok(signal.meta?.atr != null);
    assert.ok(signal.meta?.barHigh != null);
  });

  it("holds a breakout when volume is at or below SMA", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 5, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /volume/i);
  });

  it("holds a breakout when close is below trend EMA", () => {
    const candles = breakoutBelowEma();
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams({ trendEmaPeriod: 30 }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /trend EMA/i);
  });

  it("does not re-BUY while price stays above the channel", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    candles.push(bar(last.time + INTERVAL, last.close + 0.2, 0.4, 40));
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /No Donchian signal/i);
  });

  it("emits SELL when close breaks the prior exit-channel low", () => {
    const candles = rangeThenBreakdown();
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /Donchian exit/i);
    assert.ok(signal.meta?.donchianLower != null);
  });

  it("ignores a breakout when enableBuy is false", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams({ enableBuy: false }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /not bullish/i);
  });

  it("ignores a shallow breakout below minBreakAtrMult × ATR", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams({ minBreakAtrMult: 50 }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /ATR/i);
  });
});

describe("donchianParamsFor", () => {
  it("uses 15m DC20/20 defaults and disables BUY in flat/low", () => {
    const p = donchianParamsFor("flat", "low");
    assert.equal(p.timeframe, "15m");
    assert.equal(p.entryPeriod, 20);
    assert.equal(p.exitPeriod, 20);
    assert.equal(p.volumeSmaPeriod, 20);
    assert.equal(p.trendEmaPeriod, 50);
    assert.equal(p.minBreakAtrMult, 0.1);
    assert.equal(p.enableBuy, false);
  });

  it("enables BUY only in bullish and tightens volume in squeeze", () => {
    assert.equal(donchianParamsFor("bullish", "high").enableBuy, true);
    assert.equal(donchianParamsFor("bullish", "high").volumeSmaMult, 1.1);
    assert.equal(donchianParamsFor("bullish", "low").volumeSmaMult, 1.3);
    assert.equal(donchianParamsFor("bullish", "squeeze").volumeSmaMult, 1.4);
    assert.equal(donchianParamsFor("flat", "squeeze").enableBuy, false);
    assert.equal(donchianParamsFor("bearish", "low").enableBuy, false);
  });
});

describe("DonchianStrategy", () => {
  it("exposes risk params and required candles on 15m", () => {
    const strategy = new DonchianStrategy("flat", "low");
    assert.equal(strategy.getMode(), "donchian");
    assert.match(strategy.getDisplayName(), /no-buy/);
    const risk = strategy.getRiskParams();
    assert.equal(risk.timeframe, "15m");
    assert.equal(risk.atrStopMult, 2.5);
    assert.equal(risk.atrTrailMult, 3.5);
    assert.equal(risk.cooldownBars, 8);
    assert.equal(risk.minHoldBars, 4);
    const required = strategy.getRequiredCandles();
    assert.equal(required.timeframe, "15m");
    assert.ok(required.count <= 100);
    assert.ok(required.count >= 70);
  });

  it("widens ATR trail in bullish and names the volume mult", () => {
    const strategy = new DonchianStrategy("bullish", "high");
    assert.match(strategy.getDisplayName(), /×1\.1/);
    assert.match(strategy.getDisplayName(), /bull/);
    const risk = strategy.getRiskParams();
    assert.equal(risk.atrStopMult, 3);
    assert.equal(risk.atrTrailMult, 4);
  });
});
