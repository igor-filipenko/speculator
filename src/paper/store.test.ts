import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { resetSpeculatorDbCache } from "../db/speculator-db.js";
import { PaperPortfolio } from "./portfolio.js";
import { LEGACY_PAPER_STATE_PATH, loadPaperState, savePaperState } from "./store.js";

describe("paper store (DuckDB)", () => {
  let dataDir: string;
  let warnMock: ReturnType<typeof mock.method>;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "speculator-paper-"));
    warnMock = mock.method(console, "warn", () => {
      /* silence expected warnings */
    });
  });

  after(async () => {
    warnMock.mock.restore();
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
    const cwd = process.cwd();
    try {
      process.chdir(emptyDir);
      resetSpeculatorDbCache();
      const loaded = await loadPaperState(join(emptyDir, "data"));
      assert.equal(loaded, null);
    } finally {
      process.chdir(cwd);
      resetSpeculatorDbCache();
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("imports legacy paper-state.json when DuckDB is empty", async () => {
    const importDir = await mkdtemp(join(tmpdir(), "speculator-paper-import-"));
    const cwd = process.cwd();
    try {
      process.chdir(importDir);
      resetSpeculatorDbCache();

      const legacy = {
        version: 1 as const,
        updatedAt: "2026-07-31T12:00:00.000Z",
        portfolios: {
          "SOL/USDC": {
            cashUsdc: 250,
            realizedPnl: 10,
            position: {
              pair: "SOL/USDC",
              side: "flat" as const,
              size: 0,
              entryPrice: 0,
            },
            trades: [
              {
                pair: "SOL/USDC",
                side: "BUY" as const,
                price: 100,
                size: 1,
                at: "2026-07-31T10:00:00.000Z",
                simulated: true as const,
              },
              {
                pair: "SOL/USDC",
                side: "SELL" as const,
                price: 110,
                size: 1,
                realizedPnl: 10,
                at: "2026-07-31T11:00:00.000Z",
                simulated: true as const,
              },
            ],
          },
        },
      };
      await writeFile(LEGACY_PAPER_STATE_PATH, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

      const dbDir = join(importDir, "data");
      const loaded = await loadPaperState(dbDir);
      assert.ok(loaded);
      assert.equal(loaded.portfolios["SOL/USDC"]?.cashUsdc, 250);
      assert.equal(loaded.portfolios["SOL/USDC"]?.trades.length, 2);

      // Second load uses DuckDB only (no re-import needed)
      const again = await loadPaperState(dbDir);
      assert.ok(again);
      assert.equal(again.portfolios["SOL/USDC"]?.realizedPnl, 10);
    } finally {
      process.chdir(cwd);
      resetSpeculatorDbCache();
      await rm(importDir, { recursive: true, force: true });
    }
  });
});
