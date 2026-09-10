import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle, MarketIndicators } from "../../types.js";
import {
  evaluateBollinger,
  BollingerStrategy,
  bollingerDoNotBuyReason,
  bollingerParamsFor,
  type BollingerParams,
} from "./bollinger.js";
import { rsi } from "../indicators.js";

function baseParams(overrides: Partial<BollingerParams> = {}): BollingerParams {
  return { ...bollingerParamsFor(), ...overrides };
}

/** Loose filters so fixtures still fire BUY/SELL without the live oversold/ADX gates. */
function looseFilters(overrides: Partial<BollingerParams> = {}): BollingerParams {
  return baseParams({
    period: 10,
    stdDev: 2,
    atrPeriod: 5,
    adxPeriod: 5,
    adxMax: 100,
    minBandToMidPct: 0.001,
    minReclaimDepth: 0,
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
 * Flat range, pierce lower, then reclaim still below a typical mid.
 */
function reclaimLowerBand(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    const price = 100 + ((i % 6) - 2.5) * 0.35;
    candles.push(bar(start + i * INTERVAL, price, 0.25));
  }
  const t = start + 50 * INTERVAL;
  // Pierce lower band hard so std widens, then reclaim below mid (~99.6).
  candles.push(bar(t, 96.5, 0.5));
  candles.push(bar(t + INTERVAL, 99.0, 0.3));
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

/** Same-bar hammer: wick through lower, close back inside (prev close stayed in range). */
function wickReclaimLower(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    const price = 100 + ((i % 6) - 2.5) * 0.35;
    candles.push(bar(start + i * INTERVAL, price, 0.25));
  }
  const t = start + 50 * INTERVAL;
  candles.push({
    time: t,
    open: 98.9,
    high: 99.3,
    low: 96.6,
    close: 99.2,
    volume: 10,
  });
  return candles;
}

function marketState(
  trend: MarketIndicators["trend"],
  volatility: MarketIndicators["volatility"],
  price: number,
): MarketIndicators {
  return { pair: "SOL/USDC", price, trend, volatility };
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
    assert.match(signal.reason, /Lower BB close reclaim/i);
    assert.ok(signal.meta?.bbLower != null);
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

  it("holds a mid cross when close is still below the open fill", () => {
    const candles = reboundToMid();
    const last = candles[candles.length - 1]!;
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
      entryPrice: last.close * 1.02,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /below entry/);
    assert.match(signal.reason, /wait ATR/);
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

  it("emits BUY on a same-bar wick reclaim (green close back inside)", () => {
    const candles = wickReclaimLower();
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /wick reclaim/i);
  });

  it("ignores reclaim when doNotBuy is set (bear / high vol)", () => {
    const candles = reclaimLowerBand();
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: candles[candles.length - 1]!.close,
      doNotBuy: true,
      doNotBuyReason: "HTF trend bearish",
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /HTF trend bearish/);
  });

  it("still emits SELL at mid when doNotBuy is set", () => {
    const candles = reboundToMid();
    const last = candles[candles.length - 1]!;
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
      doNotBuy: true,
      doNotBuyReason: "1h volatility high",
    });
    assert.equal(signal.side, "SELL");
    assert.match(signal.reason, /BB mid/);
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

  it("ignores reclaim when depth is below minReclaimDepth", () => {
    const candles = reclaimLowerBand();
    const signal = evaluateBollinger({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ minReclaimDepth: 0.9 }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /depth/);
  });
});

describe("bollingerParamsFor", () => {
  it("loosens ADX/RSI in tradable regimes", () => {
    assert.equal(bollingerParamsFor("flat", "low").adxMax, 35);
    assert.equal(bollingerParamsFor("flat", "low").timeframe, "15m");
    assert.equal(bollingerParamsFor("flat", "low").rsiBuyMax, 50);
    assert.equal(bollingerParamsFor("flat", "low").stdDev, 1.5);
    assert.equal(bollingerParamsFor("flat", "low").minReclaimDepth, 0.15);
    assert.equal(bollingerParamsFor("flat", "low").minExitAboveEntryPct, 0.002);
    assert.equal(bollingerParamsFor("bullish", "high").adxMax, 40);
    assert.equal(bollingerParamsFor("bullish", "high").rsiBuyMax, 50);
    assert.equal(bollingerParamsFor("bullish", "high").stdDev, 1.6);
    assert.equal(bollingerParamsFor("bullish", "low").rsiBuyMax, 48);
    assert.equal(bollingerParamsFor("flat", "squeeze").adxMax, 28);
    assert.equal(bollingerParamsFor("flat", "squeeze").stdDev, 1.4);
    assert.equal(bollingerParamsFor("flat", "squeeze").minReclaimDepth, 0.2);
    assert.equal(bollingerParamsFor("unknown", "squeeze").rsiBuyMax, 40);
  });

  it("widens ATR stop/trail in bullish high vol and shortens cooldown", () => {
    assert.equal(new BollingerStrategy("bullish", "high").getRiskParams().atrStopMult, 3);
    assert.equal(new BollingerStrategy("bullish", "high").getRiskParams().atrTrailMult, 3.5);
    assert.equal(new BollingerStrategy("flat", "low").getRiskParams().atrStopMult, 2.5);
    assert.equal(new BollingerStrategy("flat", "low").getRiskParams().atrTrailMult, 3);
    assert.equal(new BollingerStrategy("flat", "low").getRiskParams().cooldownBars, 2);
    assert.equal(new BollingerStrategy("flat", "low").getRiskParams().minHoldBars, 1);
  });
});

describe("bollingerDoNotBuyReason", () => {
  it("blocks bearish/unknown HTF and 1h high vol", () => {
    assert.equal(bollingerDoNotBuyReason("bearish", "low"), "HTF trend bearish");
    assert.equal(bollingerDoNotBuyReason("unknown", "squeeze"), "HTF trend unknown");
    assert.equal(bollingerDoNotBuyReason("bullish", "high"), "1h volatility high");
    assert.equal(bollingerDoNotBuyReason("flat", "high"), "1h volatility high");
    assert.equal(bollingerDoNotBuyReason("bullish", "low"), undefined);
    assert.equal(bollingerDoNotBuyReason("flat", "squeeze"), undefined);
  });
});

describe("BollingerStrategy regime gate", () => {
  it("holds a reclaim when HTF is bearish or 1h vol is high", () => {
    const candles = reclaimLowerBand();
    const price = candles[candles.length - 1]!.close;
    const at = new Date(candles[candles.length - 1]!.time * 1000);
    const strategy = new BollingerStrategy("bullish", "low");
    const blockedBear = strategy.evaluateSignal(
      "SOL/USDC",
      candles,
      marketState("bearish", "low", price),
      price,
      at,
    );
    assert.equal(blockedBear.side, "HOLD", blockedBear.reason);
    assert.match(blockedBear.reason, /bearish/);

    const blockedHigh = strategy.evaluateSignal(
      "SOL/USDC",
      candles,
      marketState("bullish", "high", price),
      price,
      at,
    );
    assert.equal(blockedHigh.side, "HOLD", blockedHigh.reason);
    assert.match(blockedHigh.reason, /volatility high/);
  });

  it("labels display name no-buy in bear or high vol", () => {
    assert.match(new BollingerStrategy("flat", "low").getDisplayName(), / mr\)$/);
    assert.match(new BollingerStrategy("bearish", "low").getDisplayName(), / no-buy\)$/);
    assert.match(new BollingerStrategy("bullish", "high").getDisplayName(), / no-buy\)$/);
  });
});
