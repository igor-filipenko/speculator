import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaperPortfolio } from "../portfolio/paper/portfolio.js";
import type { Candle, Order, PortfolioSnapshot, RiskParams, Signal } from "../types.js";
import { evaluateProtectiveExit, GenericRiskManager, HighRiskManager } from "./risk-manager.js";

function riskParams(overrides: Partial<RiskParams> = {}): RiskParams {
  return {
    timeframe: "15m",
    atrStopMult: 2,
    atrTrailMult: 2.5,
    cooldownBars: 2,
    minHoldBars: 1,
    ...overrides,
  };
}

describe("GenericRiskManager", () => {
  it("blocks BUY during cooldown after SELL", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const buyOrder: Order = {
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
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
      type: "market",
      intent: "close-long",
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
      strategyId: "bollinger",
      side: "BUY",
      reason: "cross",
      price: 100,
      at: new Date((start + 2 * interval) * 1000),
      meta: { atr: 1, barLow: 99, barHigh: 101 },
    };
    const risk = new GenericRiskManager(riskParams({ cooldownBars: 4 }));
    const result = risk.check(signal, portfolio.getSnapshot(100), []);
    assert.equal(result.kind, "risk");
    assert.match(result.risk.reason, /cooldown/);
  });

  it("blocks discretionary SELL before minHoldBars but allows ATR stop", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const openedAt = new Date("2026-01-01T00:00:00.000Z");
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "entry",
      price: 100,
      size: 5,
      at: openedAt,
      simulated: true,
      priorityFeeUsdc: 0,
    });

    const start = Math.floor(openedAt.getTime() / 1000);
    const interval = 15 * 60;
    const risk = new GenericRiskManager(
      riskParams({ minHoldBars: 4, atrStopMult: 2, atrTrailMult: 10 }),
    );

    risk.check(
      {
        pair: "SOL/USDC",
        strategyId: "bollinger",
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
      strategyId: "bollinger",
      side: "SELL",
      reason: "bearish cross",
      price: 90,
      at: new Date((start + interval) * 1000),
      meta: { atr: 1, barLow: 99, barHigh: 100 },
    };
    const blocked = risk.check(crossSell, portfolio.getSnapshot(90), []);
    assert.equal(blocked.kind, "risk");
    assert.match(blocked.risk.reason, /min hold/);

    const holdThroughStop = risk.check(
      {
        pair: "SOL/USDC",
        strategyId: "bollinger",
        side: "HOLD",
        reason: "no cross",
        price: 90,
        at: new Date((start + 3 * interval) * 1000),
        meta: { atr: 1, barLow: 85, barHigh: 100 },
      },
      portfolio.getSnapshot(90),
      [],
    );
    assert.equal(holdThroughStop.kind, "protective-command");
    assert.equal(holdThroughStop.command.intent, "close-long");
    assert.match(holdThroughStop.command.reason, /ATR/);

    const stopCmd = risk.check(
      {
        pair: "SOL/USDC",
        strategyId: "bollinger",
        side: "SELL",
        reason: "no cross",
        price: 90,
        at: new Date((start + 3 * interval) * 1000),
        meta: { atr: 1, barLow: 85, barHigh: 100 },
      },
      portfolio.getSnapshot(90),
      [],
    );
    assert.equal(stopCmd.kind, "protective-command");
    assert.equal(stopCmd.command.intent, "close-long");
    assert.match(stopCmd.command.reason, /ATR/);
  });

  it("trails from max OHLCV high since openedAt, not only the last bar", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const openedAt = new Date("2026-01-01T00:00:00.000Z");
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
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
    const risk = new GenericRiskManager(
      riskParams({ atrStopMult: 50, atrTrailMult: 2, minHoldBars: 0 }),
    );
    // Peak 120 − 2×ATR(2) = 116; barLow 115 hits trail. Last-bar-only peak would be 116 → trail 112 (no hit).
    const result = risk.check(
      {
        pair: "SOL/USDC",
        strategyId: "bollinger",
        side: "SELL",
        reason: "exit",
        price: 115,
        at: new Date((t0 + interval) * 1000),
        meta: { atr: 2, barLow: 115, barHigh: 116 },
      },
      portfolio.getSnapshot(115),
      candles,
    );
    assert.equal(result.kind, "protective-command");
    assert.match(result.command.reason, /ATR trail/);
  });
});

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
    const cmd = evaluateProtectiveExit(signal, portfolio.getSnapshot(100), riskParams());
    assert.equal(cmd, null);
  });

  it("uses atr and barLow from signal meta", () => {
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
    const cmd = evaluateProtectiveExit(
      signal,
      portfolio.getSnapshot(95),
      riskParams({ atrStopMult: 2 }),
    );
    assert.ok(cmd);
    assert.equal(cmd.intent, "close-long");
    assert.match(cmd.reason, /ATR stop/);
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
    const cmd = evaluateProtectiveExit(
      signal,
      portfolio.getSnapshot(97),
      riskParams({ atrStopMult: 50, atrTrailMult: 50 }),
    );
    assert.ok(cmd);
    assert.equal(cmd.intent, "close-long");
    assert.match(cmd.reason, /hard stop hit \(98/);
  });

  it("still stops on a bar-close wick when the close is the high", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "entry",
      price: 119,
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
      price: 123.3333,
      at: new Date("2026-01-01T00:15:00.000Z"),
      meta: { atr: 0.87, barLow: 118.777, barHigh: 123.3333 },
    };
    const cmd = evaluateProtectiveExit(
      signal,
      portfolio.getSnapshot(123.3333),
      riskParams({ atrStopMult: 50, atrTrailMult: 3 }),
      123.3333,
    );
    assert.ok(cmd);
    assert.match(cmd.reason, /ATR trail/);
  });

  it("does not trail-exit a long on the high tick because an earlier low is under the new trail", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "entry",
      price: 119,
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
      price: 123.3333,
      at: new Date("2026-01-01T00:07:30.000Z"),
      meta: { atr: 0.87, barLow: 118.777, barHigh: 123.3333 },
    };
    const cmd = evaluateProtectiveExit(
      signal,
      portfolio.getSnapshot(123.3333),
      riskParams({ atrStopMult: 50, atrTrailMult: 3 }),
      123.3333,
    );
    assert.equal(cmd, null);
  });

  it("still trail-exits a long when the low tick itself is through the trail", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "entry",
      price: 119,
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
      price: 115,
      at: new Date("2026-01-01T00:03:45.000Z"),
      meta: { atr: 1, barLow: 115, barHigh: 119 },
    };
    const cmd = evaluateProtectiveExit(
      signal,
      portfolio.getSnapshot(115),
      riskParams({ atrStopMult: 50, atrTrailMult: 2 }),
      120,
    );
    assert.ok(cmd);
    assert.match(cmd.reason, /ATR trail/);
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
    const risk = new GenericRiskManager(riskParams({ cooldownBars: 0 }));
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
    const risk = new GenericRiskManager(riskParams({ cooldownBars: 0 }));
    const result = risk.check(signal, portfolio.getSnapshot(100), []);
    assert.equal(result.kind, "risk");
    if (result.kind === "risk") {
      assert.match(result.risk.reason, /exceeds max/);
    }
  });
});

