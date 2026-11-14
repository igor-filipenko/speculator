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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

type RunSql = (text: string, values: SqlValue[]) => Promise<Record<string, unknown>[]>;

/**
 * Instance for a registry id and pair. The trading loop still names code ids
 * such as `bollinger`; the database stores `strategy.instances.id`.
 */
export async function instanceIdForPair(
  run: RunSql,
  pair: string,
  strategyId: string,
): Promise<string> {
  const id = strategyId.trim();
  if (isUuid(id)) {
    return id;
  }
  const existing = await run(
    `
    SELECT id::text AS id
    FROM strategy.instances
    WHERE registry_id = $1 AND pair = $2
    ORDER BY id
    LIMIT 1
    `,
    [id, pair],
  );
  const found = existing[0]?.["id"];
  if (typeof found === "string") {
    return found;
  }
  const inserted = await run(
    `
    INSERT INTO strategy.instances (
      registry_id, pair, candle_source, exchange_id, risk_percent, params
    )
    VALUES ($1, $2, 'gecko-terminal', 'jupiter', 2, '{}'::jsonb)
    RETURNING id::text AS id
    `,
    [id, pair],
  );
  const created = inserted[0]?.["id"];
  if (typeof created !== "string") {
    throw new Error(`failed to create strategy instance for ${id} ${pair}`);
  }
  return created;
}

async function instanceIdForBook(
  run: RunSql,
  botId: string,
  mode: BotMode,
  pair: string,
  strategyId: string | undefined,
): Promise<string | null> {
  const registryId = strategyId?.trim() ?? "";
  if (registryId !== "") {
    return instanceIdForPair(run, pair, registryId);
  }
  const linked = await run(
    `
    SELECT a.strategy_id::text AS id
    FROM bot.virtual_accounts a
    JOIN strategy.instances i ON i.id = a.strategy_id
    WHERE a.bot_id = $1 AND a.mode = $2 AND i.pair = $3
    ORDER BY a.strategy_id
    LIMIT 1
    `,
    [botId, mode, pair],
  );
  const id = linked[0]?.["id"];
  return typeof id === "string" ? id : null;
}

export async function portfolioCount(botId: string, mode: BotMode): Promise<number> {
  const rows = await query<{ cnt: string | number | bigint }>(
    `
    SELECT count(*)::BIGINT AS cnt
    FROM (
      SELECT a.strategy_id
      FROM bot.virtual_accounts a
      WHERE a.bot_id = $1 AND a.mode = $2
      UNION
      SELECT p.strategy_id
      FROM bot.positions p
      WHERE p.bot_id = $1 AND p.mode = $2
    ) books
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
    SELECT a.strategy_id::text AS instance_id, i.registry_id, i.pair, a.cash_usdc, a.realized_pnl
    FROM bot.virtual_accounts a
    JOIN strategy.instances i ON i.id = a.strategy_id
    WHERE a.bot_id = $1 AND a.mode = $2
    ORDER BY a.strategy_id
    `,
    [botId, mode],
  );

  const tradeRows = await query<Record<string, unknown>>(
    `
    SELECT pair, side, price, size, realized_pnl, "at", simulated, tx_signature, strategy_id::text
    FROM bot.trades
    WHERE bot_id = $1 AND mode = $2
    ORDER BY "at", id
    `,
    [botId, mode],
  );

  const positionRows = await query<Record<string, unknown>>(
    `
    SELECT
      p.strategy_id::text AS instance_id,
      i.registry_id,
      i.pair,
      i.registry_id AS strategy_id,
      p.side, p.size, p.entry_price, p.sl_price, p.paid_fee, p.opened_at
    FROM bot.positions p
    JOIN strategy.instances i ON i.id = p.strategy_id
    WHERE p.bot_id = $1 AND p.mode = $2
    `,
    [botId, mode],
  );

  const portfolios: Record<string, PersistedLivePortfolio> = {};
  for (const row of portfolioRows) {
    const instanceId = asString(row["instance_id"], "instance_id");
    const pair = asString(row["pair"], "pair");
    portfolios[instanceId] = {
      instanceId,
      registryId: asString(row["registry_id"], "registry_id"),
      cashUsdc: Number(row["cash_usdc"]),
      realizedPnl: Number(row["realized_pnl"]),
      position: flatPosition(pair),
      trades: [],
    };
  }
  for (const row of positionRows) {
    const instanceId = asString(row["instance_id"], "instance_id");
    const pair = asString(row["pair"], "pair");
    const book = portfolios[instanceId] ?? {
      instanceId,
      registryId: asString(row["registry_id"], "registry_id"),
      cashUsdc: 0,
      realizedPnl: 0,
      position: flatPosition(pair),
      trades: [],
    };
    book.position = overlayPosition(book.position, row);
    portfolios[instanceId] = book;
  }

  const booksOnPair = new Map<string, PersistedLivePortfolio[]>();
  for (const book of Object.values(portfolios)) {
    const list = booksOnPair.get(book.position.pair) ?? [];
    list.push(book);
    booksOnPair.set(book.position.pair, list);
  }
  for (const row of tradeRows) {
    const trade = rowToTrade(row);
    const owner = row["strategy_id"];
    if (typeof owner === "string" && portfolios[owner]) {
      portfolios[owner].trades.push(trade);
      continue;
    }
    if (owner != null) {
      continue;
    }
    const books = booksOnPair.get(trade.pair) ?? [];
    if (books.length === 1) {
      books[0]?.trades.push(trade);
    }
  }
  return portfolios;
}

