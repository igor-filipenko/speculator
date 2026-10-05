import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaperPortfolio } from "../portfolio/paper/portfolio.js";
import type { PortfolioSnapshot, Signal } from "../types.js";
import { evaluateProtectiveExit, GenericRiskManager } from "./risk-manager.js";

describe("evaluateProtectiveExit", () => {
  it("returns null when flat", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 100);
    const signal: Signal = {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side: "HOLD",
      reason: "flat",
      price: 100,
      at: new Date(),
      meta: { atr: 1, barLow: 99, barHigh: 101 },
    };
    const cmd = evaluateProtectiveExit(signal, portfolio.getSnapshot(100));
    assert.equal(cmd, null);
  });

  it("stays open when the position has no stored stop", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "entry",
      price: 100,
      size: 1,
      at: new Date("2026-01-01T00:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
    });
    const signal: Signal = {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side: "HOLD",
      reason: "hold",
      price: 95,
      at: new Date("2026-01-01T01:00:00.000Z"),
      meta: { atr: 2, barLow: 95, barHigh: 101 },
    };
    const cmd = evaluateProtectiveExit(signal, portfolio.getSnapshot(95));
    assert.equal(cmd, null);
  });

  it("uses the position hard stop instead of the live ATR distance", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "entry",
      price: 100,
      size: 1,
      at: new Date("2026-01-01T00:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
      strategyId: "bollinger",
      slPrice: 98,
    });
    const signal: Signal = {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side: "HOLD",
      reason: "hold",
      price: 97,
      at: new Date("2026-01-01T01:00:00.000Z"),
      meta: { atr: 2, barLow: 97, barHigh: 101 },
    };
    const cmd = evaluateProtectiveExit(signal, portfolio.getSnapshot(97));
    assert.ok(cmd);
    assert.equal(cmd.intent, "close-long");
    assert.match(cmd.reason, /hard stop hit \(98/);
  });
});

describe("opening command", () => {
  it("copies the signal and its hard stop when the deposit is within the cap", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const signal: Signal = {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side: "BUY",
      reason: "cross",
      price: 100,
      at: new Date("2026-01-01T00:00:00.000Z"),
      slPrice: 99.5,
    };
    const risk = new GenericRiskManager();
    const result = risk.check(signal, portfolio.getSnapshot(100), []);
    assert.equal(result.kind, "command");
    if (result.kind === "command") {
      assert.equal(result.command.intent, "open-long");
      assert.equal(result.command.signal?.strategyId, "bollinger");
      assert.equal(result.command.slPrice, 99.5);
    }
  });

  it("blocks a BUY whose cash would lose more than MAX_RISK_PERCENT at the stop", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const signal: Signal = {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side: "BUY",
      reason: "cross",
      price: 100,
      at: new Date("2026-01-01T00:00:00.000Z"),
      slPrice: 92,
    };
    const risk = new GenericRiskManager();
    const result = risk.check(signal, portfolio.getSnapshot(100), []);
    assert.equal(result.kind, "risk");
    if (result.kind === "risk") {
      assert.match(result.risk.reason, /exceeds max/);
    }
  });
});

describe("SOL reserve top-up", () => {
  function snapshot(side: "flat" | "long", insufficientSol: number): PortfolioSnapshot {
    const long = side === "long";
    return {
      cashUsdc: 1000,
      position: {
        pair: "SOL/USDC",
        side,
        size: long ? 1 : 0,
        entryPrice: long ? 100 : 0,
        strategyId: long ? "bollinger" : "",
        slPrice: 0,
        ...(long ? { openedAt: new Date("2026-01-01T00:00:00.000Z") } : {}),
      },
      realizedPnl: 0,
      equity: 1000,
      trades: [],
      nativeSol: 0.01,
      insufficientSol,
      simulated: false,
    };
  }

  function signal(side: "BUY" | "HOLD"): Signal {
    return {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side,
      reason: side === "BUY" ? "cross" : "hold",
      price: 100,
      at: new Date("2026-01-01T02:00:00.000Z"),
    };
  }

  it("buys SOL when flat, ignoring HOLD and BUY", () => {
    const risk = new GenericRiskManager();
    const snap = snapshot("flat", 0.04);
    for (const side of ["HOLD", "BUY"] as const) {
      const result = risk.check(signal(side), snap, []);
      assert.equal(result.kind, "command");
      if (result.kind === "command") {
        assert.equal(result.command.intent, "buy-sol");
        assert.equal(result.command.baseSize, 0.04);
        assert.equal(result.command.reason, "native SOL below reserve minimum");
      }
    }
  });

  it("does not buy SOL while a position is open", () => {
    const risk = new GenericRiskManager();
    const snap = snapshot("long", 0.04);
    const hold = risk.check(signal("HOLD"), snap, []);
    assert.equal(hold.kind, "no-command");
    const buy = risk.check(signal("BUY"), snap, []);
    assert.equal(buy.kind, "risk");
    if (buy.kind === "risk") {
      assert.match(buy.risk.reason, /already long/);
    }
  });
});
