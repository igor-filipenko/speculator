import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaperPortfolio } from "../portfolio/paper/portfolio.js";
import type { PortfolioSnapshot, Signal, SignalSide } from "../types.js";
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
      tpPrices: [],
      minRewardRisk: 0.1,
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
      tpPrices: [],
      minRewardRisk: 0.1,
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
      tpPrices: [],
      minRewardRisk: 0.1,
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
      tpPrices: [],
      minRewardRisk: 0.1,
    };
    const risk = new GenericRiskManager();
    const result = risk.check(signal, portfolio.getSnapshot(100), []);
    assert.equal(result.kind, "command");
    if (result.kind === "command") {
      assert.equal(result.command.intent, "open-long");
      assert.equal(result.command.signal?.strategyId, "bollinger");
      assert.equal(result.command.slPrice, 99.5);
      assert.equal(result.command.quoteBudgetUsdc, 1000);
    }
  });

  it("caps a BUY budget so a stop-out loses at most MAX_RISK_PERCENT of equity", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const signal: Signal = {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side: "BUY",
      reason: "cross",
      price: 100,
      at: new Date("2026-01-01T00:00:00.000Z"),
      slPrice: 92,
      tpPrices: [],
      minRewardRisk: 0.1,
    };
    const risk = new GenericRiskManager();
    const result = risk.check(signal, portfolio.getSnapshot(100), []);
    assert.equal(result.kind, "command");
    if (result.kind === "command") {
      assert.equal(result.command.intent, "open-long");
      // 2% of 1000 equity is 20 USDC; an 8% stop allows 250 USDC notional.
      assert.equal(result.command.quoteBudgetUsdc, 250);
    }
  });

  it("blocks an opening BUY when the furthest take-profit pays less than 1:2", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const price = 100;
    const riskDistance = 4;
    const signal: Signal = {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side: "BUY",
      reason: "reclaim",
      price,
      at: new Date("2026-01-01T00:00:00.000Z"),
      slPrice: price - riskDistance,
      tpPrices: [price + riskDistance * 1.5],
      minRewardRisk: 2,
    };
    const result = new GenericRiskManager().check(signal, portfolio.getSnapshot(price), []);
    assert.equal(result.kind, "risk");
    if (result.kind === "risk") {
      assert.match(result.risk.reason, /reward:risk below 1:2/);
    }
  });

  it("opens a BUY when the furthest take-profit pays 1:2", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const price = 100;
    const riskDistance = 4;
    const signal: Signal = {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side: "BUY",
      reason: "reclaim",
      price,
      at: new Date("2026-01-01T00:00:00.000Z"),
      slPrice: price - riskDistance,
      tpPrices: [price + riskDistance * 2],
      minRewardRisk: 2,
    };
    const result = new GenericRiskManager().check(signal, portfolio.getSnapshot(price), []);
    assert.equal(result.kind, "command");
    if (result.kind === "command") {
      assert.equal(result.command.intent, "open-long");
      assert.equal(result.command.quoteBudgetUsdc, 500);
    }
  });

  it("opens a short when the furthest take-profit pays 1:2", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const price = 100;
    const riskDistance = 4;
    const signal: Signal = {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side: "SELL",
      reason: "reject",
      price,
      at: new Date("2026-01-01T00:00:00.000Z"),
      slPrice: price + riskDistance,
      tpPrices: [price - riskDistance * 2],
      minRewardRisk: 2,
    };
    const result = new GenericRiskManager().check(signal, portfolio.getSnapshot(price), []);
    assert.equal(result.kind, "command");
    if (result.kind === "command") {
      assert.equal(result.command.intent, "open-short");
    }
  });

  it("does not block a target exactly on the floor because of float rounding", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const price = 100.3151;
    const atr = 0.52093;
    // (price + 9 * atr - price) / (price - (price - 3 * atr)) is just under 3 in floats.
    assert.ok((price + 9 * atr - price) / Math.abs(price - (price - 3 * atr)) < 3);
    const signal: Signal = {
      pair: "SOL/USDC",
      strategyId: "test",
      side: "BUY",
      reason: "breakout",
      price,
      at: new Date("2026-01-01T00:00:00.000Z"),
      slPrice: price - 3 * atr,
      tpPrices: [price + 9 * atr],
      minRewardRisk: 3,
    };
    const result = new GenericRiskManager().check(signal, portfolio.getSnapshot(price), []);
    assert.equal(result.kind, "command");
    if (result.kind === "command") {
      assert.equal(result.command.intent, "open-long");
    }
  });

  it("uses the signal minimum, so a Bollinger 0.2 floor allows a target below 1:2", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const price = 100;
    const riskDistance = 4;
    const signal: Signal = {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side: "BUY",
      reason: "reclaim",
      price,
      at: new Date("2026-01-01T00:00:00.000Z"),
      slPrice: price - riskDistance,
      tpPrices: [price + 1],
      minRewardRisk: 0.2,
    };
    const result = new GenericRiskManager().check(signal, portfolio.getSnapshot(price), []);
    assert.equal(result.kind, "command");
    if (result.kind === "command") {
      assert.equal(result.command.intent, "open-long");
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
      tpPrices: [],
      minRewardRisk: 0.1,
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

describe("position-data stop", () => {
  const risk = new GenericRiskManager();

  function held(side: "long" | "short", slPrice: number): PortfolioSnapshot {
    return {
      cashUsdc: 1000,
      position: {
        pair: "SOL/USDC",
        side,
        size: 1,
        entryPrice: 100,
        strategyId: "band-walker",
        slPrice,
        openedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      realizedPnl: 0,
      equity: 1000,
      trades: [],
      nativeSol: 1,
      insufficientSol: 0,
      simulated: true,
    };
  }

  function sig(input: {
    side?: SignalSide;
    slPrice?: number;
    barLow: number;
    barHigh: number;
  }): Signal {
    return {
      pair: "SOL/USDC",
      strategyId: "band-walker",
      side: input.side ?? "HOLD",
      reason: "walk holds",
      price: 100,
      at: new Date("2026-01-01T02:00:00.000Z"),
      ...(input.slPrice !== undefined ? { slPrice: input.slPrice } : {}),
      tpPrices: [],
      minRewardRisk: 0,
      meta: { barLow: input.barLow, barHigh: input.barHigh },
    };
  }

  it("returns a book update when the long stop only tightens", () => {
    const result = risk.check(sig({ slPrice: 95, barLow: 96, barHigh: 101 }), held("long", 90), []);
    assert.equal(result.kind, "position-data");
    if (result.kind === "position-data") {
      assert.equal(result.data.slPrice, 95);
      assert.equal(result.data.pair, "SOL/USDC");
      assert.equal(result.data.reason, "walk holds");
    }
  });

  it("ignores a looser long stop", () => {
    const result = risk.check(sig({ slPrice: 85, barLow: 96, barHigh: 101 }), held("long", 90), []);
    assert.equal(result.kind, "no-command");
  });

  it("closes a long at the tighter stop when this bar already trades through it", () => {
    const result = risk.check(sig({ slPrice: 95, barLow: 94, barHigh: 101 }), held("long", 90), []);
    assert.equal(result.kind, "protective-command");
    if (result.kind === "protective-command") {
      assert.equal(result.command.intent, "close-long");
      assert.equal(result.command.priceHint, 95);
      assert.match(result.command.reason, /95\.0000/);
    }
  });

  it("returns a book update when the short stop only tightens", () => {
    const result = risk.check(
      sig({ slPrice: 105, barLow: 99, barHigh: 104 }),
      held("short", 110),
      [],
    );
    assert.equal(result.kind, "position-data");
    if (result.kind === "position-data") assert.equal(result.data.slPrice, 105);
  });

  it("ignores a looser short stop", () => {
    const result = risk.check(
      sig({ slPrice: 115, barLow: 99, barHigh: 104 }),
      held("short", 110),
      [],
    );
    assert.equal(result.kind, "no-command");
  });

  it("closes a short at the tighter stop when this bar already trades through it", () => {
    const result = risk.check(
      sig({ slPrice: 105, barLow: 99, barHigh: 106 }),
      held("short", 110),
      [],
    );
    assert.equal(result.kind, "protective-command");
    if (result.kind === "protective-command") {
      assert.equal(result.command.intent, "close-short");
      assert.equal(result.command.priceHint, 105);
    }
  });

  it("does not trail off a repeated entry while already long", () => {
    const result = risk.check(
      sig({ side: "BUY", slPrice: 95, barLow: 94, barHigh: 101 }),
      held("long", 90),
      [],
    );
    assert.equal(result.kind, "risk");
    if (result.kind === "risk") assert.match(result.risk.reason, /already long/);
  });

  it("keeps a strategy close on the exchange when the tighter stop is not hit", () => {
    const result = risk.check(
      sig({ side: "SELL", slPrice: 95, barLow: 96, barHigh: 101 }),
      held("long", 90),
      [],
    );
    assert.equal(result.kind, "command");
    if (result.kind === "command") assert.equal(result.command.intent, "close-long");
  });
});