/**
 * The one saved book for this registry id on this pair.
 * Two books for the same registry and pair are left for the multi-instance loop.
 */
export function portfolioForRegistry<T extends { position: { pair: string }; registryId?: string }>(
  portfolios: Record<string, T>,
  pair: string,
  registryId: string,
): T | undefined {
  const matches = Object.values(portfolios).filter(
    (book) => book.position.pair === pair && book.registryId === registryId,
  );
  if (matches.length > 1) {
    throw new Error(
      `${pair} has ${matches.length} ${registryId} books; this process still runs one strategy`,
    );
  }
  return matches[0];
}

/** Risk percent of the instance this process trades. Two matches prefer the selection. */
export async function riskPercentFor(pair: string, registryId: string): Promise<number> {
  const rows = await query<{ risk_percent: string | number }>(
    `
    SELECT i.risk_percent
    FROM strategy.instances i
    LEFT JOIN bot.strategies b ON b.strategy_id = i.id AND b.bot_id = $1
    LEFT JOIN bot.selection s ON s.bot_id = $1 AND s.strategy_id = i.id
    WHERE i.registry_id = $2 AND i.pair = $3
    ORDER BY (b.strategy_id IS NOT NULL) DESC, (s.strategy_id IS NOT NULL) DESC, i.id
    LIMIT 1
    `,
    [getBotId(), registryId, pair],
  );
  const value = rows[0]?.risk_percent;
  return value == null ? 2 : Number(value);
}

/**
 * Deposit of the single instance assigned to this bot for the registry id and pair.
 * Null when none is assigned, or when more than one is.
 */
export async function assignedDepositUsdc(
  pair: string,
  registryId: string,
): Promise<number | null> {
  const rows = await query<{ deposit_usdc: string | number }>(
    `
    SELECT b.deposit_usdc
    FROM bot.strategies b
    JOIN strategy.instances i ON i.id = b.strategy_id
    WHERE b.bot_id = $1 AND i.registry_id = $2 AND i.pair = $3
    `,
    [getBotId(), registryId, pair],
  );
  if (rows.length !== 1) {
    return null;
  }
  const value = rows[0]?.deposit_usdc;
  return value == null ? null : Number(value);
}

function flatPosition(pair: string): PersistedLivePortfolio["position"] {
  return { pair, side: "flat", size: 0, entryPrice: 0 };
}

const UPSERT_ACCOUNT_SQL = `
  INSERT INTO bot.virtual_accounts (bot_id, mode, strategy_id, cash_usdc, realized_pnl, updated_at)
  VALUES ($1, $2, $3::uuid, $4, $5, now())
  ON CONFLICT (bot_id, mode, strategy_id) DO UPDATE SET
    cash_usdc = EXCLUDED.cash_usdc,
    realized_pnl = EXCLUDED.realized_pnl,
    updated_at = now()
`;

