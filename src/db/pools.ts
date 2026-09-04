import { query } from "./db.js";

/** One row from `solana.pools`. */
export interface SolanaPool {
  address: string;
  baseMint: string;
  quoteMint: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
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

function rowToPool(row: Record<string, unknown>): SolanaPool {
  return {
    address: asString(row["address"], "address"),
    baseMint: asString(row["base_mint"], "base_mint"),
    quoteMint: asString(row["quote_mint"], "quote_mint"),
    baseSymbol: asString(row["base_symbol"], "base_symbol"),
    quoteSymbol: asString(row["quote_symbol"], "quote_symbol"),
    baseDecimals: Number(row["base_decimals"]),
    quoteDecimals: Number(row["quote_decimals"]),
  };
}

/** Load the unique pool for BASE/QUOTE symbols. */
export async function getPool(baseSymbol: string, quoteSymbol: string): Promise<SolanaPool | null> {
  const rows = await query<Record<string, unknown>>(
    `
    SELECT
      p.address,
      p.base_mint,
      p.quote_mint,
      b.symbol AS base_symbol,
      q.symbol AS quote_symbol,
      b.decimals AS base_decimals,
      q.decimals AS quote_decimals
    FROM solana.pools p
    JOIN solana.tokens b ON b.mint = p.base_mint
    JOIN solana.tokens q ON q.mint = p.quote_mint
    WHERE b.symbol = $1
      AND q.symbol = $2
    `,
    [baseSymbol.trim().toUpperCase(), quoteSymbol.trim().toUpperCase()],
  );
  const row = rows[0];
  return row ? rowToPool(row) : null;
}

/** Upsert a pool (import / tests). */
export async function upsertPool(pool: {
  address: string;
  baseMint: string;
  quoteMint: string;
}): Promise<void> {
  await query(
    `
    INSERT INTO solana.pools (address, base_mint, quote_mint)
    VALUES ($1, $2, $3)
    ON CONFLICT (address) DO UPDATE SET
      base_mint = EXCLUDED.base_mint,
      quote_mint = EXCLUDED.quote_mint
    `,
    [pool.address, pool.baseMint, pool.quoteMint],
  );
}
