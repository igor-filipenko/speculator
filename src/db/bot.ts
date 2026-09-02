import type { PersistedLivePortfolio, PersistedLiveTrade } from "../live/store.js";
import type { PersistedPortfolio, PersistedTrade } from "../paper/store.js";
import { getBotId, getSql } from "./db.js";

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

export async function portfolioCount(botId: string, mode: BotMode): Promise<number> {
  const sql = getSql();
  const rows = await sql<{ cnt: string | number | bigint }[]>`
    SELECT count(*)::BIGINT AS cnt
    FROM bot.portfolios
    WHERE bot_id = ${botId} AND mode = ${mode}
  `;
  return rows[0] ? Number(rows[0].cnt) : 0;
}

export async function loadAllPortfolios(
  botId: string,
  mode: BotMode,
): Promise<Record<string, PersistedLivePortfolio>> {
  const sql = getSql();
  const portfolioRows = await sql<Record<string, unknown>[]>`
    SELECT
      pair, cash_usdc, realized_pnl,
      position_side, position_size, entry_price, opened_at, updated_at
    FROM bot.portfolios
    WHERE bot_id = ${botId} AND mode = ${mode}
    ORDER BY pair
  `;
  if (portfolioRows.length === 0) {
    return {};
  }

  const tradeRows = await sql<Record<string, unknown>[]>`
    SELECT pair, side, price, size, realized_pnl, "at", simulated, tx_signature
    FROM bot.trades
    WHERE bot_id = ${botId} AND mode = ${mode}
    ORDER BY "at", id
  `;

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

export async function upsertPortfolio(
  botId: string,
  mode: BotMode,
  portfolio: PersistedLivePortfolio,
): Promise<void> {
  const sql = getSql();
  const openedAt = portfolio.position.openedAt ?? null;
  await sql`
    INSERT INTO bot.portfolios (
      bot_id, mode, pair, cash_usdc, realized_pnl,
      position_side, position_size, entry_price, opened_at, updated_at
    )
    VALUES (
      ${botId}, ${mode}, ${portfolio.position.pair},
      ${portfolio.cashUsdc}, ${portfolio.realizedPnl},
      ${portfolio.position.side}, ${portfolio.position.size},
      ${portfolio.position.entryPrice}, ${openedAt}::timestamptz, now()
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
}

export async function insertTrade(
  botId: string,
  mode: BotMode,
  trade: PersistedLiveTrade,
): Promise<void> {
  const sql = getSql();
  const realizedPnl = trade.realizedPnl ?? null;
  const txSignature = trade.txSignature ?? null;
  await sql`
    INSERT INTO bot.trades (
      bot_id, mode, pair, side, price, size, realized_pnl, "at", simulated, tx_signature
    )
    VALUES (
      ${botId}, ${mode}, ${trade.pair}, ${trade.side}, ${trade.price}, ${trade.size},
      ${realizedPnl}, ${trade.at}::timestamptz, ${trade.simulated}, ${txSignature}
    )
  `;
}

export async function syncPortfolio(
  botId: string,
  mode: BotMode,
  portfolio: PersistedLivePortfolio,
): Promise<void> {
  const sql = getSql();
  const pair = portfolio.position.pair;
  await sql.begin(async (tx) => {
    const openedAt = portfolio.position.openedAt ?? null;
    await tx`
      INSERT INTO bot.portfolios (
        bot_id, mode, pair, cash_usdc, realized_pnl,
        position_side, position_size, entry_price, opened_at, updated_at
      )
      VALUES (
        ${botId}, ${mode}, ${pair},
        ${portfolio.cashUsdc}, ${portfolio.realizedPnl},
        ${portfolio.position.side}, ${portfolio.position.size},
        ${portfolio.position.entryPrice}, ${openedAt}::timestamptz, now()
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
    await tx`
      DELETE FROM bot.trades
      WHERE bot_id = ${botId} AND mode = ${mode} AND pair = ${pair}
    `;
    for (const trade of portfolio.trades) {
      const realizedPnl = trade.realizedPnl ?? null;
      const txSignature = trade.txSignature ?? null;
      await tx`
        INSERT INTO bot.trades (
          bot_id, mode, pair, side, price, size, realized_pnl, "at", simulated, tx_signature
        )
        VALUES (
          ${botId}, ${mode}, ${trade.pair}, ${trade.side}, ${trade.price}, ${trade.size},
          ${realizedPnl}, ${trade.at}::timestamptz, ${trade.simulated}, ${txSignature}
        )
      `;
    }
  });
}

export async function replaceBotLedgers(
  botId: string,
  mode: BotMode,
  portfolios: PersistedLivePortfolio[],
): Promise<void> {
  const sql = getSql();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM bot.trades WHERE bot_id = ${botId} AND mode = ${mode}`;
    await tx`DELETE FROM bot.portfolios WHERE bot_id = ${botId} AND mode = ${mode}`;
  });
  for (const portfolio of portfolios) {
    await syncPortfolio(botId, mode, portfolio);
  }
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
