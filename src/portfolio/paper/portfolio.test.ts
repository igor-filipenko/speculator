import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Order, OrderIntent } from "../../types.js";
import { PaperPortfolio } from "./portfolio.js";

function order(intent: OrderIntent, price: number, size: number): Order {
  return {
    pair: "SOL/USDC",
    type: "market",
    intent,
    price,
    size,
    at: new Date("2026-01-01T00:00:00.000Z"),
    simulated: true,
    reason: "test",
    priorityFeeUsdc: 0,
  };
}

describe("PaperPortfolio long", () => {
  it("keeps unspent cash and adds close proceeds", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const opened = portfolio.applyOrderSync(order("open-long", 100, 2.5));
    assert.ok(opened);
    assert.equal(portfolio.getSnapshot(100).cashUsdc, 750);
    assert.equal(portfolio.getSnapshot(100).equity, 1000);

    const closed = portfolio.applyOrderSync(order("close-long", 110, 2.5));
    assert.ok(closed);
    assert.equal(closed.realizedPnl, 25);
    assert.equal(portfolio.getSnapshot(110).cashUsdc, 1025);
    assert.equal(portfolio.getSnapshot(110).equity, 1025);
  });

  it("includes the open priority fee in close realized PnL without charging cash twice", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const opened = portfolio.applyOrderSync({ ...order("open-long", 100, 2), priorityFeeUsdc: 1 });
    assert.ok(opened);
    assert.equal(portfolio.getSnapshot(100).cashUsdc, 799);
    assert.equal(portfolio.getSnapshot(100).position.paidFee, 1);

    const closed = portfolio.applyOrderSync({
      ...order("close-long", 110, 2),
      priorityFeeUsdc: 0.5,
    });
    assert.ok(closed);
    assert.equal(closed.realizedPnl, 2 * 110 - 0.5 - 2 * 100 - 1);
    assert.equal(portfolio.getSnapshot(110).cashUsdc, 1000 + closed.realizedPnl);
    assert.equal(portfolio.getSnapshot(110).equity, 1000 + closed.realizedPnl);
    assert.equal(portfolio.getSnapshot(110).realizedPnl, closed.realizedPnl);
    assert.equal(portfolio.getSnapshot(110).position.paidFee, undefined);
  });
});

describe("PaperPortfolio short", () => {
  it("keeps cash as collateral and realizes the cover", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const opened = portfolio.applyOrderSync(order("open-short", 100, 10));
    assert.ok(opened);
    assert.equal(portfolio.getSnapshot(100).position.side, "short");
    assert.equal(portfolio.getSnapshot(100).cashUsdc, 1000);
    assert.equal(portfolio.getSnapshot(100).equity, 1000);
    assert.equal(portfolio.getSnapshot(110).equity, 900);

    const closed = portfolio.applyOrderSync(order("close-short", 90, 10));
    assert.ok(closed);
    assert.equal(closed.realizedPnl, 100);
    assert.equal(portfolio.getSnapshot(90).position.side, "flat");
    assert.equal(portfolio.getSnapshot(90).cashUsdc, 1100);
  });

  it("includes the open priority fee in cover realized PnL", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const opened = portfolio.applyOrderSync({
      ...order("open-short", 100, 10),
      priorityFeeUsdc: 1,
    });
    assert.ok(opened);
    assert.equal(portfolio.getSnapshot(100).cashUsdc, 1000);
    assert.equal(portfolio.getSnapshot(100).position.paidFee, 1);

    const closed = portfolio.applyOrderSync({
      ...order("close-short", 90, 10),
      priorityFeeUsdc: 0.5,
    });
    assert.ok(closed);
    assert.equal(closed.realizedPnl, 100 - 0.5 - 1);
    assert.equal(portfolio.getSnapshot(90).cashUsdc, 1000 + closed.realizedPnl);
    assert.equal(portfolio.getSnapshot(90).position.paidFee, undefined);
  });

  it("deducts Jupiter perps open, close, and hourly borrow on cover", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const perps = {
      openFeePct: 0.0006,
      closeFeePct: 0.0006,
      borrowFeePctPerHour: 0.000007,
    };
    const fill = { mid: 100, slippageUsdcPerBase: 0, poolFeeUsdcPerBase: 0, perps };
    const opened = portfolio.applyOrderSync({
      ...order("open-short", 100, 10),
      at: new Date("2026-01-01T00:00:00.000Z"),
      fillCosts: fill,
    });
    assert.ok(opened);
    assert.equal(portfolio.getSnapshot(100).cashUsdc, 1000);
    const notional = 10 * 100;
    const openFee = notional * 0.0006;
    assert.equal(portfolio.getSnapshot(100).position.paidFee, openFee);
    assert.equal(opened.perpsFeeUsdc, openFee);

    const closed = portfolio.applyOrderSync({
      ...order("close-short", 90, 10),
      at: new Date("2026-01-01T02:00:00.000Z"),
      fillCosts: { ...fill, mid: 90, perps: { ...perps, openFeePct: 0.01 } },
    });
    const holdFee = notional * (0.0006 + 2 * 0.000007);
    assert.ok(closed);
    assert.equal(closed.perpsFeeUsdc, holdFee);
    assert.equal(closed.realizedPnl, 100 - openFee - holdFee);
    assert.equal(portfolio.getSnapshot(90).cashUsdc, 1000 + 100 - openFee - holdFee);
  });
});

