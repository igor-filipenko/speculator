import type { PoolClient } from "pg";
import type { PersistedLivePortfolio, PersistedLiveTrade } from "../portfolio/live/store.js";
import type {
  PersistedPortfolio,
  PersistedPosition,
  PersistedTrade,
} from "../portfolio/paper/store.js";
import { getBotId, query, queryWith, withTransaction, type SqlValue } from "./db.js";

export type BotMode = "paper" | "live";

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
  throw new Error(`unsupported timestamp value: ${typeof value}`);
}

function rowToTrade(row: Record<string, unknown>): PersistedLiveTrade {
  const at = timestampToIso(row["at"]);
  if (at === undefined) {
    throw new Error("bot.trades row missing at");
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

function rowToPosition(row: Record<string, unknown>): PersistedLivePortfolio["position"] {
  const position: PersistedLivePortfolio["position"] = {
    pair: asString(row["pair"], "pair"),
    side:
      row["position_side"] === "long" || row["position_side"] === "short"
        ? row["position_side"]
        : "flat",
    size: Number(row["position_size"]),
    entryPrice: Number(row["entry_price"]),
  };
  const openedAt = timestampToIso(row["opened_at"]);
  if (openedAt !== undefined) {
    position.openedAt = openedAt;
  }
  return position;
}

function overlayPosition(
  position: PersistedPosition,
  row: Record<string, unknown>,
): PersistedPosition {
  const side = row["side"] === "long" || row["side"] === "short" ? row["side"] : position.side;
  const next: PersistedPosition = {
    pair: position.pair,
    side,
    size: Number(row["size"]),
    entryPrice: Number(row["entry_price"]),
    strategyId: asString(row["strategy_id"], "strategy_id"),
    slPrice: Number(row["sl_price"]),
  };
  const openedAt = timestampToIso(row["opened_at"]);
  if (openedAt !== undefined) {
    next.openedAt = openedAt;
  }
  const paidFee = Number(row["paid_fee"]);
  if (paidFee > 0) {
    next.paidFee = paidFee;
  }
  return next;
}

export async function portfolioCount(botId: string, mode: BotMode): Promise<number> {
  const rows = await query<{ cnt: string | number | bigint }>(
    `
    SELECT count(*)::BIGINT AS cnt
    FROM bot.portfolios
    WHERE bot_id = $1 AND mode = $2
    `,
    [botId, mode],
  );
  return rows[0] ? Number(rows[0].cnt) : 0;
}

export async function loadAllPortfolios(
  botId: string,
  mode: BotMode,
): Promise<Record<string, PersistedLivePortfolio>> {
  const portfolioRows = await query<Record<string, unknown>>(
    `
    SELECT
      pair, cash_usdc, realized_pnl,
      position_side, position_size, entry_price, opened_at, updated_at
    FROM bot.portfolios
    WHERE bot_id = $1 AND mode = $2
    ORDER BY pair
    `,
    [botId, mode],
  );
  if (portfolioRows.length === 0) {
    return {};
  }

  const tradeRows = await query<Record<string, unknown>>(
    `
    SELECT pair, side, price, size, realized_pnl, "at", simulated, tx_signature
    FROM bot.trades
    WHERE bot_id = $1 AND mode = $2
    ORDER BY "at", id
    `,
    [botId, mode],
  );

  const positionRows = await query<Record<string, unknown>>(
    `
    SELECT pair, strategy_id, side, size, entry_price, sl_price, paid_fee, opened_at
    FROM bot.positions
    WHERE bot_id = $1 AND mode = $2
    `,
    [botId, mode],
  );
  const positionByPair = new Map<string, Record<string, unknown>>();
  for (const row of positionRows) {
    positionByPair.set(asString(row["pair"], "pair"), row);
  }

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
    const stored = positionByPair.get(pair);
    portfolios[pair] = {
      cashUsdc: Number(row["cash_usdc"]),
      realizedPnl: Number(row["realized_pnl"]),
      position: stored != null ? overlayPosition(rowToPosition(row), stored) : rowToPosition(row),
      trades: tradesByPair.get(pair) ?? [],
    };
  }
  return portfolios;
}

const UPSERT_PORTFOLIO_SQL = `
  INSERT INTO bot.portfolios (
    bot_id, mode, pair, cash_usdc, realized_pnl,
    position_side, position_size, entry_price, opened_at, updated_at
  )
  VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, now()
  )
  ON CONFLICT (bot_id, mode, pair) DO UPDATE SET
    cash_usdc = EXCLUDED.cash_usdc,
    realized_pnl = EXCLUDED.realized_pnl,
    position_side = EXCLUDED.position_side,
    position_size = EXCLUDED.position_size,
    entry_price = EXCLUDED.entry_price,
    opened_at = EXCLUDED.opened_at,
    updated_at = now()
`;

const UPSERT_POSITION_SQL = `
  INSERT INTO bot.positions (
    bot_id, mode, pair, strategy_id, strategy_data, side, size, entry_price, sl_price, paid_fee, opened_at, updated_at
  )
  VALUES (
    $1, $2, $3, $4, '{}'::jsonb, $5, $6, $7, $8, $9, $10::timestamptz, now()
  )
  ON CONFLICT (bot_id, mode, pair) DO UPDATE SET
    strategy_id = EXCLUDED.strategy_id,
    strategy_data = '{}'::jsonb,
    side = EXCLUDED.side,
    size = EXCLUDED.size,
    entry_price = EXCLUDED.entry_price,
    sl_price = EXCLUDED.sl_price,
    paid_fee = EXCLUDED.paid_fee,
    opened_at = EXCLUDED.opened_at,
    updated_at = now()
`;

const DELETE_POSITION_SQL = `
  DELETE FROM bot.positions
  WHERE bot_id = $1 AND mode = $2 AND pair = $3
`;

const INSERT_TRADE_SQL = `
  INSERT INTO bot.trades (
    bot_id, mode, pair, side, price, size, realized_pnl, "at", simulated, tx_signature
  )
  VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10
  )
`;

function portfolioValues(botId: string, mode: BotMode, portfolio: PersistedLivePortfolio) {
  return [
    botId,
    mode,
    portfolio.position.pair,
    portfolio.cashUsdc,
    portfolio.realizedPnl,
    portfolio.position.side,
    portfolio.position.size,
    portfolio.position.entryPrice,
    portfolio.position.openedAt ?? null,
  ] as const;
}

type RunSql = (text: string, values: SqlValue[]) => Promise<unknown>;

function positionValues(
  botId: string,
  mode: BotMode,
  position: PersistedPosition,
): SqlValue[] | null {
  if (position.side !== "long" && position.side !== "short") {
    return null;
  }
  if (!position.strategyId || position.slPrice == null) {
    return null;
  }
  return [
    botId,
    mode,
    position.pair,
    position.strategyId,
    position.side,
    position.size,
    position.entryPrice,
    position.slPrice,
    position.paidFee ?? 0,
    position.openedAt ?? null,
  ];
}

async function syncPosition(
  run: RunSql,
  botId: string,
  mode: BotMode,
  position: PersistedPosition,
): Promise<void> {
  const values = positionValues(botId, mode, position);
  if (values == null) {
    await run(DELETE_POSITION_SQL, [botId, mode, position.pair]);
    return;
  }
  await run(UPSERT_POSITION_SQL, values);
}

function tradeValues(botId: string, mode: BotMode, trade: PersistedLiveTrade) {
  return [
    botId,
    mode,
    trade.pair,
    trade.side,
    trade.price,
    trade.size,
    trade.realizedPnl ?? null,
    trade.at,
    trade.simulated,
    trade.txSignature ?? null,
  ] as const;
}

export async function upsertPortfolio(
  botId: string,
  mode: BotMode,
  portfolio: PersistedLivePortfolio,
): Promise<void> {
  await query(UPSERT_PORTFOLIO_SQL, [...portfolioValues(botId, mode, portfolio)]);
  await syncPosition((text, values) => query(text, values), botId, mode, portfolio.position);
}

export async function insertTrade(
  botId: string,
  mode: BotMode,
  trade: PersistedLiveTrade,
): Promise<void> {
  await query(INSERT_TRADE_SQL, [...tradeValues(botId, mode, trade)]);
}

async function writePortfolio(
  client: PoolClient,
  botId: string,
  mode: BotMode,
  portfolio: PersistedLivePortfolio,
): Promise<void> {
  const pair = portfolio.position.pair;
  await queryWith(client, UPSERT_PORTFOLIO_SQL, [...portfolioValues(botId, mode, portfolio)]);
  await syncPosition(
    (text, values) => queryWith(client, text, values),
    botId,
    mode,
    portfolio.position,
  );
  await queryWith(client, `DELETE FROM bot.trades WHERE bot_id = $1 AND mode = $2 AND pair = $3`, [
    botId,
    mode,
    pair,
  ]);
  for (const trade of portfolio.trades) {
    await queryWith(client, INSERT_TRADE_SQL, [...tradeValues(botId, mode, trade)]);
  }
}

export async function syncPortfolio(
  botId: string,
  mode: BotMode,
  portfolio: PersistedLivePortfolio,
): Promise<void> {
  await withTransaction(async (client) => {
    await writePortfolio(client, botId, mode, portfolio);
  });
}

export async function replaceBotLedgers(
  botId: string,
  mode: BotMode,
  portfolios: PersistedLivePortfolio[],
): Promise<void> {
  await withTransaction(async (client) => {
    await queryWith(client, `DELETE FROM bot.trades WHERE bot_id = $1 AND mode = $2`, [
      botId,
      mode,
    ]);
    await queryWith(client, `DELETE FROM bot.positions WHERE bot_id = $1 AND mode = $2`, [
      botId,
      mode,
    ]);
    await queryWith(client, `DELETE FROM bot.portfolios WHERE bot_id = $1 AND mode = $2`, [
      botId,
      mode,
    ]);
    for (const portfolio of portfolios) {
      await writePortfolio(client, botId, mode, portfolio);
    }
  });
}

/** Paper helpers bound to env BOT_ID. */
export async function paperPortfolioCount(): Promise<number> {
  return portfolioCount(getBotId(), "paper");
}

export async function loadAllPaperPortfolios(): Promise<Record<string, PersistedPortfolio>> {
  const all = await loadAllPortfolios(getBotId(), "paper");
  const out: Record<string, PersistedPortfolio> = {};
  for (const [pair, p] of Object.entries(all)) {
    out[pair] = {
      cashUsdc: p.cashUsdc,
      realizedPnl: p.realizedPnl,
      position: p.position,
      trades: p.trades.map((t) => ({
        pair: t.pair,
        side: t.side,
        price: t.price,
        size: t.size,
        at: t.at,
        simulated: true as const,
        ...(t.realizedPnl !== undefined ? { realizedPnl: t.realizedPnl } : {}),
      })),
    };
  }
  return out;
}

export async function upsertPaperPortfolio(portfolio: PersistedPortfolio): Promise<void> {
  await upsertPortfolio(getBotId(), "paper", toLiveShape(portfolio));
}

export async function insertPaperTrade(trade: PersistedTrade): Promise<void> {
  await insertTrade(getBotId(), "paper", { ...trade, simulated: true });
}

export async function syncPaperPortfolio(portfolio: PersistedPortfolio): Promise<void> {
  await syncPortfolio(getBotId(), "paper", toLiveShape(portfolio));
}

function toLiveShape(portfolio: PersistedPortfolio): PersistedLivePortfolio {
  return {
    cashUsdc: portfolio.cashUsdc,
    realizedPnl: portfolio.realizedPnl,
    position: portfolio.position,
    trades: portfolio.trades.map((t) => ({
      pair: t.pair,
      side: t.side,
      price: t.price,
      size: t.size,
      at: t.at,
      simulated: true,
      ...(t.realizedPnl !== undefined ? { realizedPnl: t.realizedPnl } : {}),
    })),
  };
}
