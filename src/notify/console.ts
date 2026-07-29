import { appendFile } from "node:fs/promises";
import type { Signal } from "../types.js";
import type { PaperSnapshot, PaperTrade } from "../paper/portfolio.js";

const JSONL_PATH = "signals.jsonl";

export function logSignal(signal: Signal): void {
  const ts = signal.at.toISOString();
  const meta = signal.meta
    ? ` emaFast=${fmt(signal.meta.emaFast)} emaSlow=${fmt(signal.meta.emaSlow)} rsi=${fmt(signal.meta.rsi)}`
    : "";
  console.log(
    `[${ts}] ${signal.pair} ${signal.side} @ ${signal.price.toFixed(6)} — ${signal.reason}${meta}`,
  );
}

export function logPaperTrade(trade: PaperTrade): void {
  const pnl =
    trade.realizedPnl != null
      ? ` realizedPnl=${trade.realizedPnl.toFixed(4)} USDC`
      : "";
  console.log(
    `  → PAPER ${trade.side} size=${trade.size.toFixed(6)} @ ${trade.price.toFixed(6)} (simulated)${pnl}`,
  );
}

export function logPaperSnapshot(snapshot: PaperSnapshot): void {
  const pos =
    snapshot.position.side === "long"
      ? `long ${snapshot.position.size.toFixed(6)} @ ${snapshot.position.entryPrice.toFixed(6)}`
      : "flat";
  console.log(
    `  paper cash=${snapshot.cashUsdc.toFixed(4)} USDC | position=${pos} | equity=${snapshot.equity.toFixed(4)} | realizedPnl=${snapshot.realizedPnl.toFixed(4)}`,
  );
}

/** Append one JSON line for later analysis. */
export async function appendSignalJsonl(signal: Signal): Promise<void> {
  const line = JSON.stringify({
    at: signal.at.toISOString(),
    pair: signal.pair,
    side: signal.side,
    price: signal.price,
    reason: signal.reason,
    meta: signal.meta,
  });
  await appendFile(JSONL_PATH, `${line}\n`, "utf8");
}

function fmt(n: number | undefined): string {
  return n == null ? "n/a" : n.toFixed(4);
}
