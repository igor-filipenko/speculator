import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { PaperPortfolio } from "./portfolio.js";
import { loadPaperState, savePaperState } from "./store.js";

describe("paper store", () => {
  let dir: string;
  let statePath: string;
  let warnMock: ReturnType<typeof mock.method>;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "speculator-paper-"));
    statePath = join(dir, "paper-state.json");
    warnMock = mock.method(console, "warn", () => {
      /* silence expected warnings in invalid-file tests */
    });
  });

  after(async () => {
    warnMock.mock.restore();
    await rm(dir, { recursive: true, force: true });
  });

  it("saves and loads a portfolio round-trip", async () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const trade = portfolio.applySignal({
      pair: "SOL/USDC",
      side: "BUY",
      reason: "test buy",
      price: 100,
      at: new Date("2026-07-31T10:00:00.000Z"),
    });
    assert.ok(trade);

    const portfolios = new Map([["SOL/USDC", portfolio]]);
    await savePaperState(portfolios, statePath);

    const loaded = await loadPaperState(statePath);
    assert.ok(loaded);
    assert.equal(loaded.version, 1);
    assert.ok(loaded.updatedAt.length > 0);

    const persisted = loaded.portfolios["SOL/USDC"];
    assert.ok(persisted);

    const restored = PaperPortfolio.fromPersisted(persisted);
    assert.deepEqual(restored.toPersisted(), portfolio.toPersisted());
  });

  it("returns null when the state file does not exist", async () => {
    const missing = join(dir, "does-not-exist.json");
    const loaded = await loadPaperState(missing);
    assert.equal(loaded, null);
  });

  it("returns null for invalid JSON", async () => {
    const badPath = join(dir, "invalid-json.json");
    await writeFile(badPath, "{not json", "utf8");
    const loaded = await loadPaperState(badPath);
    assert.equal(loaded, null);
  });

  it("returns null for schema-invalid JSON", async () => {
    const badPath = join(dir, "bad-schema.json");
    await writeFile(badPath, JSON.stringify({ version: 2 }), "utf8");
    const loaded = await loadPaperState(badPath);
    assert.equal(loaded, null);
  });
});
