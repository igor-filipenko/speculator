import type { PersistedPortfolio, PersistedPosition, PersistedTrade } from "../paper/store.js";
import { getSpeculatorDb } from "./speculator-db.js";

const UPSERT_PORTFOLIO_SQL = `
  INSERT INTO paper.portfolios (
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
  INSERT INTO paper.trades (pair, side, price, size, realized_pnl, "at", simulated)
  VALUES ($pair, $side, $price, $size, $realizedPnl, $at::TIMESTAMP, true)
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
  // DuckDB may return { micros: bigint } or similar for TIMESTAMP
  if (typeof value === "object" && "micros" in value) {
    const micros = Number((value as { micros: bigint | number }).micros);
    return new Date(micros / 1000).toISOString();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return new Date(Number(value)).toISOString();
  }
  throw new Error(`unsupported timestamp value: ${typeof value}`);
}

function rowToTrade(row: Record<string, unknown>): PersistedTrade {
  const at = timestampToIso(row["at"]);
  if (at === undefined) {
    throw new Error("paper.trades row missing at");
  }
  const trade: PersistedTrade = {
    pair: asString(row["pair"], "pair"),
    side: row["side"] === "SELL" ? "SELL" : "BUY",
    price: Number(row["price"]),
    size: Number(row["size"]),
    at,
    simulated: true,
  };
  if (row["realized_pnl"] != null) {
    trade.realizedPnl = Number(row["realized_pnl"]);
  }
  return trade;
}

function rowToPosition(row: Record<string, unknown>): PersistedPosition {
  const position: PersistedPosition = {
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

/** Count paper portfolio rows (for empty-check). */
export async function paperPortfolioCount(dataDir?: string): Promise<number> {
  const conn = await getSpeculatorDb(dataDir);
  const reader = await conn.runAndReadAll(`SELECT count(*)::BIGINT AS cnt FROM paper.portfolios`);
  await reader.readAll();
  const row = reader.getRowObjectsJS()[0];
  return row ? Number(row["cnt"]) : 0;
}

/** Load all paper portfolios with their trades (ordered by fill time). */
export async function loadAllPaperPortfolios(
  dataDir?: string,
): Promise<Record<string, PersistedPortfolio>> {
  const conn = await getSpeculatorDb(dataDir);

  const portfolioReader = await conn.runAndReadAll(`
    SELECT
      pair, cash_usdc, realized_pnl,
      position_side, position_size, entry_price, opened_at, updated_at
    FROM paper.portfolios
    ORDER BY pair
  `);
  await portfolioReader.readAll();
  const portfolioRows = portfolioReader.getRowObjectsJS();

  if (portfolioRows.length === 0) {
    return {};
  }

  const tradeReader = await conn.runAndReadAll(`
    SELECT pair, side, price, size, realized_pnl, "at", simulated
    FROM paper.trades
    ORDER BY "at", id
  `);
  await tradeReader.readAll();
  const tradeRows = tradeReader.getRowObjectsJS();

  const tradesByPair = new Map<string, PersistedTrade[]>();
  for (const row of tradeRows) {
    const trade = rowToTrade(row);
    const list = tradesByPair.get(trade.pair) ?? [];
    list.push(trade);
    tradesByPair.set(trade.pair, list);
  }

  const portfolios: Record<string, PersistedPortfolio> = {};
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

/** Upsert one paper portfolio row (does not touch trades). */
export async function upsertPaperPortfolio(
  portfolio: PersistedPortfolio,
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

/** Append one simulated paper fill. */
export async function insertPaperTrade(trade: PersistedTrade, dataDir?: string): Promise<void> {
  const conn = await getSpeculatorDb(dataDir);
  await conn.run(INSERT_TRADE_SQL, {
    pair: trade.pair,
    side: trade.side,
    price: trade.price,
    size: trade.size,
    realizedPnl: trade.realizedPnl ?? null,
    at: trade.at,
  });
}

/**
 * Upsert portfolio and replace its trade history (delete + insert).
 * Used for full snapshot saves.
 */
export async function syncPaperPortfolio(
  portfolio: PersistedPortfolio,
  dataDir?: string,
): Promise<void> {
  const conn = await getSpeculatorDb(dataDir);
  const pair = portfolio.position.pair;

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(UPSERT_PORTFOLIO_SQL, {
      pair,
      cashUsdc: portfolio.cashUsdc,
      realizedPnl: portfolio.realizedPnl,
      positionSide: portfolio.position.side,
      positionSize: portfolio.position.size,
      entryPrice: portfolio.position.entryPrice,
      openedAt: portfolio.position.openedAt ?? null,
    });

    await conn.run(`DELETE FROM paper.trades WHERE pair = $pair`, { pair });

    for (const trade of portfolio.trades) {
      await conn.run(INSERT_TRADE_SQL, {
        pair: trade.pair,
        side: trade.side,
        price: trade.price,
        size: trade.size,
        realizedPnl: trade.realizedPnl ?? null,
        at: trade.at,
      });
    }

    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}