const UPSERT_EXCHANGE_SQL = `
  INSERT INTO exchange.positions (bot_id, mode, integration_id, pair, side, size)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (bot_id, mode, pair) DO UPDATE SET
    integration_id = EXCLUDED.integration_id,
    side = EXCLUDED.side,
    size = EXCLUDED.size
  RETURNING id::text AS id
`;

const UPSERT_POSITION_SQL = `
  INSERT INTO bot.positions (
    bot_id, mode, pair, strategy_id, exchange_position_id,
    side, size, entry_price, sl_price, paid_fee, opened_at, updated_at
  )
  VALUES (
    $1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11::timestamptz, now()
  )
  ON CONFLICT (bot_id, mode, strategy_id) DO UPDATE SET
    pair = EXCLUDED.pair,
    exchange_position_id = EXCLUDED.exchange_position_id,
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
  WHERE bot_id = $1 AND mode = $2 AND strategy_id = $3::uuid
`;

const DELETE_UNUSED_EXCHANGE_SQL = `
  DELETE FROM exchange.positions AS e
  WHERE e.bot_id = $1 AND e.mode = $2 AND e.pair = $3
    AND NOT EXISTS (
      SELECT 1 FROM bot.positions AS p WHERE p.exchange_position_id = e.id
    )
`;

const INSERT_TRADE_SQL = `
  INSERT INTO bot.trades (
    bot_id, mode, pair, side, price, size, realized_pnl, "at", simulated, tx_signature, strategy_id
  )
  VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11::uuid
  )
`;

function openPositionValues(position: PersistedPosition): {
  side: "long" | "short";
  size: number;
  entryPrice: number;
  slPrice: number;
  paidFee: number;
  openedAt: string | null;
  strategyId: string;
} | null {
  if (position.side !== "long" && position.side !== "short") {
    return null;
  }
  const strategyId = position.strategyId?.trim() ?? "";
  if (strategyId === "" || position.slPrice == null || !(position.slPrice > 0)) {
    return null;
  }
  return {
    side: position.side,
    size: position.size,
    entryPrice: position.entryPrice,
    slPrice: position.slPrice,
    paidFee: position.paidFee ?? 0,
    openedAt: position.openedAt ?? null,
    strategyId,
  };
}

async function syncPosition(
  run: RunSql,
  botId: string,
  mode: BotMode,
  position: PersistedPosition,
  instanceId: string,
): Promise<void> {
  const open = openPositionValues(position);
  if (open == null) {
    await run(DELETE_POSITION_SQL, [botId, mode, instanceId]);
    await run(DELETE_UNUSED_EXCHANGE_SQL, [botId, mode, position.pair]);
    return;
  }
  const integrationId = mode === "paper" ? "emulated" : "jupiter";
  const exchangeId = await exchangePositionId(
    run,
    botId,
    mode,
    position,
    instanceId,
    integrationId,
    open,
  );
  await run(UPSERT_POSITION_SQL, [
    botId,
    mode,
    position.pair,
    instanceId,
    exchangeId,
    open.side,
    open.size,
    open.entryPrice,
    open.slPrice,
    open.paidFee,
    open.openedAt,
  ]);
}

function tradeValues(
  botId: string,
  mode: BotMode,
  trade: PersistedLiveTrade,
  instanceId: string | null,
) {
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
    instanceId,
  ] as const;
}

/**
 * Venue row this book links to. A second book on the pair links to the existing
 * row and leaves its size alone; netting that size is a later phase.
 */
async function exchangePositionId(
  run: RunSql,
  botId: string,
  mode: BotMode,
  position: PersistedPosition,
  instanceId: string,
  integrationId: string,
  open: { side: "long" | "short"; size: number },
): Promise<string> {
  const existing = await run(
    `
    SELECT id::text AS id
    FROM exchange.positions
    WHERE bot_id = $1 AND mode = $2 AND pair = $3
    `,
    [botId, mode, position.pair],
  );
  const others = await run(
    `
    SELECT 1
    FROM bot.positions
    WHERE bot_id = $1 AND mode = $2 AND pair = $3 AND strategy_id <> $4::uuid
    LIMIT 1
    `,
    [botId, mode, position.pair, instanceId],
  );
  const existingId = existing[0]?.["id"];
  if (others.length > 0 && typeof existingId === "string") {
    return existingId;
  }
  const exchangeRows = await run(UPSERT_EXCHANGE_SQL, [
    botId,
    mode,
    integrationId,
    position.pair,
    open.side,
    open.size,
  ]);
  const exchangeId = exchangeRows[0]?.["id"];
  if (typeof exchangeId !== "string") {
    throw new Error(`failed to store the exchange position for ${position.pair}`);
  }
  return exchangeId;
}

