import { getSpeculatorDb } from "./speculator-db.js";

/** One row from `solana.tokens`. */
export interface SolanaToken {
  symbol: string;
  mint: string;
  /** GeckoTerminal pool address (set on base tokens used for OHLCV). */
  pool?: string;
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

function rowToToken(row: Record<string, unknown>): SolanaToken {
  const token: SolanaToken = {
    symbol: asString(row["symbol"], "symbol"),
    mint: asString(row["mint"], "mint"),
  };
  if (row["pool"] != null && row["pool"] !== "") {
    token.pool = asString(row["pool"], "pool");
  }
  return token;
}

/** Load one token by symbol (e.g. SOL, USDC). */
export async function getToken(symbol: string, dataDir?: string): Promise<SolanaToken | null> {
  const conn = await getSpeculatorDb(dataDir);
  const reader = await conn.runAndReadAll(
    `
    SELECT symbol, mint, pool
    FROM solana.tokens
    WHERE symbol = $symbol
    `,
    { symbol: symbol.trim().toUpperCase() },
  );
  await reader.readAll();
  const row = reader.getRowObjectsJS()[0];
  return row ? rowToToken(row) : null;
}

/** Load all known Solana tokens. */
export async function listTokens(dataDir?: string): Promise<SolanaToken[]> {
  const conn = await getSpeculatorDb(dataDir);
  const reader = await conn.runAndReadAll(`
    SELECT symbol, mint, pool
    FROM solana.tokens
    ORDER BY symbol
  `);
  await reader.readAll();
  return reader.getRowObjectsJS().map(rowToToken);
}
