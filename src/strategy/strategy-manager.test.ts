import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GenericRiskManager, HighRiskManager } from "../risk/risk-manager.js";
import type { Candle } from "../types.js";
import {
  confirmTrend,
  evaluateMarketIndicators,
  htfParamsFor,
  mtfParamsFor,
  SimpleStrategyManager,
} from "./strategy-manager.js";

function bar(time: number, close: number, range = 0.5): Candle {
  return {
    time,
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume: 1,
  };
}

function series(count: number, startPrice: number, delta: number): Candle[] {
  const start = 1_700_000_000;
  const interval = 4 * 60 * 60;
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price += delta;
    candles.push(bar(start + i * interval, price, Math.abs(delta) + 0.2));
  }
  return candles;
}

function mtfBar(time: number, close: number, range: number): Candle {
  return {
    time,
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume: 1,
  };
}

/** Flat closes + wide high/low → BB inside Keltner (squeeze). */
function squeezeMtf(count: number): Candle[] {
  const start = 1_700_000_000;
  const interval = 60 * 60;
  return Array.from({ length: count }, (_, i) => mtfBar(start + i * interval, 100, 8));
}

/** Quiet ranges then a burst → ATR% at the top of the lookback (high). */
function highVolMtf(count: number): Candle[] {
  const start = 1_700_000_000;
  const interval = 60 * 60;
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const exploding = i >= count - 8;
    const range = exploding ? 25 : 0.3;
    price += exploding ? 12 : 0.04;
    candles.push(mtfBar(start + i * interval, price, range));
  }
  return candles;
}

/** Steady grind with tight bars so BB is outside KC and ATR% sits mid-lookback (low). */
function lowVolMtf(count: number): Candle[] {
  const start = 1_700_000_000;
  const interval = 60 * 60;
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    price += 1.5;
    candles.push(mtfBar(start + i * interval, price, 0.4));
  }
  return candles;
}

const params = htfParamsFor("4h");
const mtfParams = mtfParamsFor();
const at = new Date("2026-01-01T00:00:00.000Z");

describe("htfParamsFor / getRequiredCandles", () => {
  it("uses 200-EMA warmup of at least 220 bars on the given HTF", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "bollinger", htf: "4h" });
    const required = manager.getRequiredHtfCandles();
    assert.equal(required.timeframe, "4h");
    assert.ok(required.count >= 200);
    assert.equal(htfParamsFor("1d").timeframe, "1d");
    assert.equal(htfParamsFor("4h").trendConfirmBars, 2);
  });

  it("requires at least 120 1h bars for MTF volatility", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "bollinger", htf: "4h" });
    const required = manager.getRequiredMtfCandles();
    assert.equal(required.timeframe, "1h");
    assert.ok(required.count >= 120);
    assert.equal(mtfParams.timeframe, "1h");
  });
});

describe("SimpleStrategyManager defaults", () => {
  it("returns env-style strategy and GenericRiskManager from that strategy", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "grid", htf: "4h" });
    assert.equal(manager.getActiveStrategy().getMode(), "grid");
    assert.ok(manager.getActiveRiskManager() instanceof GenericRiskManager);
    assert.equal(manager.getActiveRiskManager(), manager.getActiveRiskManager());
  });
});