describe("HighRiskManager", () => {
  const buy: Signal = {
    pair: "SOL/USDC",
    strategyId: "bollinger",
    side: "BUY",
    reason: "cross",
    price: 100,
    at: new Date("2026-01-01T00:00:00.000Z"),
  };
  const sell: Signal = {
    pair: "SOL/USDC",
    strategyId: "bollinger",
    side: "SELL",
    reason: "exit",
    price: 110,
    at: new Date("2026-01-01T01:00:00.000Z"),
  };

  it("blocks BUY", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const risk = new HighRiskManager("trend is bearish", riskParams());
    const result = risk.check(buy, portfolio.getSnapshot(100), []);
    assert.equal(result.kind, "risk");
    if (result.kind === "risk") {
      assert.match(result.risk.reason, /high risk, trend is bearish/);
    }
  });

  it("allows SELL when long", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "entry",
      price: 100,
      size: 9,
      at: new Date("2026-01-01T00:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
    });
    const risk = new HighRiskManager("trend is flat", riskParams());
    const result = risk.check(sell, portfolio.getSnapshot(110), []);
    assert.equal(result.kind, "command");
    if (result.kind === "command") {
      assert.equal(result.command.intent, "close-long");
      assert.equal(result.command.baseSize, 9);
    }
  });

  it("fires ATR stop on HOLD when long", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "entry",
      price: 100,
      size: 9,
      at: new Date("2026-01-01T00:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
    });
    const hold: Signal = {
      pair: "SOL/USDC",
      strategyId: "bollinger",
      side: "HOLD",
      reason: "hold",
      price: 95,
      at: new Date("2026-01-01T01:00:00.000Z"),
      meta: { atr: 2, barLow: 95, barHigh: 101 },
    };
    const risk = new HighRiskManager("trend is bearish", riskParams({ atrStopMult: 2 }));
    const result = risk.check(hold, portfolio.getSnapshot(95), []);
    assert.equal(result.kind, "protective-command");
    if (result.kind === "protective-command") {
      assert.equal(result.command.intent, "close-long");
      assert.match(result.command.reason, /ATR stop/);
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
    const risk = new GenericRiskManager(riskParams());
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
    const risk = new GenericRiskManager(riskParams());
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
