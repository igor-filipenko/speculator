import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { resetSpeculatorDbCache } from "./speculator-db.js";
import { getToken, listTokens } from "./tokens.js";

describe("solana.tokens", () => {
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "speculator-tokens-"));
  });

  after(async () => {
    resetSpeculatorDbCache();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("seeds SOL and USDC on schema init", async () => {
    const tokens = await listTokens(dataDir);
    const bySymbol = new Map(tokens.map((t) => [t.symbol, t]));

    const sol = bySymbol.get("SOL");
    assert.ok(sol);
    assert.equal(sol.mint, "So11111111111111111111111111111111111111112");
    assert.equal(sol.pool, "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj");

    const usdc = bySymbol.get("USDC");
    assert.ok(usdc);
    assert.equal(usdc.mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.equal(usdc.pool, undefined);
  });

  it("resolves WATCHLIST pairs from solana.tokens", async () => {
    const config = await loadConfig({ mode: "signal", dataDir });
    assert.equal(config.pairs.length, 1);
    const pair = config.pairs[0];
    assert.ok(pair);
    assert.equal(pair.symbol, "SOL/USDC");
    assert.equal(pair.baseMint, "So11111111111111111111111111111111111111112");
    assert.equal(pair.quoteMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.equal(pair.geckoPoolAddress, "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj");
  });

  it("getToken returns null for unknown symbols", async () => {
    assert.equal(await getToken("BONK", dataDir), null);
  });
});