describe("applyMarketIndicators", () => {
  it("switches to HighRiskManager when trend is bearish", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "bollinger", htf: "4h" });
    const bullish = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 50, 0.8),
      price: 250,
      at,
      params,
    });
    assert.equal(bullish.trend, "bullish");
    assert.equal(manager.applyMarketIndicators(bullish), true);
    assert.ok(manager.getActiveRiskManager() instanceof GenericRiskManager);

    const bearish = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 250, -0.8),
      price: 50,
      at,
      params,
    });
    assert.equal(bearish.trend, "bearish");
    assert.equal(manager.applyMarketIndicators(bearish, bullish), true);
    assert.ok(manager.getActiveRiskManager() instanceof HighRiskManager);
    assert.equal(manager.applyMarketIndicators(bearish, bearish), false);
    assert.ok(manager.getActiveRiskManager() instanceof HighRiskManager);
  });

  it("returns true when volatility changes even if trend is unchanged", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "bollinger", htf: "4h" });
    const first = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 50, 0.8),
      price: 250,
      at,
      params,
    });
    manager.applyMarketIndicators(first);
    const squeezed = { ...first, volatility: "squeeze" as const };
    assert.equal(manager.applyMarketIndicators(squeezed, first), true);
    assert.equal(manager.applyMarketIndicators(squeezed, squeezed), false);
  });

  it("recreates GridStrategy with wide params (gridMult=8) when trend is bullish and vol is high", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "grid", htf: "4h" });
    const strategyBefore = manager.getActiveStrategy();
    const mtfCandles = highVolMtf(140);
    const high = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 50, 0.8),
      mtfCandles,
      price: mtfCandles[mtfCandles.length - 1]!.close,
      at,
      params,
      mtfParams,
    });
    assert.equal(high.trend, "bullish");
    assert.equal(high.volatility, "high");
    manager.applyMarketIndicators(high);
    assert.notEqual(manager.getActiveStrategy(), strategyBefore);
    assert.ok(manager.getActiveStrategy().getDisplayName().includes("×8"));
    assert.ok(manager.getActiveRiskManager() instanceof GenericRiskManager);
  });

  it("recreates BollingerStrategy with looser ADX when trend is bullish and vol is high", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "bollinger", htf: "4h" });
    const strategyBefore = manager.getActiveStrategy();
    const mtfCandles = highVolMtf(140);
    const high = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 50, 0.8),
      mtfCandles,
      price: mtfCandles[mtfCandles.length - 1]!.close,
      at,
      params,
      mtfParams,
    });
    assert.equal(high.trend, "bullish");
    assert.equal(high.volatility, "high");
    manager.applyMarketIndicators(high);
    assert.notEqual(manager.getActiveStrategy(), strategyBefore);
    assert.ok(manager.getActiveStrategy().getDisplayName().includes("ADX40"));
    assert.ok(manager.getActiveRiskManager() instanceof GenericRiskManager);
  });

  it("recreates DonchianStrategy with a higher volume SMA mult in squeeze", () => {
    const manager = new SimpleStrategyManager({ strategyMode: "donchian", htf: "4h" });
    assert.equal(manager.getActiveStrategy().getMode(), "donchian");
    assert.ok(manager.getActiveStrategy().getDisplayName().includes("no-buy"));
    const first = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 50, 0.8),
      price: 250,
      at,
      params,
    });
    manager.applyMarketIndicators(first);
    const squeezed = { ...first, volatility: "squeeze" as const };
    manager.applyMarketIndicators(squeezed, first);
    assert.ok(manager.getActiveStrategy().getDisplayName().includes("×1.4"));
    assert.ok(manager.getActiveStrategy().getDisplayName().includes("bull"));
    assert.ok(manager.getActiveRiskManager() instanceof GenericRiskManager);
  });
});

describe("evaluateMarketIndicators", () => {
  it("is unknown until EMA200 is warm", () => {
    const candles = series(50, 100, 0.1);
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles,
      price: candles[candles.length - 1]!.close,
      at,
      params,
    });
    assert.equal(indicators.trend, "unknown");
    assert.equal(indicators.volatility, "unknown");
    assert.equal(indicators.htf?.ema200, undefined);
    assert.equal(indicators.htf?.candles.length, 50);
  });

  it("is bullish when close is above EMA200 and ADX is trending", () => {
    const candles = series(250, 50, 0.8);
    const close = candles[candles.length - 1]!.close;
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles,
      price: close,
      at,
      params,
    });
    assert.equal(indicators.trend, "bullish");
    assert.ok(indicators.htf?.ema200 != null && close > indicators.htf.ema200);
    assert.ok(indicators.htf?.adx != null && indicators.htf.adx >= params.adxFlatMax);
    assert.ok(
      indicators.htf?.ema50 != null &&
        close > indicators.htf.ema50 &&
        indicators.htf.ema50 > indicators.htf.ema200,
    );
    assert.ok(indicators.htf?.plusDi != null && indicators.htf.minusDi != null);
    assert.ok(indicators.htf.plusDi > indicators.htf.minusDi);
    assert.ok(indicators.htf.atr != null && indicators.htf.atrPct != null);
    assert.ok(indicators.htf.distEma200Pct != null && indicators.htf.distEma200Pct > 0);
  });

  it("is bearish when close is below EMA200 and ADX is trending", () => {
    const candles = series(250, 250, -0.8);
    const close = candles[candles.length - 1]!.close;
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles,
      price: close,
      at,
      params,
    });
    assert.equal(indicators.trend, "bearish");
    assert.ok(indicators.htf?.ema200 != null && close < indicators.htf.ema200);
    assert.ok(indicators.htf.adx != null && indicators.htf.adx >= params.adxFlatMax);
  });

  it("is flat when ADX is below the threshold even if price is above EMA200", () => {
    const candles = series(250, 100, 0);
    const close = candles[candles.length - 1]!.close;
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles,
      price: close,
      at,
      params,
    });
    assert.equal(indicators.trend, "flat");
    assert.ok(indicators.htf?.ema200 != null);
    assert.ok(indicators.htf.adx == null || indicators.htf.adx < params.adxFlatMax);
  });

  it("is flat when close is above EMA200 but EMA50 is still below EMA200", () => {
    const down = series(230, 400, -1);
    const lastTime = down[down.length - 1]!.time;
    const interval = 4 * 60 * 60;
    let price = down[down.length - 1]!.close;
    const bounce: Candle[] = [];
    for (let i = 1; i <= 12; i++) {
      price += 12;
      bounce.push(bar(lastTime + i * interval, price, 2));
    }
    const candles = [...down, ...bounce];
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles,
      price: candles[candles.length - 1]!.close,
      at,
      params,
    });
    assert.ok(indicators.htf?.ema200 != null && indicators.htf.ema50 != null);
    assert.ok(indicators.htf.ema50 < indicators.htf.ema200);
    assert.ok(candles[candles.length - 1]!.close > indicators.htf.ema200);
    assert.equal(indicators.trend, "flat");
  });

  it("keeps the previous HTF trend through a one-bar stack break", () => {
    const up = series(250, 50, 0.8);
    const last = up[up.length - 1]!;
    const crash: Candle = {
      ...last,
      open: last.close,
      high: last.close,
      low: last.close * 0.45,
      close: last.close * 0.5,
    };
    const crashed = [...up.slice(0, -1), crash];
    const steady = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: up,
      price: last.close,
      at,
      params,
    });
    const oneBar = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: crashed,
      price: crash.close,
      at,
      params,
    });
    const hairTrigger = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: crashed,
      price: crash.close,
      at,
      params: { ...params, trendConfirmBars: 1 },
    });
    assert.equal(steady.trend, "bullish");
    assert.equal(oneBar.trend, "bullish");
    assert.notEqual(hairTrigger.trend, "bullish");
  });

  it("publishes a new trend after two consecutive HTF bars", () => {
    const up = series(250, 50, 0.8);
    const head = up.slice(0, -2);
    const t0 = head[head.length - 1]!.time;
    const interval = 4 * 60 * 60;
    const crash1 = bar(t0 + interval, 10, 2);
    const crash2 = bar(t0 + 2 * interval, 9, 2);
    const twoBars = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: [...head, crash1, crash2],
      price: crash2.close,
      at,
      params,
    });
    assert.notEqual(twoBars.trend, "bullish");
  });
});

