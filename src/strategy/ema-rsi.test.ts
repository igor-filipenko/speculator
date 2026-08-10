import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle, StrategyParams } from "../types.js";
import { evaluateEmaRsi } from "./ema-rsi.js";
import { strategyParamsFor } from "./strategy.js";

function baseParams(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return { ...strategyParamsFor("intraday"), ...overrides };
}

/** Flat series then a controlled bullish cross setup. */
function trendUpCandles(): Candle[] {
  const start = 1_700_000_000;
  const interval = 15 * 60;
  const candles: Candle[] = [];
  let price = 100;
  // Warm indicators in a mild uptrend so close stays above a short trend EMA.
  for (let i = 0; i < 60; i++) {
    price += 0.15;
    candles.push(bar(start + i * interval, price));
  }
  // Brief pullback so fast dips under slow.
  for (let i = 0; i < 8; i++) {
    price -= 0.6;
    candles.push(bar(start + (60 + i) * interval, price));
  }
  // Resume uptrend to cross back up with moderate RSI.
  for (let i = 0; i < 10; i++) {
    price += 0.7;
    candles.push(bar(start + (68 + i) * interval, price));
  }
  return candles;
}

function bar(time: number, close: number): Candle {
  return {
    time,
    open: close - 0.1,
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume: 10,
  };
}

describe("evaluateEmaRsi filters", () => {
  it("emits BUY on bullish cross when RSI band and trend EMA pass", () => {
    const candles = trendUpCandles();
    const strategy = baseParams({
      emaFast: 5,
      emaSlow: 12,
      trendEmaPeriod: 20,
      rsiPeriod: 14,
      rsiBuyMin: 30,
      rsiBuyMax: 80,
      adxPeriod: 14,
      adxMin: 0,
    });

    let sawBuy = false;
    for (let i = 30; i < candles.length; i++) {
      const window = candles.slice(0, i + 1);
      const signal = evaluateEmaRsi({
        pair: "SOL/USDC",
        candles: window,
        strategy,
        price: window[window.length - 1]!.close,
        at: new Date(window[window.length - 1]!.time * 1000),
      });
      if (signal.side === "BUY") {
        sawBuy = true;
        assert.ok(signal.meta?.trendEma != null);
        assert.ok(signal.meta?.atr != null);
        assert.ok(signal.meta?.adx != null);
        break;
      }
    }
    assert.equal(sawBuy, true);
  });

  it("ignores bullish cross when close is below trend EMA", () => {
    const start = 1_700_000_000;
    const interval = 15 * 60;
    const candles: Candle[] = [];
    let price = 100;
    // Strong downtrend so trend EMA stays above price.
    for (let i = 0; i < 80; i++) {
      price -= 0.5;
      candles.push(bar(start + i * interval, price));
    }
    // Sharp bounce that can cross EMAs but still below a long trend EMA.
    for (let i = 0; i < 15; i++) {
      price += 1.2;
      candles.push(bar(start + (80 + i) * interval, price));
    }

    const strategy = baseParams({
      emaFast: 5,
      emaSlow: 12,
      trendEmaPeriod: 50,
      rsiBuyMin: 0,
      rsiBuyMax: 100,
      adxMin: 0,
    });

    let ignored = false;
    let bought = false;
    for (let i = 40; i < candles.length; i++) {
      const window = candles.slice(0, i + 1);
      const signal = evaluateEmaRsi({
        pair: "SOL/USDC",
        candles: window,
        strategy,
        price: window[window.length - 1]!.close,
      });
      if (signal.side === "BUY") {
        bought = true;
      }
      if (signal.reason.includes("close") && signal.reason.includes("trend EMA")) {
        ignored = true;
      }
    }
    assert.equal(bought, false);
    assert.equal(ignored, true);
  });

  it("ignores bullish cross when ADX is below adxMin", () => {
    const candles = trendUpCandles();
    const strategy = baseParams({
      emaFast: 5,
      emaSlow: 12,
      trendEmaPeriod: 20,
      rsiBuyMin: 30,
      rsiBuyMax: 80,
      adxPeriod: 14,
      adxMin: 99,
    });

    let ignoredAdx = false;
    let bought = false;
    for (let i = 30; i < candles.length; i++) {
      const window = candles.slice(0, i + 1);
      const signal = evaluateEmaRsi({
        pair: "SOL/USDC",
        candles: window,
        strategy,
        price: window[window.length - 1]!.close,
      });
      if (signal.side === "BUY") {
        bought = true;
      }
      if (signal.reason.includes("ADX") && signal.reason.includes("ignored")) {
        ignoredAdx = true;
      }
    }
    assert.equal(bought, false);
    assert.equal(ignoredAdx, true);
  });
});
