import { readFile } from "node:fs/promises";
import { z } from "zod";
import { loadAllPaperPortfolios, paperPortfolioCount, syncPaperPortfolio } from "../db/paper.js";

/** Serializable position (dates as ISO strings). */
export interface PersistedPosition {
  pair: string;
  side: "flat" | "long";
  size: number;
  entryPrice: number;
  openedAt?: string;
}

/** Serializable trade (dates as ISO strings). */
export interface PersistedTrade {
  pair: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  realizedPnl?: number;
  at: string;
  simulated: true;
}

/** One pair's durable paper ledger. */
export interface PersistedPortfolio {
  cashUsdc: number;
  realizedPnl: number;
  position: PersistedPosition;
  trades: PersistedTrade[];
}

/** Paper state envelope (versioned for loaders / import). */
export interface PersistedPaperState {
  version: 1;
  updatedAt: string;
  portfolios: Record<string, PersistedPortfolio>;
}

/** Anything that can be written into paper persistence. */
export interface PersistablePortfolio {
  toPersisted(): PersistedPortfolio;
}

/** Legacy JSON path used for one-time import into DuckDB. */
export const LEGACY_PAPER_STATE_PATH = "paper-state.json";

const persistedPositionSchema = z.object({
  pair: z.string().min(1),
  side: z.enum(["flat", "long"]),
  size: z.number(),
  entryPrice: z.number(),
  openedAt: z.string().optional(),
});

const persistedTradeSchema = z.object({
  pair: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  price: z.number(),
  size: z.number(),
  realizedPnl: z.number().optional(),
  at: z.string().min(1),
  simulated: z.literal(true),
});

const persistedPortfolioSchema = z.object({
  cashUsdc: z.number(),
  realizedPnl: z.number(),
  position: persistedPositionSchema,
  trades: z.array(persistedTradeSchema),
});

const persistedPaperStateSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().min(1),
  portfolios: z.record(z.string(), persistedPortfolioSchema),
});

function normalizePortfolio(raw: z.infer<typeof persistedPortfolioSchema>): PersistedPortfolio {
  const position: PersistedPosition = {
    pair: raw.position.pair,
    side: raw.position.side,
    size: raw.position.size,
    entryPrice: raw.position.entryPrice,
  };
  if (raw.position.openedAt !== undefined) {
    position.openedAt = raw.position.openedAt;
  }

  const trades: PersistedTrade[] = raw.trades.map((t) => {
    const trade: PersistedTrade = {
      pair: t.pair,
      side: t.side,
      price: t.price,
      size: t.size,
      at: t.at,
      simulated: true,
    };
    if (t.realizedPnl !== undefined) {
      trade.realizedPnl = t.realizedPnl;
    }
    return trade;
  });

  return {
    cashUsdc: raw.cashUsdc,
    realizedPnl: raw.realizedPnl,
    position,
    trades,
  };
}

async function tryImportLegacyPaperState(
  dataDir?: string,
  legacyPath = LEGACY_PAPER_STATE_PATH,
): Promise<PersistedPaperState | null> {
  let raw: string;
  try {
    raw = await readFile(legacyPath, "utf8");
  } catch (err) {
    if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: could not read legacy ${legacyPath}: ${message}`);
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: invalid JSON in legacy ${legacyPath}: ${message}`);
    return null;
  }

  const parsed = persistedPaperStateSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    console.warn(`Warning: invalid legacy ${legacyPath}: ${details}`);
    return null;
  }

  const portfolios: Record<string, PersistedPortfolio> = {};
  for (const [pair, portfolio] of Object.entries(parsed.data.portfolios)) {
    const normalized = normalizePortfolio(portfolio);
    portfolios[pair] = normalized;
    await syncPaperPortfolio(normalized, dataDir);
  }

  console.log(
    `Imported ${Object.keys(portfolios).length} paper portfolio(s) from ${legacyPath} into DuckDB`,
  );

  return {
    version: 1,
    updatedAt: parsed.data.updatedAt,
    portfolios,
  };
}

/**
 * Load paper state from DuckDB.
 * Empty tables → null (optionally after one-time import from legacy paper-state.json).
 */
export async function loadPaperState(dataDir?: string): Promise<PersistedPaperState | null> {
  const count = await paperPortfolioCount(dataDir);
  if (count === 0) {
    const imported = await tryImportLegacyPaperState(dataDir);
    if (imported != null) {
      return imported;
    }
    return null;
  }

  const portfolios = await loadAllPaperPortfolios(dataDir);
  if (Object.keys(portfolios).length === 0) {
    return null;
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    portfolios,
  };
}

/**
 * Persist paper portfolios into DuckDB (per-pair upsert + trade sync).
 * Only pairs present in the map are written; other pairs are left untouched.
 */
export async function savePaperState(
  portfolios: Map<string, PersistablePortfolio>,
  dataDir?: string,
): Promise<void> {
  for (const portfolio of portfolios.values()) {
    await syncPaperPortfolio(portfolio.toPersisted(), dataDir);
  }
}
