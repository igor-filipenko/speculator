import type { JupiterPerpsFeeSchedule } from "../../types.js";

/**
 * Snapshot of https://perps-api.jup.ag/v1/pool-info?mint=SOL (2026-10-02).
 * `openFeePercent` is 0.06. Close is the same 6 bps (`decreasePositionBps` /
 * decrease-quote `closeFeeUsd`). `shortBorrowRatePercent` is 0.0007 and is the
 * live hourly rate on the USDC collateral custody (shared by SOL, ETH, and BTC shorts).
 * Price impact is not included: it scales with size and open-interest imbalance,
 * and pool-info only publishes the cap (`maxPriceImpactFeePercent`, currently 0.44%).
 */
export const JUPITER_PERPS_FEES: JupiterPerpsFeeSchedule = {
  openFeePct: 0.06 / 100,
  closeFeePct: 0.06 / 100,
  borrowFeePctPerHour: 0.0007 / 100,
};

/** Open + close + hourly borrow accrued over `heldMs`, as a fraction of entry notional. */
export function shortPositionFeePct(input: JupiterPerpsFeeSchedule & { heldMs: number }): number {
  const hours = Math.max(0, input.heldMs) / 3_600_000;
  return input.openFeePct + input.closeFeePct + hours * input.borrowFeePctPerHour;
}