describe("confirmTrend", () => {
  it("ignores a one-bar blip and switches on the second consecutive label", () => {
    assert.equal(confirmTrend(["flat", "bearish"], 2), "flat");
    assert.equal(confirmTrend(["flat", "bearish", "bearish"], 2), "bearish");
    assert.equal(confirmTrend(["flat", "bearish", "flat"], 2), "flat");
    assert.equal(confirmTrend(["bullish", "flat", "bullish"], 2), "bullish");
  });

  it("publishes the first label after unknown immediately", () => {
    assert.equal(confirmTrend(["unknown", "unknown", "flat"], 2), "flat");
  });

  it("switches on the first bar when confirmBars is 1", () => {
    assert.equal(confirmTrend(["flat", "bearish"], 1), "bearish");
  });
});

describe("evaluateMarketIndicators volatility", () => {
  it("is unknown until 1h BB/KC and ATR percentile are warm", () => {
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 50, 0.8),
      mtfCandles: squeezeMtf(10),
      price: 100,
      at,
      params,
      mtfParams,
    });
    assert.equal(indicators.volatility, "unknown");
  });

  it("is squeeze when Bollinger is inside Keltner on 1h", () => {
    const mtfCandles = squeezeMtf(40);
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 50, 0.8),
      mtfCandles,
      price: mtfCandles[mtfCandles.length - 1]!.close,
      at,
      params,
      mtfParams,
    });
    assert.equal(indicators.volatility, "squeeze");
    assert.ok(indicators.mtf?.atr != null);
  });

  it("is high when 1h ATR% is at the top of the lookback", () => {
    const mtfCandles = highVolMtf(140);
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 50, 0.8),
      mtfCandles,
      price: mtfCandles[mtfCandles.length - 1]!.close,
      at,
      params,
      mtfParams,
    });
    assert.equal(indicators.volatility, "high");
    assert.ok(indicators.mtf?.atrPct != null);
  });

  it("is low when 1h ATR% is below the high percentile and not squeezed", () => {
    const mtfCandles = lowVolMtf(140);
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 50, 0.8),
      mtfCandles,
      price: mtfCandles[mtfCandles.length - 1]!.close,
      at,
      params,
      mtfParams,
    });
    assert.equal(indicators.volatility, "low");
  });

  it("attaches 1h support and resistance from swing clusters", () => {
    const start = 1_700_000_000;
    const hour = 60 * 60;
    const mtfCandles: Candle[] = [
      { time: start, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: start + hour, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: start + 2 * hour, open: 105, high: 110, low: 100, close: 105, volume: 1 },
      { time: start + 3 * hour, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: start + 4 * hour, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: start + 5 * hour, open: 95, high: 100, low: 90, close: 95, volume: 1 },
      { time: start + 6 * hour, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: start + 7 * hour, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: start + 8 * hour, open: 100, high: 102, low: 98, close: 100, volume: 1 },
    ];
    const indicators = evaluateMarketIndicators({
      pair: "SOL/USDC",
      candles: series(250, 50, 0.8),
      mtfCandles,
      price: 100,
      at,
      params,
      mtfParams,
    });
    assert.equal(indicators.mtf?.resistance, 110);
    assert.equal(indicators.mtf?.support, 90);
    assert.ok(indicators.mtf?.levels?.some((l) => l.kind === "resistance" && l.price === 110));
    assert.ok(indicators.mtf?.levels?.some((l) => l.kind === "support" && l.price === 90));
  });
});
