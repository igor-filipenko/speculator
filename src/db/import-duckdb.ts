import { access } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { replaceBotLedgers, type BotMode } from "./bot.js";
import { upsertCandles } from "./candles.js";
import { getBotId, getSql } from "./db.js";
import { upsertPool } from "./pools.js";
import { deleteSignalsForBot } from "./signals.js";
import { upsertToken } from "./tokens.js";
import type { Candle, Timeframe } from "../types.js";
import type { PersistedLivePortfolio, PersistedLiveTrade } from "../live/store.js";

const DEFAULT_DUCKDB = join(process.cwd(), "data", "speculator.duckdb");
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TIMEFRAMES = new Set<string>(["15m", "4h", "1d"]);

interface DuckToken {
  symbol: string;
  mint: string;
  decimals: number;
  poolAddress?: string;
}

interface DuckCandleRow {
  symbol: string;
  timeframe: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

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

async function readRows(
  conn: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  sql: string,
): Promise<Record<string, unknown>[]> {
  try {
    const reader = await conn.runAndReadAll(sql);
    await reader.readAll();
    return reader.getRowObjectsJS();
  } catch {
    return [];
  }
}

function rowToTrade(row: Record<string, unknown>, simulatedDefault: boolean): PersistedLiveTrade {
  const at = timestampToIso(row["at"]);
  if (at === undefined) {
    throw new Error("trade row missing at");
  }
  const trade: PersistedLiveTrade = {
    pair: asString(row["pair"], "pair"),
    side: row["side"] === "SELL" ? "SELL" : "BUY",
    price: Number(row["price"]),
    size: Number(row["size"]),
    at,
    simulated: row["simulated"] == null ? simulatedDefault : row["simulated"] === true,
  };
  if (row["realized_pnl"] != null) {
    trade.realizedPnl = Number(row["realized_pnl"]);
  }
  if (typeof row["tx_signature"] === "string" && row["tx_signature"].length > 0) {
    trade.txSignature = row["tx_signature"];
  }
  return trade;
}

function portfoliosFromRows(
  portfolioRows: Record<string, unknown>[],
  tradeRows: Record<string, unknown>[],
  simulatedDefault: boolean,
): PersistedLivePortfolio[] {
  const tradesByPair = new Map<string, PersistedLiveTrade[]>();
  for (const row of tradeRows) {
    const trade = rowToTrade(row, simulatedDefault);
    const list = tradesByPair.get(trade.pair) ?? [];
    list.push(trade);
    tradesByPair.set(trade.pair, list);
  }

  return portfolioRows.map((row) => {
    const pair = asString(row["pair"], "pair");
    const position: PersistedLivePortfolio["position"] = {
      pair,
      side: row["position_side"] === "long" ? "long" : "flat",
      size: Number(row["position_size"]),
      entryPrice: Number(row["entry_price"]),
    };
    const openedAt = timestampToIso(row["opened_at"]);
    if (openedAt !== undefined) {
      position.openedAt = openedAt;
    }
    return {
      cashUsdc: Number(row["cash_usdc"]),
      realizedPnl: Number(row["realized_pnl"]),
      position,
      trades: tradesByPair.get(pair) ?? [],
    };
  });
}

export async function importDuckdb(path = DEFAULT_DUCKDB): Promise<void> {
  await access(path);
  const botId = getBotId();
  console.log(`Importing DuckDB ${path} → Timescale (bot_id=${botId})`);

  const instance = await DuckDBInstance.fromCache(path);
  const conn = await instance.connect();

  const tokenRows = await readRows(
    conn,
    `SELECT symbol, mint, decimals, pool_address FROM solana.tokens`,
  );
  const tokens: DuckToken[] = tokenRows.map((row) => {
    const token: DuckToken = {
      symbol: asString(row["symbol"], "symbol"),
      mint: asString(row["mint"], "mint"),
      decimals: Number(row["decimals"]),
    };
    if (row["pool_address"] != null && row["pool_address"] !== "") {
      token.poolAddress = asString(row["pool_address"], "pool_address");
    }
    return token;
  });

  const candleRows = await readRows(
    conn,
    `SELECT symbol, timeframe, time, open, high, low, close, volume FROM candles`,
  );
  const candles: DuckCandleRow[] = candleRows.map((row) => ({
    symbol: asString(row["symbol"], "symbol"),
    timeframe: asString(row["timeframe"], "timeframe"),
    time: Number(row["time"]),
    open: Number(row["open"]),
    high: Number(row["high"]),
    low: Number(row["low"]),
    close: Number(row["close"]),
    volume: Number(row["volume"]),
  }));

  const quoteByBase = new Map<string, string>();
  for (const c of candles) {
    const parts = c.symbol.split("/");
    if (parts.length === 2 && parts[0] && parts[1] && !quoteByBase.has(parts[0])) {
      quoteByBase.set(parts[0], parts[1]);
    }
  }

  for (const token of tokens) {
    await upsertToken({ mint: token.mint, symbol: token.symbol, decimals: token.decimals });
  }

  const bySymbol = new Map(tokens.map((t) => [t.symbol, t]));
  let pools = 0;
  for (const token of tokens) {
    if (!token.poolAddress) {
      continue;
    }
    const quoteSymbol = quoteByBase.get(token.symbol) ?? "USDC";
    const quote = bySymbol.get(quoteSymbol);
    const quoteMint = quote?.mint ?? USDC_MINT;
    await upsertPool({
      address: token.poolAddress,
      baseMint: token.mint,
      quoteMint,
    });
    pools += 1;
  }

  const poolBySymbol = new Map<string, string>();
  for (const token of tokens) {
    if (token.poolAddress) {
      poolBySymbol.set(token.symbol, token.poolAddress);
    }
  }

  const byPoolTf = new Map<string, Candle[]>();
  let skippedCandles = 0;
  for (const row of candles) {
    const base = row.symbol.split("/")[0];
    const pool = base !== undefined ? poolBySymbol.get(base) : undefined;
    if (!pool || !TIMEFRAMES.has(row.timeframe)) {
      skippedCandles += 1;
      continue;
    }
    const tf = row.timeframe as Timeframe;
    const key = `${pool}\0${tf}`;
    const list = byPoolTf.get(key) ?? [];
    list.push({
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    });
    byPoolTf.set(key, list);
  }

  let candleCount = 0;
  for (const [key, list] of byPoolTf) {
    const [pool, tf] = key.split("\0");
    if (!pool || !tf) {
      continue;
    }
    await upsertCandles(pool, tf as Timeframe, list);
    candleCount += list.length;
  }

  await deleteSignalsForBot(botId);
  const signalRows = await readRows(
    conn,
    `SELECT "at", pair, side, price, reason, ema_fast, ema_slow, rsi, trend_ema, atr, adx FROM signals`,
  );
  const sql = getSql();
  for (const row of signalRows) {
    const at = timestampToIso(row["at"]);
    if (at === undefined) {
      continue;
    }
    await sql`
      INSERT INTO market.signals (
        bot_id, "at", pair, side, price, reason, ema_fast, ema_slow, rsi, trend_ema, atr, adx
      )
      VALUES (
        ${botId}, ${at}::timestamptz, ${asString(row["pair"], "pair")},
        ${asString(row["side"], "side")}, ${Number(row["price"])}, ${asString(row["reason"], "reason")},
        ${row["ema_fast"] != null ? Number(row["ema_fast"]) : null},
        ${row["ema_slow"] != null ? Number(row["ema_slow"]) : null},
        ${row["rsi"] != null ? Number(row["rsi"]) : null},
        ${row["trend_ema"] != null ? Number(row["trend_ema"]) : null},
        ${row["atr"] != null ? Number(row["atr"]) : null},
        ${row["adx"] != null ? Number(row["adx"]) : null}
      )
    `;
  }

  const paperPortfolios = portfoliosFromRows(
    await readRows(
      conn,
      `SELECT pair, cash_usdc, realized_pnl, position_side, position_size, entry_price, opened_at FROM paper.portfolios`,
    ),
    await readRows(
      conn,
      `SELECT pair, side, price, size, realized_pnl, "at", simulated FROM paper.trades`,
    ),
    true,
  );
  await replaceBotLedgers(botId, "paper" satisfies BotMode, paperPortfolios);

  const livePortfolios = portfoliosFromRows(
    await readRows(
      conn,
      `SELECT pair, cash_usdc, realized_pnl, position_side, position_size, entry_price, opened_at FROM live.portfolios`,
    ),
    await readRows(
      conn,
      `SELECT pair, side, price, size, realized_pnl, "at", simulated, tx_signature FROM live.trades`,
    ),
    false,
  );
  await replaceBotLedgers(botId, "live", livePortfolios);

  console.log(
    `Imported tokens=${tokens.length} pools=${pools} candles=${candleCount}` +
      (skippedCandles > 0 ? ` (skipped ${skippedCandles})` : "") +
      ` signals=${signalRows.length} paper.portfolios=${paperPortfolios.length}` +
      ` live.portfolios=${livePortfolios.length}`,
  );
}

export function defaultDuckdbPath(): string {
  return DEFAULT_DUCKDB;
}
