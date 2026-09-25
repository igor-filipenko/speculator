import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fillFromSwapAmounts,
  fromAtomic,
  hasFeeSol,
  isSolMint,
  toAtomic,
  tradableBaseSize,
  WSOL_MINT,
} from "./amounts.js";

describe("amounts", () => {
  it("converts UI amounts to atomic units without overspending", () => {
    assert.equal(toAtomic(1.23456789, 6), 1_234_567n);
    assert.equal(toAtomic(0, 9), 0n);
    assert.equal(toAtomic(-1, 6), 0n);
    assert.equal(fromAtomic(1_000_000n, 6), 1);
  });

  it("treats WSOL mint as SOL", () => {
    assert.equal(isSolMint(WSOL_MINT), true);
    assert.equal(isSolMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), false);
  });

  it("subtracts the SOL fee reserve from tradable size", () => {
    assert.equal(
      tradableBaseSize({
        baseMint: WSOL_MINT,
        tokenUi: 0.01,
        nativeSol: 1,
        reserveSol: 0.05,
      }),
      0.96,
    );
    assert.equal(
      tradableBaseSize({
        baseMint: WSOL_MINT,
        tokenUi: 0,
        nativeSol: 0.04,
        reserveSol: 0.05,
      }),
      0,
    );
    assert.equal(
      tradableBaseSize({
        baseMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        tokenUi: 12.5,
        nativeSol: 0.01,
        reserveSol: 0.05,
      }),
      12.5,
    );
  });

  it("requires native SOL at or above the reserve to pay fees", () => {
    assert.equal(hasFeeSol(0.05, 0.05), true);
    assert.equal(hasFeeSol(0.049, 0.05), false);
    assert.equal(hasFeeSol(0, 0), false);
  });

  it("derives BUY fill price as quote spent per base received", () => {
    const fill = fillFromSwapAmounts({
      side: "BUY",
      inputAmount: 1_000_000n,
      outputAmount: 10_000_000n,
      baseDecimals: 9,
      quoteDecimals: 6,
    });
    assert.ok(fill);
    assert.equal(fill.size, 0.01);
    assert.equal(fill.price, 100);
  });

  it("derives SELL fill price as quote received per base sold", () => {
    const fill = fillFromSwapAmounts({
      side: "SELL",
      inputAmount: 10_000_000n,
      outputAmount: 1_000_000n,
      baseDecimals: 9,
      quoteDecimals: 6,
    });
    assert.ok(fill);
    assert.equal(fill.size, 0.01);
    assert.equal(fill.price, 100);
  });

  it("rejects zero swap amounts", () => {
    assert.equal(
      fillFromSwapAmounts({
        side: "BUY",
        inputAmount: 0n,
        outputAmount: 1n,
        baseDecimals: 9,
        quoteDecimals: 6,
      }),
      null,
    );
  });
});
