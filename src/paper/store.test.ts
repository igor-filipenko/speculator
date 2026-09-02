import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PaperPortfolio } from "./portfolio.js";
import { loadPaperState, savePaperState } from "./store.js";
import { resetSpeculatorDbCache, setBotId } from "../db/db.js";
import { randomUUID } from "node:crypto";
import { useTestDb } from "../db/test-db.js";

describe("paper store", () => {
  before(async () => {
    await useTestDb();
  });

  after(async () => {
    await resetSpeculatorDbCache();
  });

  it("saves and loads a portfolio round-trip", async () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const trade = portfolio.applyOrderSync({
      pair: "SOL/USDC",
      side: "BUY",
      reason: "test buy",
      price: 100,
      size: 10,
      at: new Date("2026-07-31T10:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
    });
    assert.ok(trade);

    const portfolios = new Map([["SOL/USDC", portfolio]]);
    await savePaperState(portfolios);

    const loaded = await loadPaperState();
    assert.ok(loaded);
    assert.equal(loaded.version, 1);
    assert.ok(loaded.updatedAt.length > 0);

    const persisted = loaded.portfolios["SOL/USDC"];
    assert.ok(persisted);

    const restored = PaperPortfolio.fromPersisted(persisted);
    assert.deepEqual(restored.toPersisted(), portfolio.toPersisted());
  });

  it("upserting one pair does not erase another", async () => {
    const sol = new PaperPortfolio("SOL/USDC", 1000);
    sol.applyOrderSync({
      pair: "SOL/USDC",
      side: "BUY",
      reason: "sol buy",
      price: 100,
      size: 10,
      at: new Date("2026-07-31T10:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
    });
    await savePaperState(new Map([["SOL/USDC", sol]]));

    const other = new PaperPortfolio("BONK/USDC", 500);
    other.applyOrderSync({
      pair: "BONK/USDC",
      side: "BUY",
      reason: "bonk buy",
      price: 0.00001,
      size: 50_000_000,
      at: new Date("2026-07-31T11:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
    });
    await savePaperState(new Map([["BONK/USDC", other]]));

    const loaded = await loadPaperState();
    assert.ok(loaded);
    assert.ok(loaded.portfolios["SOL/USDC"]);
    assert.ok(loaded.portfolios["BONK/USDC"]);
    assert.equal(loaded.portfolios["SOL/USDC"]?.cashUsdc, 0);
    assert.equal(loaded.portfolios["BONK/USDC"]?.cashUsdc, 0);
  });

  it("returns null when there are no paper rows for this bot", async () => {
    const otherBot = `empty-${randomUUID()}`;
    setBotId(otherBot);
    process.env["BOT_ID"] = otherBot;
    const loaded = await loadPaperState();
    assert.equal(loaded, null);
  });
});
