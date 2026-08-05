import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRIORITY_FEE_SOL,
  TIER_COSTS,
  emulateFillPrice,
  liquidityTierForPair,
} from "./emulated-quote.js";

describe("emulateFillPrice", () => {
  it("applies adverse liquid costs on BUY and SELL", () => {
    const close = 100;
    const { slippage, poolFee } = TIER_COSTS.liquid;
    const adverse = slippage + poolFee;

    const buy = emulateFillPrice({ side: "BUY", close, tier: "liquid" });
    assert.equal(buy.fillPrice, close * (1 + adverse));
    assert.equal(buy.priorityFeeUsdc, PRIORITY_FEE_SOL * close);
    assert.equal(buy.breakdown.mid, close);
    assert.equal(buy.breakdown.slippage, slippage);
    assert.equal(buy.breakdown.poolFee, poolFee);

    const sell = emulateFillPrice({ side: "SELL", close, tier: "liquid" });
    assert.equal(sell.fillPrice, close * (1 - adverse));
    assert.equal(sell.priorityFeeUsdc, PRIORITY_FEE_SOL * close);
  });

  it("uses higher meme slippage and pool fee", () => {
    const close = 1;
    const buy = emulateFillPrice({ side: "BUY", close, tier: "meme" });
    const adverse = TIER_COSTS.meme.slippage + TIER_COSTS.meme.poolFee;
    assert.equal(buy.fillPrice, close * (1 + adverse));
    assert.equal(buy.breakdown.slippage, 0.02);
    assert.equal(buy.breakdown.poolFee, 0.003);
  });

  it("rejects non-positive close", () => {
    assert.throws(() => emulateFillPrice({ side: "BUY", close: 0 }), /invalid close/);
  });
});

describe("liquidityTierForPair", () => {
  it("marks SOL/USDC as liquid and others as meme", () => {
    assert.equal(liquidityTierForPair("SOL/USDC"), "liquid");
    assert.equal(liquidityTierForPair("sol/usdc"), "liquid");
    assert.equal(liquidityTierForPair("MEME/USDC"), "meme");
  });
});
