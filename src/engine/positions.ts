import { createLiveRuntime } from "./trade.js";
import type { AppConfig } from "../config.js";
import { isOrder, type Command, type PairConfig, type PortfolioSnapshot } from "../types.js";

export type PositionsCommand =
  | { kind: "list" }
  | { kind: "open-long"; usdc: number }
  | { kind: "close-long" }
  | { kind: "open-short"; usdc: number }
  | { kind: "close-short" };

export function parsePositionsArgs(argv: string[]): PositionsCommand {
  const [action, side, amountRaw, extra] = argv;
  if (extra !== undefined) {
    throw new Error(positionsUsage());
  }
  if (action === "list" && argv.length === 1) {
    return { kind: "list" };
  }
  if (action === "open" && side === "long" && amountRaw !== undefined) {
    return { kind: "open-long", usdc: parseUsdc(amountRaw, "open long") };
  }
  if (action === "close" && side === "long" && argv.length === 2) {
    return { kind: "close-long" };
  }
  if (action === "open" && side === "short" && amountRaw !== undefined) {
    return { kind: "open-short", usdc: parseUsdc(amountRaw, "open short") };
  }
  if (action === "close" && side === "short" && argv.length === 2) {
    return { kind: "close-short" };
  }
  throw new Error(positionsUsage());
}

export function positionsUsage(): string {
  return [
    "Usage:",
    "  positions list",
    "  positions open long <usdc>",
    "  positions close long",
    "  positions open short <usdc>",
    "  positions close short",
  ].join("\n");
}

export function formatSnapshot(symbol: string, snapshot: PortfolioSnapshot, mark: number): string {
  const position = snapshot.position;
  if (position.side === "flat") {
    return `${symbol} flat  mark ${mark.toFixed(2)}  cash $${snapshot.cashUsdc.toFixed(2)}`;
  }
  return `${symbol} ${position.side} size ${position.size} @ ${position.entryPrice.toFixed(2)} mark ${mark.toFixed(2)}  cash $${snapshot.cashUsdc.toFixed(2)}`;
}

/**
 * Manual live position commands on the first WATCHLIST pair.
 * Longs are spot swaps. Shorts are Jupiter Perps. Both go through JupiterExchange.execute.
 */
export async function runPositions(config: AppConfig, argv: string[]): Promise<void> {
  const command = parsePositionsArgs(argv);
  const pair = config.pairs[0];
  if (pair === undefined) {
    throw new Error("WATCHLIST is empty");
  }
  const runtime = await createLiveRuntime(config);
  const exchange = runtime.exchange;
  const portfolio = runtime.portfolios.get(pair.symbol);
  if (portfolio === undefined) {
    throw new Error(`no portfolio for ${pair.symbol}`);
  }
  const mark = await exchange.spotPrice(pair);
  await portfolio.syncFromChain(mark);
  const snapshot = portfolio.getSnapshot(mark);
  console.log(`Wallet ${runtime.walletAddress}`);
  console.log(formatSnapshot(pair.symbol, snapshot, mark));

  if (command.kind === "list") {
    return;
  }

  const order = await exchange.execute(toCommand(command, pair, snapshot, mark), pair);
  if (!isOrder(order)) {
    throw new Error(order.message);
  }
  const tx = order.txSignature !== undefined ? ` ${order.txSignature}` : "";
  console.log(
    `${order.simulated ? "simulated" : "LIVE"} ${order.side} ${pair.symbol} size ${order.size} @ ${order.price}${tx}`,
  );
}

function toCommand(
  command: Exclude<PositionsCommand, { kind: "list" }>,
  pair: PairConfig,
  snapshot: PortfolioSnapshot,
  mark: number,
): Command {
  const at = new Date();
  switch (command.kind) {
    case "open-long":
      return {
        pair: pair.symbol,
        side: "BUY",
        intent: "open-long",
        reason: "positions open long",
        at,
        priceHint: mark,
        quoteBudgetUsdc: command.usdc,
      };
    case "close-long": {
      if (snapshot.position.side !== "long" || !(snapshot.position.size > 0)) {
        throw new Error(`no open long for ${pair.symbol}`);
      }
      return {
        pair: pair.symbol,
        side: "SELL",
        intent: "close-long",
        reason: "positions close long",
        at,
        priceHint: mark,
        baseSize: snapshot.position.size,
      };
    }
    case "open-short":
      return {
        pair: pair.symbol,
        side: "SELL",
        intent: "open-short",
        reason: "positions open short",
        at,
        priceHint: mark,
        quoteBudgetUsdc: command.usdc,
      };
    case "close-short": {
      if (snapshot.position.side !== "short" || !(snapshot.position.size > 0)) {
        throw new Error(`no open short for ${pair.symbol}`);
      }
      return {
        pair: pair.symbol,
        side: "BUY",
        intent: "close-short",
        reason: "positions close short",
        at,
        priceHint: mark,
        baseSize: snapshot.position.size,
      };
    }
  }
}

function parseUsdc(raw: string, label: string): number {
  const usdc = Number(raw);
  if (!Number.isFinite(usdc) || usdc <= 0) {
    throw new Error(`positions ${label} expects a positive USDC amount, got "${raw}"`);
  }
  return usdc;
}
