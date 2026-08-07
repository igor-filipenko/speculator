import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { resetSpeculatorDbCache } from "../db/db.js";
import { PaperPortfolio } from "./portfolio.js";
import { loadPaperState, savePaperState } from "./store.js";

describe("paper store (DuckDB)", () => {
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "speculator-paper-"));
  });

  after(async () => {
    resetSpeculatorDbCache();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("saves and loads a portfolio round-trip", async () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const trade = portfolio.applySignalSync({
      pair: "SOL/USDC",
      side: "BUY",
      reason: "test buy",
      price: 100,
      at: new Date("2026-07-31T10:00:00.000Z"),
    });
    assert.ok(trade);

    const portfolios = new Map([["SOL/USDC", portfolio]]);
    await savePaperState(portfolios, dataDir);

    const loaded = await loadPaperState(dataDir);
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
    sol.applySignalSync({
      pair: "SOL/USDC",
      side: "BUY",
      reason: "sol buy",
      price: 100,
      at: new Date("2026-07-31T10:00:00.000Z"),
    });
    await savePaperState(new Map([["SOL/USDC", sol]]), dataDir);

    const other = new PaperPortfolio("BONK/USDC", 500);
    other.applySignalSync({
      pair: "BONK/USDC",
      side: "BUY",
      reason: "bonk buy",
      price: 0.00001,
      at: new Date("2026-07-31T11:00:00.000Z"),
    });
    await savePaperState(new Map([["BONK/USDC", other]]), dataDir);

    const loaded = await loadPaperState(dataDir);
    assert.ok(loaded);
    assert.ok(loaded.portfolios["SOL/USDC"]);
    assert.ok(loaded.portfolios["BONK/USDC"]);
    assert.equal(loaded.portfolios["SOL/USDC"]?.cashUsdc, 0);
    assert.equal(loaded.portfolios["BONK/USDC"]?.cashUsdc, 0);
  });

  it("returns null when DuckDB has no paper rows", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "speculator-paper-empty-"));
    try {
      resetSpeculatorDbCache();
      const loaded = await loadPaperState(emptyDir);
      assert.equal(loaded, null);
    } finally {
      resetSpeculatorDbCache();
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
