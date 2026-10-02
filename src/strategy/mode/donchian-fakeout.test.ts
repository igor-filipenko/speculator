import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaperPortfolio } from "../../portfolio/paper/portfolio.js";
import type { Candle } from "../../types.js";
import { GenericRiskManager } from "../risk-manager.js";
import {
  DonchianFakeoutStrategy,
  donchianFakeoutParamsFor,
  evaluateDonchianFakeout,
  type DonchianFakeoutParams,
} from "./donchian-fakeout.js";

const INTERVAL = 15 * 60;
const START = 1_700_000_000;

/** Short windows so fixtures do not need 20+ bars of warmup. */
function testParams(overrides: Partial<DonchianFakeoutParams> = {}): DonchianFakeoutParams {
  return {
    ...donchianFakeoutParamsFor(),
    entryPeriod: 5,
    volumeSmaPeriod: 5,
    atrPeriod: 5,
    ...overrides,
  };
}

function bar(
  index: number,
  o: { close: number; high?: number; low?: number; volume?: number },
): Candle {
  return {
    time: START + index * INTERVAL,
    open: o.close,
    high: o.high ?? o.close + 0.2,
    low: o.low ?? o.close - 0.2,
    close: o.close,
    volume: o.volume ?? 10,
  };
}

/** Quiet range around 100 (channel high ≈ 100.2), then breakout bar B and rejection bar C. */
function fakeoutSeries(opts: {
  breakoutClose?: number;
  breakoutHigh?: number;
  breakoutVolume?: number;
  rejectClose?: number;
  rejectHigh?: number;
  rejectVolume?: number;
}): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    candles.push(bar(i, { close: 100 + ((i % 2) - 0.5) * 0.1 }));
  }
  candles.push(
    bar(20, {
      close: opts.breakoutClose ?? 101,
      high: opts.breakoutHigh ?? 101.4,
      volume: opts.breakoutVolume ?? 30,
    }),
  );
  candles.push(
    bar(21, {
      close: opts.rejectClose ?? 100.1,
      high: opts.rejectHigh ?? 101,
      volume: opts.rejectVolume ?? 15,
    }),
  );
  return candles;
}

/** Evaluation instant: first tick of the bar after the last candle. */
function afterLast(candles: Candle[]): Date {
  return new Date((candles[candles.length - 1]!.time + INTERVAL) * 1000);
}

function entryCandles(candles: Candle[], open: number): Candle[] {
  const next = bar(candles.length, { close: open, high: open, low: open });
  return [...candles, next];
}

