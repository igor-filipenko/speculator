import type { Command, RiskManager, Signal, Snapshot } from "../types.js";

/**
 * v1 risk: one long per pair, all-in / all-out.
 * Ignores BUY when already long; ignores SELL when flat; ignores HOLD.
 */
export class SimpleRiskManager implements RiskManager {
  check(signal: Signal, snapshot: Snapshot): Command | null {
    if (signal.side === "HOLD") {
      return null;
    }

    if (signal.side === "BUY") {
      if (snapshot.position.side === "long") {
        return null;
      }
      if (snapshot.cashUsdc <= 0 || signal.price <= 0) {
        return null;
      }
      return {
        pair: signal.pair,
        side: "BUY",
        reason: signal.reason,
        at: signal.at,
        priceHint: signal.price,
        quoteBudgetUsdc: snapshot.cashUsdc,
      };
    }

    if (snapshot.position.side !== "long" || snapshot.position.size <= 0) {
      return null;
    }
    return {
      pair: signal.pair,
      side: "SELL",
      reason: signal.reason,
      at: signal.at,
      priceHint: signal.price,
      baseSize: snapshot.position.size,
    };
  }
}
