import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { resetSpeculatorDbCache } from "./db.js";
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

  it("seeds SOL, USDC, JUP, and JTO on schema init", async () => {
    const tokens = await listTokens(dataDir);
    const bySymbol = new Map(tokens.map((t) => [t.symbol, t]));

    const sol = bySymbol.get("SOL");
    assert.ok(sol);
    assert.equal(sol.mint, "So11111111111111111111111111111111111111112");
    assert.equal(sol.decimals, 9);
    assert.equal(sol.poolAddress, "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj");

    const usdc = bySymbol.get("USDC");
    assert.ok(usdc);
    assert.equal(usdc.mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.equal(usdc.decimals, 6);
    assert.equal(usdc.poolAddress, undefined);

    const jup = bySymbol.get("JUP");
    assert.ok(jup);
    assert.equal(jup.mint, "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
    assert.equal(jup.decimals, 6);
    assert.equal(jup.poolAddress, "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL");

    const jto = bySymbol.get("JTO");
    assert.ok(jto);
    assert.equal(jto.mint, "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL");
    assert.equal(jto.decimals, 9);
    assert.equal(jto.poolAddress, "93MjUKNKxazKmgS3GBX2Gj2BttEjJUyi7NYeyDHdHSc2");
  });

  it("resolves WATCHLIST pairs from solana.tokens", async () => {
    const config = await loadConfig({ dataDir });
    assert.equal(config.pairs.length, 1);
    const pair = config.pairs[0];
    assert.ok(pair);
    assert.equal(pair.symbol, "SOL/USDC");
    assert.equal(pair.baseMint, "So11111111111111111111111111111111111111112");
    assert.equal(pair.quoteMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.equal(pair.baseDecimals, 9);
    assert.equal(pair.quoteDecimals, 6);
    assert.equal(pair.geckoPoolAddress, "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj");
  });

  it("getToken returns null for unknown symbols", async () => {
    assert.equal(await getToken("BONK", dataDir), null);
  });
});