describe("evaluateDonchianFakeout", () => {
  it("SELLs when a volume breakout closes back under the level", () => {
    const base = fakeoutSeries({});
    const candles = entryCandles(base, 100.1);
    const signal = evaluateDonchianFakeout({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: 100.1,
      at: afterLast(base),
    });
    assert.equal(signal.side, "SELL");
    assert.match(signal.reason, /Donchian fakeout/);
    const atr = signal.meta?.atr;
    assert.ok(atr != null && atr > 0);
    // Local high of B and C (101.4) plus the ATR buffer.
    assert.ok(Math.abs((signal.meta?.shortStopPrice ?? 0) - (101.4 + 0.1 * atr)) < 1e-9);
  });

  it("ignores a breakout bar on weak volume", () => {
    const base = fakeoutSeries({ breakoutVolume: 10 });
    const signal = evaluateDonchianFakeout({
      pair: "SOL/USDC",
      candles: entryCandles(base, 100.1),
      strategy: testParams(),
      price: 100.1,
      at: afterLast(base),
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /breakout volume/);
  });

  it("ignores a rejection bar on thin volume", () => {
    const base = fakeoutSeries({ rejectVolume: 2 });
    const signal = evaluateDonchianFakeout({
      pair: "SOL/USDC",
      candles: entryCandles(base, 100.1),
      strategy: testParams(),
      price: 100.1,
      at: afterLast(base),
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /rejection volume/);
  });

  it("holds when the next bar keeps closing above the level", () => {
    const base = fakeoutSeries({ rejectClose: 101.2 });
    const signal = evaluateDonchianFakeout({
      pair: "SOL/USDC",
      candles: entryCandles(base, 101.2),
      strategy: testParams(),
      price: 101.2,
      at: afterLast(base),
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /did not return under/);
  });

  it("holds when the breakout bar only wicked above the level", () => {
    const base = fakeoutSeries({ breakoutClose: 100.0, breakoutHigh: 101.4 });
    const signal = evaluateDonchianFakeout({
      pair: "SOL/USDC",
      candles: entryCandles(base, 100.1),
      strategy: testParams(),
      price: 100.1,
      at: afterLast(base),
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /did not break/);
  });

  it("skips entries whose stop is wider than maxStopAtrMult", () => {
    const base = fakeoutSeries({ breakoutHigh: 110 });
    const signal = evaluateDonchianFakeout({
      pair: "SOL/USDC",
      candles: entryCandles(base, 100.1),
      strategy: testParams({ maxStopAtrMult: 2 }),
      price: 100.1,
      at: afterLast(base),
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /stop distance .* >/);
  });

  it("ignores a forming bar when picking the setup", () => {
    const base = fakeoutSeries({});
    // Forming bar spikes back above the level; setup still comes from closed B and C.
    const forming: Candle = {
      ...bar(base.length, { close: 100.5, high: 100.8, low: 99.5 }),
    };
    const signal = evaluateDonchianFakeout({
      pair: "SOL/USDC",
      candles: [...base, forming],
      strategy: testParams(),
      price: 100.1,
      at: new Date((forming.time + 60) * 1000),
    });
    assert.equal(signal.side, "SELL");
  });

  describe("open short", () => {
    const base = fakeoutSeries({});
    const openedAt = afterLast(base);
    const position = { side: "short" as const, openedAt };

    it("carries the breakout-high stop in meta", () => {
      const candles = entryCandles(base, 100.1);
      const signal = evaluateDonchianFakeout({
        pair: "SOL/USDC",
        candles,
        strategy: testParams(),
        price: 100.1,
        at: new Date(openedAt.getTime() + 60_000),
        position,
      });
      assert.equal(signal.side, "HOLD");
      const entry = evaluateDonchianFakeout({
        pair: "SOL/USDC",
        candles,
        strategy: testParams(),
        price: 100.1,
        at: openedAt,
      });
      assert.equal(signal.meta?.shortStopPrice, entry.meta?.shortStopPrice);
    });

    it("covers at the Donchian midline", () => {
      const candles = entryCandles(base, 100.1);
      const signal = evaluateDonchianFakeout({
        pair: "SOL/USDC",
        candles,
        strategy: testParams(),
        price: 90,
        at: new Date(openedAt.getTime() + 60_000),
        position,
      });
      assert.equal(signal.side, "BUY");
      assert.match(signal.reason, /Take profit/);
      // Resting target: fill is the midline, not the lower tick.
      assert.equal(signal.price, signal.meta?.donchianMid);
    });

    it("covers on the time stop", () => {
      const candles = entryCandles(base, 100.1);
      const signal = evaluateDonchianFakeout({
        pair: "SOL/USDC",
        candles,
        strategy: testParams({ exitAtMid: false, maxHoldBars: 4 }),
        price: 100.1,
        at: new Date(openedAt.getTime() + 4 * INTERVAL * 1000),
        position,
      });
      assert.equal(signal.side, "BUY");
      assert.match(signal.reason, /Time stop/);
    });

    it("never opens a second short", () => {
      const candles = entryCandles(base, 100.1);
      const signal = evaluateDonchianFakeout({
        pair: "SOL/USDC",
        candles,
        strategy: testParams({ exitAtMid: false, maxHoldBars: 0 }),
        price: 100.1,
        at: openedAt,
        position,
      });
      assert.notEqual(signal.side, "SELL");
    });
  });
});

describe("DonchianFakeoutStrategy + structure stop", () => {
  it("exposes mode, risk params and enough candles", () => {
    const strategy = new DonchianFakeoutStrategy();
    assert.equal(strategy.getMode(), "donchian-fakeout");
    assert.equal(strategy.getRequiredCandles().timeframe, "15m");
    assert.ok(strategy.getRequiredCandles().count >= 42);
    assert.ok(strategy.getRiskParams().cooldownBars > 0);
  });

  it("risk manager stops the short at the breakout high, not the ATR stop", () => {
    const params = testParams();
    const base = fakeoutSeries({});
    const openedAt = afterLast(base);
    const candles = entryCandles(base, 100.1);
    const entryPrice = 100.1;

    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-short",
      reason: "fakeout",
      price: entryPrice,
      size: 5,
      at: openedAt,
      simulated: true,
      priorityFeeUsdc: 0,
    });

    const risk = new GenericRiskManager(
      { timeframe: "15m", atrStopMult: 10, atrTrailMult: 50, cooldownBars: 0, minHoldBars: 0 },
      { allowLong: false, allowShort: true },
    );

    const tickAt = new Date(openedAt.getTime() + 60_000);
    const below = { ...candles[candles.length - 1]!, high: 101.0, low: 99.5, close: 100.9 };
    const quiet = evaluateDonchianFakeout({
      pair: "SOL/USDC",
      candles: [...base, below],
      strategy: params,
      price: 100.9,
      at: tickAt,
      position: { side: "short", openedAt },
    });
    const quietResult = risk.check(quiet, portfolio.getSnapshot(100.9), [...base, below]);
    assert.notEqual(quietResult.kind, "protective-command");

    const spike = { ...below, high: 101.8, close: 101.7 };
    const stopped = evaluateDonchianFakeout({
      pair: "SOL/USDC",
      candles: [...base, spike],
      strategy: params,
      price: 101.7,
      at: tickAt,
      position: { side: "short", openedAt },
    });
    const stop = stopped.meta?.shortStopPrice;
    assert.ok(stop != null && stop < 101.8);
    const result = risk.check(stopped, portfolio.getSnapshot(101.7), [...base, spike]);
    assert.equal(result.kind, "protective-command");
    if (result.kind !== "protective-command") return;
    assert.equal(result.command.intent, "close-short");
    assert.equal(result.command.priceHint, stop);
    assert.match(result.command.reason, /Structure stop/);
  });
});
