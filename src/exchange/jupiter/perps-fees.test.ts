import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  JUPITER_PERPS_FEES,
  hasPerpsMarket,
  perpsOpenFeeUsdc,
  shortCloseFeePct,
  shortPositionFeePct,
} from "./perps-fees.js";

describe("shortPositionFeePct", () => {
  it("adds open, close, and hourly borrow", () => {
    const heldMs = 2 * 60 * 60 * 1000;
    const pct = shortPositionFeePct({ ...JUPITER_PERPS_FEES, heldMs });
    assert.equal(
      pct,
      JUPITER_PERPS_FEES.openFeePct +
        JUPITER_PERPS_FEES.closeFeePct +
        2 * JUPITER_PERPS_FEES.borrowFeePctPerHour,
    );
  });

  it("ignores a negative hold", () => {
    const pct = shortPositionFeePct({ ...JUPITER_PERPS_FEES, heldMs: -1 });
    assert.equal(pct, JUPITER_PERPS_FEES.openFeePct + JUPITER_PERPS_FEES.closeFeePct);
  });

  it("leaves the open fee out of the close-and-borrow rate", () => {
    const heldMs = 2 * 60 * 60 * 1000;
    const pct = shortCloseFeePct({ ...JUPITER_PERPS_FEES, heldMs });
    assert.equal(pct, JUPITER_PERPS_FEES.closeFeePct + 2 * JUPITER_PERPS_FEES.borrowFeePctPerHour);
  });

  it("prices the open fee from the entry notional", () => {
    assert.equal(
      perpsOpenFeeUsdc({ size: 10, price: 100, fillCosts: { perps: JUPITER_PERPS_FEES } }),
      10 * 100 * JUPITER_PERPS_FEES.openFeePct,
    );
    assert.equal(perpsOpenFeeUsdc({ size: 10, price: 100 }), 0);
  });
});

describe("hasPerpsMarket", () => {
  it("lists SOL, ETH, and BTC only", () => {
    assert.equal(hasPerpsMarket("SOL/USDC"), true);
    assert.equal(hasPerpsMarket("eth/usdc"), true);
    assert.equal(hasPerpsMarket("BTC/USDC"), true);
    assert.equal(hasPerpsMarket("JUP/USDC"), false);
    assert.equal(hasPerpsMarket("JTO/USDC"), false);
    assert.equal(hasPerpsMarket(""), false);
  });
});
