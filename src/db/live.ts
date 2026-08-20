import type {
  PersistedLivePortfolio,
  PersistedLivePosition,
  PersistedLiveTrade,
} from "../live/store.js";
import { getSpeculatorDb } from "./db.js";

const UPSERT_PORTFOLIO_SQL = `
  INSERT INTO live.portfolios (
    pair, cash_usdc, realized_pnl,
    position_side, position_size, entry_price, opened_at, updated_at
  )
  VALUES (
    $pair, $cashUsdc, $realizedPnl,
    $positionSide, $positionSize, $entryPrice, $openedAt::TIMESTAMP, now()
  )
  ON CONFLICT (pair) DO UPDATE SET
    cash_usdc = excluded.cash_usdc,
    realized_pnl = excluded.realized_pnl,
    position_side = excluded.position_side,
    position_size = excluded.position_size,
    entry_price = excluded.entry_price,
    opened_at = excluded.opened_at,
    updated_at = now()
`;

const INSERT_TRADE_SQL = `
  INSERT INTO live.trades (pair, side, price, size, realized_pnl, "at", simulated, tx_signature)
  VALUES ($pair, $side, $price, $size, $realizedPnl, $at::TIMESTAMP, $simulated, $txSignature)
`;

function asString(value: unknown, field: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  throw new Error(`expected string for ${field}, got ${typeof value}`);
}

function timestampToIso(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return new Date(value).toISOString();
  }
  if (typeof value === "object" && "micros" in value) {
    const micros = Number((value as { micros: bigint | number }).micros);
    return new Date(micros / 1000).toISOString();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return new Date(Number(value)).toISOString();
  }
  throw new Error(`unsupported timestamp value: ${typeof value}`);
}

function rowToTrade(row: Record<string, unknown>): PersistedLiveTrade {
  const at = timestampToIso(row["at"]);
  if (at === undefined) {
    throw new Error("live.trades row missing at");
  }
  const trade: PersistedLiveTrade = {
    pair: asString(row["pair"], "pair"),
    side: row["side"] === "SELL" ? "SELL" : "BUY",
    price: Number(row["price"]),
    size: Number(row["size"]),
    at,
    simulated: row["simulated"] === true,
  };
  if (row["realized_pnl"] != null) {
    trade.realizedPnl = Number(row["realized_pnl"]);
  }
  if (typeof row["tx_signature"] === "string" && row["tx_signature"].length > 0) {
    trade.txSignature = row["tx_signature"];
  }
  return trade;
}

function rowToPosition(row: Record<string, unknown>): PersistedLivePosition {
  const position: PersistedLivePosition = {
    pair: asString(row["pair"], "pair"),
    side: row["position_side"] === "long" ? "long" : "flat",
    size: Number(row["position_size"]),
    entryPrice: Number(row["entry_price"]),
  };
  const openedAt = timestampToIso(row["opened_at"]);
  if (openedAt !== undefined) {
    position.openedAt = openedAt;
  }
  return position;
}

/** Count live portfolio rows (for empty-check). */
export async function livePortfolioCount(dataDir?: string): Promise<number> {
  const conn = await getSpeculatorDb(dataDir);
  const reader = await conn.runAndReadAll(`SELECT count(*)::BIGINT AS cnt FROM live.portfolios`);
  await reader.readAll();
  const row = reader.getRowObjectsJS()[0];
  return row ? Number(row["cnt"]) : 0;
}

/** Load all live portfolios with their trades (ordered by fill time). */
export async function loadAllLivePortfolios(
  dataDir?: string,
): Promise<Record<string, PersistedLivePortfolio>> {
  const conn = await getSpeculatorDb(dataDir);

  const portfolioReader = await conn.runAndReadAll(`
    SELECT
      pair, cash_usdc, realized_pnl,
      position_side, position_size, entry_price, opened_at, updated_at
    FROM live.portfolios
    ORDER BY pair
  `);
  await portfolioReader.readAll();
  const portfolioRows = portfolioReader.getRowObjectsJS();

  if (portfolioRows.length === 0) {
    return {};
  }

  const tradeReader = await conn.runAndReadAll(`
    SELECT pair, side, price, size, realized_pnl, "at", simulated, tx_signature
    FROM live.trades
    ORDER BY "at", id
  `);
  await tradeReader.readAll();
  const tradeRows = tradeReader.getRowObjectsJS();

  const tradesByPair = new Map<string, PersistedLiveTrade[]>();
  for (const row of tradeRows) {
    const trade = rowToTrade(row);
    const list = tradesByPair.get(trade.pair) ?? [];
    list.push(trade);
    tradesByPair.set(trade.pair, list);
  }

  const portfolios: Record<string, PersistedLivePortfolio> = {};
  for (const row of portfolioRows) {
    const pair = asString(row["pair"], "pair");
    portfolios[pair] = {
      cashUsdc: Number(row["cash_usdc"]),
      realizedPnl: Number(row["realized_pnl"]),
      position: rowToPosition(row),
      trades: tradesByPair.get(pair) ?? [],
    };
  }
  return portfolios;
}

/** Upsert one live portfolio row (does not touch trades). */
export async function upsertLivePortfolio(
  portfolio: PersistedLivePortfolio,
  dataDir?: string,
): Promise<void> {
  const conn = await getSpeculatorDb(dataDir);
  await conn.run(UPSERT_PORTFOLIO_SQL, {
    pair: portfolio.position.pair,
    cashUsdc: portfolio.cashUsdc,
    realizedPnl: portfolio.realizedPnl,
    positionSide: portfolio.position.side,
    positionSize: portfolio.position.size,
    entryPrice: portfolio.position.entryPrice,
    openedAt: portfolio.position.openedAt ?? null,
  });
}

/** Append one live fill. */
export async function insertLiveTrade(trade: PersistedLiveTrade, dataDir?: string): Promise<void> {
  const conn = await getSpeculatorDb(dataDir);
  await conn.run(INSERT_TRADE_SQL, {
    pair: trade.pair,
    side: trade.side,
    price: trade.price,
    size: trade.size,
    realizedPnl: trade.realizedPnl ?? null,
    at: trade.at,
    simulated: trade.simulated,
    txSignature: trade.txSignature ?? null,
  });
}

/** Load live state or null when the table is empty. */
export async function loadLiveState(
  dataDir?: string,
): Promise<{ portfolios: Record<string, PersistedLivePortfolio> } | null> {
  const count = await livePortfolioCount(dataDir);
  if (count === 0) {
    return null;
  }
  const portfolios = await loadAllLivePortfolios(dataDir);
  if (Object.keys(portfolios).length === 0) {
    return null;
  }
  return { portfolios };
}
