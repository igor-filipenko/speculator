import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaperPortfolio } from "../paper/portfolio.js";
import { loadStrategy } from "../strategy/strategy.js";
import type { Candle, Order, RiskParams, Signal } from "../types.js";
import { evaluateProtectiveExit, SimpleRiskManager } from "./risk-manager.js";

function riskParams(overrides: Partial<RiskParams> = {}): RiskParams {
  return { ...loadStrategy("ema-rsi").getRiskParams(), ...overrides };
}

describe("SimpleRiskManager", () => {
  it("blocks BUY during cooldown after SELL", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const buyOrder: Order = {
      pair: "SOL/USDC",
      side: "BUY",
      reason: "entry",
      price: 100,
      size: 9,
      at: new Date("2026-01-01T00:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
    };
    portfolio.applyOrderSync(buyOrder);
    const sellOrder: Order = {
      pair: "SOL/USDC",
      side: "SELL",
      reason: "exit",
      price: 100,
      size: 9,
      at: new Date("2026-01-01T01:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
    };
    portfolio.applyOrderSync(sellOrder);

    const interval = 15 * 60;
    const start = Math.floor(Date.parse("2026-01-01T01:00:00.000Z") / 1000);
    const signal: Signal = {
      pair: "SOL/USDC",
      side: "BUY",
      reason: "cross",
      price: 100,
      at: new Date((start + 2 * interval) * 1000),
      meta: { atr: 1, barLow: 99, barHigh: 101 },
    };
    const risk = new SimpleRiskManager(riskParams({ cooldownBars: 4 }));
    const result = risk.check(signal, portfolio.getSnapshot(100), []);
    assert.equal(result.kind, "risk");
    assert.match(result.risk.reason, /cooldown/);
  });

  it("blocks discretionary SELL before minHoldBars but allows ATR stop", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const openedAt = new Date("2026-01-01T00:00:00.000Z");
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      side: "BUY",
      reason: "entry",
      price: 100,
      size: 5,
      at: openedAt,
      simulated: true,
      priorityFeeUsdc: 0,
    });

    const start = Math.floor(openedAt.getTime() / 1000);
    const interval = 15 * 60;
    const risk = new SimpleRiskManager(
      riskParams({ minHoldBars: 4, atrStopMult: 2, atrTrailMult: 10 }),
    );

    risk.check(
      {
        pair: "SOL/USDC",
        side: "HOLD",
        reason: "hold",
        price: 100,
        at: new Date((start + interval) * 1000),
        meta: { atr: 1, barLow: 99, barHigh: 101 },
      },
      portfolio.getSnapshot(100),
      [],
    );

    const crossSell: Signal = {
      pair: "SOL/USDC",
      side: "SELL",
      reason: "bearish cross",
      price: 90,
      at: new Date((start + interval) * 1000),
      meta: { atr: 1, barLow: 99, barHigh: 100 },
    };
    const blocked = risk.check(crossSell, portfolio.getSnapshot(90), []);
    assert.equal(blocked.kind, "risk");
    assert.match(blocked.risk.reason, /min hold/);

    const stopCmd = risk.check(
      {
        pair: "SOL/USDC",
        side: "HOLD",
        reason: "no cross",
        price: 90,
        at: new Date((start + 3 * interval) * 1000),
        meta: { atr: 1, barLow: 85, barHigh: 100 },
      },
      portfolio.getSnapshot(90),
      [],
    );
    assert.equal(stopCmd.kind, "command");
    assert.equal(stopCmd.command.side, "SELL");
    assert.match(stopCmd.command.reason, /ATR/);
  });

  it("trails from max OHLCV high since openedAt, not only the last bar", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const openedAt = new Date("2026-01-01T00:00:00.000Z");
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      side: "BUY",
      reason: "entry",
      price: 100,
      size: 1,
      at: openedAt,
      simulated: true,
      priorityFeeUsdc: 0,
    });

    const interval = 15 * 60;
    const t0 = Math.floor(openedAt.getTime() / 1000);
    const candles: Candle[] = [
      { time: t0, open: 100, high: 120, low: 99, close: 110, volume: 1 },
      { time: t0 + interval, open: 110, high: 116, low: 115, close: 115, volume: 1 },
    ];
    const risk = new SimpleRiskManager(
      riskParams({ atrStopMult: 50, atrTrailMult: 2, minHoldBars: 0 }),
    );
    // Peak 120 − 2×ATR(2) = 116; barLow 115 hits trail. Last-bar-only peak would be 116 → trail 112 (no hit).
    const result = risk.check(
      {
        pair: "SOL/USDC",
        side: "HOLD",
        reason: "hold",
        price: 115,
        at: new Date((t0 + interval) * 1000),
        meta: { atr: 2, barLow: 115, barHigh: 116 },
      },
      portfolio.getSnapshot(115),
      candles,
    );
    assert.equal(result.kind, "command");
    assert.match(result.command.reason, /ATR trail/);
  });
});

describe("evaluateProtectiveExit", () => {
  it("returns null when flat", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 100);
    const signal: Signal = {
      pair: "SOL/USDC",
      side: "HOLD",
      reason: "flat",
      price: 100,
      at: new Date(),
      meta: { atr: 1, barLow: 99, barHigh: 101 },
    };
    const cmd = evaluateProtectiveExit(signal, portfolio.getSnapshot(100), riskParams());
    assert.equal(cmd, null);
  });

  it("uses atr and barLow from signal meta", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      side: "BUY",
      reason: "entry",
      price: 100,
      size: 1,
      at: new Date("2026-01-01T00:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
    });
    const signal: Signal = {
      pair: "SOL/USDC",
      side: "HOLD",
      reason: "hold",
      price: 95,
      at: new Date("2026-01-01T01:00:00.000Z"),
      meta: { atr: 2, barLow: 95, barHigh: 101 },
    };
    const cmd = evaluateProtectiveExit(
      signal,
      portfolio.getSnapshot(95),
      riskParams({ atrStopMult: 2 }),
    );
    assert.ok(cmd);
    assert.equal(cmd.side, "SELL");
    assert.match(cmd.reason, /ATR stop/);
  });
});
