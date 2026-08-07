import { insertSignal } from "../db/signals.js";
import type { Signal, Snapshot, Trade } from "../types.js";

export function logSignal(signal: Signal): void {
  const ts = signal.at.toISOString();
  const meta = signal.meta
    ? ` emaFast=${fmt(signal.meta.emaFast)} emaSlow=${fmt(signal.meta.emaSlow)} rsi=${fmt(signal.meta.rsi)}`
    : "";
  console.log(
    `[${ts}] ${signal.pair} ${signal.side} @ ${signal.price.toFixed(6)} — ${signal.reason}${meta}`,
  );
}

export function logTrade(trade: Trade): void {
  const pnl = trade.realizedPnl != null ? ` realizedPnl=${trade.realizedPnl.toFixed(4)} USDC` : "";
  console.log(
    `  → PAPER ${trade.side} size=${trade.size.toFixed(6)} @ ${trade.price.toFixed(6)} (simulated)${pnl}`,
  );
}

export function logSnapshot(snapshot: Snapshot): void {
  const pos =
    snapshot.position.side === "long"
      ? `long ${snapshot.position.size.toFixed(6)} @ ${snapshot.position.entryPrice.toFixed(6)}`
      : "flat";
  console.log(
    `  paper cash=${snapshot.cashUsdc.toFixed(4)} USDC | position=${pos} | equity=${snapshot.equity.toFixed(4)} | realizedPnl=${snapshot.realizedPnl.toFixed(4)}`,
  );
}

/** Persist one signal to DuckDB for later analysis. */
export async function persistSignal(signal: Signal): Promise<void> {
  await insertSignal(signal);
}

function fmt(n: number | undefined): string {
  return n == null ? "n/a" : n.toFixed(4);
}
