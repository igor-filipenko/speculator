import { insertSignal } from "../db/signals.js";
import type {
  Order,
  PerpsFees,
  PositionData,
  Risk,
  Signal,
  PortfolioSnapshot,
  Trade,
} from "../types.js";

export function logPerpsFees(pair: string, fees: PerpsFees | undefined): void {
  if (fees === undefined) {
    console.log(`[${pair}] no Jupiter Perps market: long-only`);
    return;
  }
  console.log(
    `[${pair}] perps fees open=${pct(fees.openFeePct)} close=${pct(fees.closeFeePct)} ` +
      `borrow=${pct(fees.borrowFeePctPerHour)}/h`,
  );
}

export function logSignal(signal: Signal): void {
  const ts = signal.at.toISOString();
  const sl = signal.slPrice != null ? ` sl=${fmt(signal.slPrice)}` : "";
  const tp =
    signal.tpPrices.length > 0 ? ` tp=${signal.tpPrices.map((p) => fmt(p)).join("/")}` : "";
  const meta = signal.meta
    ? ` emaFast=${fmt(signal.meta.emaFast)} emaSlow=${fmt(signal.meta.emaSlow)} +DI=${fmt(signal.meta.plusDi)} -DI=${fmt(signal.meta.minusDi)} volSMA=${fmt(signal.meta.volumeSma)}`
    : "";
  console.log(
    `[${ts}] ${signal.pair} ${signal.side} @ ${signal.price.toFixed(6)}` +
      ` strategy=${signal.strategyId}${sl}${tp} minR:R=${signal.minRewardRisk.toFixed(2)}` +
      ` — ${signal.reason}${meta}`,
  );
}

export function logPositionData(data: PositionData): void {
  const ts = data.at.toISOString();
  console.log(`[${ts}] ${data.pair} STOP ${data.slPrice.toFixed(4)} — ${data.reason}`);
}

export function logRisk(risk: Risk): void {
  const ts = risk.signal.at.toISOString();
  console.log(
    `[${ts}] ${risk.signal.pair} RISK — ${risk.reason} (signal ${risk.signal.side} @ ${risk.signal.price.toFixed(6)})`,
  );
}

export function logTrade(trade: Trade): void {
  const pnl = trade.realizedPnl != null ? ` realizedPnl=${trade.realizedPnl.toFixed(4)} USDC` : "";
  const reason = trade.reason ? ` — ${trade.reason}` : "";
  const sig = trade.txSignature != null ? ` sig=${trade.txSignature}` : "";
  if (trade.simulated) {
    console.log(
      `  → PAPER ${trade.side} size=${trade.size.toFixed(6)} @ ${trade.price.toFixed(6)} (simulated)${pnl}${reason}`,
    );
    return;
  }
  console.log(
    `  → LIVE ${trade.side} size=${trade.size.toFixed(6)} @ ${trade.price.toFixed(6)}${sig}${pnl}${reason}`,
  );
}

export function logOrder(order: Order): void {
  const reason = order.reason ? ` — ${order.reason}` : "";
  const sig = order.txSignature != null ? ` sig=${order.txSignature}` : "";
  if (order.simulated) {
    console.log(
      `  → PAPER ${order.intent} size=${order.size.toFixed(6)} @ ${order.price.toFixed(6)} (simulated)${sig}${reason}`,
    );
    return;
  }
  console.log(
    `  → LIVE ${order.intent} size=${order.size.toFixed(6)} @ ${order.price.toFixed(6)}${sig}${reason}`,
  );
}

export function logSnapshot(snapshot: PortfolioSnapshot): void {
  const pos = formatOpenPosition(snapshot.position);
  const label = snapshot.simulated ? "paper" : "live";
  console.log(
    `  ${label} cash=${snapshot.cashUsdc.toFixed(4)} USDC | position=${pos} | equity=${snapshot.equity.toFixed(4)} | realizedPnl=${snapshot.realizedPnl.toFixed(4)}`,
  );
}

/** CLI report matching the Telegram `/portfolio` fields. */
export function logPortfolio(pair: string, snapshot: PortfolioSnapshot): void {
  const pos = formatOpenPosition(snapshot.position);
  console.log("");
  console.log(pair);
  console.log(`Cash ${snapshot.cashUsdc.toFixed(4)} USDC`);
  console.log(`Position ${pos}`);
  console.log(`Equity ${snapshot.equity.toFixed(4)}`);
  console.log(`Realized P&L ${snapshot.realizedPnl.toFixed(4)}`);
  console.log(`Native SOL ${snapshot.nativeSol.toFixed(6)}`);
  if (snapshot.insufficientSol > 0) {
    console.log(`SOL shortfall ${snapshot.insufficientSol.toFixed(6)}`);
  }
  console.log(snapshot.simulated ? "simulated" : "live");
}

/** Persist one signal to Timescale for later analysis. */
export async function persistSignal(signal: Signal): Promise<void> {
  await insertSignal(signal);
}

function formatOpenPosition(position: { side: string; size: number; entryPrice: number }): string {
  if (position.side === "flat") {
    return "flat";
  }
  return `${position.side} ${position.size.toFixed(6)} @ ${position.entryPrice.toFixed(6)}`;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(4)}%`;
}

function fmt(n: number | undefined): string {
  return n == null ? "n/a" : n.toFixed(4);
}