export async function upsertPortfolio(
  botId: string,
  mode: BotMode,
  portfolio: PersistedLivePortfolio,
): Promise<string | null> {
  return withTransaction(async (client) => writeBook(client, botId, mode, portfolio, false));
}

export async function insertTrade(
  botId: string,
  mode: BotMode,
  trade: PersistedLiveTrade,
  instanceId: string | null,
): Promise<void> {
  await query(INSERT_TRADE_SQL, [...tradeValues(botId, mode, trade, instanceId)]);
}

async function writeBook(
  client: PoolClient,
  botId: string,
  mode: BotMode,
  portfolio: PersistedLivePortfolio,
  replaceTrades: boolean,
): Promise<string | null> {
  const run: RunSql = (text, values) => queryWith(client, text, values);
  const pair = portfolio.position.pair;
  const named = portfolio.instanceId?.trim() ?? "";
  const instanceId = isUuid(named)
    ? named
    : await instanceIdForBook(
        run,
        botId,
        mode,
        pair,
        portfolio.registryId ?? portfolio.position.strategyId,
      );
  // Chain overlays can arrive before any strategy instance exists. Cash for those
  // books has nowhere to live until an instance is assigned.
  if (instanceId == null) {
    return null;
  }
  await run(UPSERT_ACCOUNT_SQL, [
    botId,
    mode,
    instanceId,
    portfolio.cashUsdc,
    portfolio.realizedPnl,
  ]);
  await syncPosition(run, botId, mode, portfolio.position, instanceId);
  if (!replaceTrades) {
    return instanceId;
  }
  await queryWith(
    client,
    `DELETE FROM bot.trades WHERE bot_id = $1 AND mode = $2 AND strategy_id = $3::uuid`,
    [botId, mode, instanceId],
  );
  for (const trade of portfolio.trades) {
    await queryWith(client, INSERT_TRADE_SQL, [...tradeValues(botId, mode, trade, instanceId)]);
  }
  return instanceId;
}

export async function syncPortfolio(
  botId: string,
  mode: BotMode,
  portfolio: PersistedLivePortfolio,
): Promise<string | null> {
  return withTransaction(async (client) => writeBook(client, botId, mode, portfolio, true));
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
    await queryWith(client, `DELETE FROM exchange.positions WHERE bot_id = $1 AND mode = $2`, [
      botId,
      mode,
    ]);
    await queryWith(client, `DELETE FROM bot.virtual_accounts WHERE bot_id = $1 AND mode = $2`, [
      botId,
      mode,
    ]);
    for (const portfolio of portfolios) {
      await writeBook(client, botId, mode, portfolio, true);
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
  for (const [id, p] of Object.entries(all)) {
    out[id] = {
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
      ...(p.instanceId !== undefined ? { instanceId: p.instanceId } : {}),
      ...(p.registryId !== undefined ? { registryId: p.registryId } : {}),
    };
  }
  return out;
}

export async function upsertPaperPortfolio(portfolio: PersistedPortfolio): Promise<string | null> {
  return upsertPortfolio(getBotId(), "paper", toLiveShape(portfolio));
}

export async function insertPaperTrade(
  trade: PersistedTrade,
  instanceId: string | null,
): Promise<void> {
  await insertTrade(getBotId(), "paper", { ...trade, simulated: true }, instanceId);
}

export async function syncPaperPortfolio(portfolio: PersistedPortfolio): Promise<string | null> {
  return syncPortfolio(getBotId(), "paper", toLiveShape(portfolio));
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
    ...(portfolio.instanceId !== undefined ? { instanceId: portfolio.instanceId } : {}),
    ...(portfolio.registryId !== undefined ? { registryId: portfolio.registryId } : {}),
  };
}