describe("PaperPortfolio applyPositionDataSync", () => {
  function open(intent: "open-long" | "open-short", slPrice: number): PaperPortfolio {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    portfolio.applyOrderSync({ ...order(intent, 100, 1), slPrice, strategyId: "band-walker" });
    return portfolio;
  }

  it("raises a long stop and leaves size and entry alone", () => {
    const portfolio = open("open-long", 90);
    const moved = portfolio.applyPositionDataSync({
      pair: "SOL/USDC",
      at: new Date("2026-01-01T01:00:00.000Z"),
      reason: "trail",
      slPrice: 95,
    });
    assert.equal(moved, true);
    const position = portfolio.getSnapshot(100).position;
    assert.equal(position.slPrice, 95);
    assert.equal(position.size, 1);
    assert.equal(position.entryPrice, 100);
    assert.equal(position.side, "long");
    assert.equal(portfolio.getSnapshot(100).trades.length, 1);
  });

  it("refuses a looser long stop, a flat book, and another pair", () => {
    const portfolio = open("open-long", 95);
    assert.equal(
      portfolio.applyPositionDataSync({
        pair: "SOL/USDC",
        at: new Date(),
        reason: "trail",
        slPrice: 94,
      }),
      false,
    );
    assert.equal(portfolio.getSnapshot(100).position.slPrice, 95);
    const flat = new PaperPortfolio("SOL/USDC", 1000);
    assert.equal(
      flat.applyPositionDataSync({
        pair: "SOL/USDC",
        at: new Date(),
        reason: "trail",
        slPrice: 95,
      }),
      false,
    );
    assert.equal(
      portfolio.applyPositionDataSync({
        pair: "ETH/USDC",
        at: new Date(),
        reason: "trail",
        slPrice: 96,
      }),
      false,
    );
    assert.equal(portfolio.getSnapshot(100).position.slPrice, 95);
  });

  it("lowers a short stop", () => {
    const portfolio = open("open-short", 110);
    assert.equal(
      portfolio.applyPositionDataSync({
        pair: "SOL/USDC",
        at: new Date(),
        reason: "trail",
        slPrice: 105,
      }),
      true,
    );
    assert.equal(portfolio.getSnapshot(100).position.slPrice, 105);
    assert.equal(
      portfolio.applyPositionDataSync({
        pair: "SOL/USDC",
        at: new Date(),
        reason: "trail",
        slPrice: 108,
      }),
      false,
    );
    assert.equal(portfolio.getSnapshot(100).position.slPrice, 105);
  });
});
