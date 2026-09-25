import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Order } from "../../types.js";
import { PaperPortfolio } from "./portfolio.js";

function order(side: "BUY" | "SELL", price: number, size: number): Order {
  return {
    pair: "SOL/USDC",
    side,
    price,
    size,
    at: new Date("2026-01-01T00:00:00.000Z"),
    simulated: true,
    reason: "test",
    priorityFeeUsdc: 0,
  };
}

describe("PaperPortfolio short", () => {
  it("keeps cash as collateral and realizes the cover", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const opened = portfolio.applyOrderSync(order("SELL", 100, 10));
    assert.ok(opened);
    assert.equal(portfolio.getSnapshot(100).position.side, "short");
    assert.equal(portfolio.getSnapshot(100).cashUsdc, 1000);
    assert.equal(portfolio.getSnapshot(100).equity, 1000);
    assert.equal(portfolio.getSnapshot(110).equity, 900);

    const closed = portfolio.applyOrderSync(order("BUY", 90, 10));
    assert.ok(closed);
    assert.equal(closed.realizedPnl, 100);
    assert.equal(portfolio.getSnapshot(90).position.side, "flat");
    assert.equal(portfolio.getSnapshot(90).cashUsdc, 1100);
  });
});
