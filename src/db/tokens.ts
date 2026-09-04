import { query } from "./db.js";

/** One row from `solana.tokens`. */
export interface SolanaToken {
  symbol: string;
  mint: string;
  decimals: number;
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
  return {
    symbol: asString(row["symbol"], "symbol"),
    mint: asString(row["mint"], "mint"),
    decimals: Number(row["decimals"]),
  };
}

/** Load one token by symbol (e.g. SOL, USDC). */
export async function getToken(symbol: string): Promise<SolanaToken | null> {
  const rows = await query<Record<string, unknown>>(
    `
    SELECT symbol, mint, decimals
    FROM solana.tokens
    WHERE symbol = $1
    `,
    [symbol.trim().toUpperCase()],
  );
  const row = rows[0];
  return row ? rowToToken(row) : null;
}

/** Load all known Solana tokens. */
export async function listTokens(): Promise<SolanaToken[]> {
  const rows = await query<Record<string, unknown>>(
    `
    SELECT symbol, mint, decimals
    FROM solana.tokens
    ORDER BY symbol
    `,
  );
  return rows.map(rowToToken);
}

/** Upsert a token (import / tests). */
export async function upsertToken(token: SolanaToken): Promise<void> {
  await query(
    `
    INSERT INTO solana.tokens (mint, symbol, decimals)
    VALUES ($1, $2, $3)
    ON CONFLICT (mint) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      decimals = EXCLUDED.decimals
    `,
    [token.mint, token.symbol, token.decimals],
  );
}
