import type { PerpsFees } from "../../types.js";

/**
 * Snapshot of https://perps-api.jup.ag/v1/pool-info?mint=SOL (2026-10-02).
 * `openFeePercent` is 0.06. Close is the same 6 bps (`decreasePositionBps` /
 * decrease-quote `closeFeeUsd`). `shortBorrowRatePercent` is 0.0007 and is the
 * live hourly rate on the USDC collateral custody (shared by SOL, ETH, and BTC shorts).
 * Price impact is not included: it scales with size and open-interest imbalance,
 * and pool-info only publishes the cap (`maxPriceImpactFeePercent`, currently 0.44%).
 */
export const JUPITER_PERPS_FEES: PerpsFees = {
  openFeePct: 0.06 / 100,
  closeFeePct: 0.06 / 100,
  borrowFeePctPerHour: 0.0007 / 100,
};

/** Open + close + hourly borrow accrued over `heldMs`, as a fraction of entry notional. */
export function shortPositionFeePct(input: PerpsFees & { heldMs: number }): number {
  return input.openFeePct + shortCloseFeePct(input);
}

/**
 * Close fee plus hourly borrow over `heldMs`, as a fraction of entry notional.
 * The open fee is charged once, when the short is opened.
 */
export function shortCloseFeePct(input: PerpsFees & { heldMs: number }): number {
  const hours = Math.max(0, input.heldMs) / 3_600_000;
  return input.closeFeePct + hours * input.borrowFeePctPerHour;
}

/** Perps open fee in USDC. Zero when this fill has no perps schedule. */
export function perpsOpenFeeUsdc(order: {
  size: number;
  price: number;
  fillCosts?: { perps?: PerpsFees };
}): number {
  const openFeePct = order.fillCosts?.perps?.openFeePct ?? 0;
  if (!(openFeePct > 0) || !(order.size > 0) || !(order.price > 0)) {
    return 0;
  }
  return order.size * order.price * openFeePct;
}
