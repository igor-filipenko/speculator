import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JUPITER_PERPS_FEES, shortPositionFeePct } from "./perps-fees.js";

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
});
