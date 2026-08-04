import { rename, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

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

/** On-disk paper state file shape (`paper-state.json`). */
export interface PersistedPaperState {
  version: 1;
  updatedAt: string;
  portfolios: Record<string, PersistedPortfolio>;
}

/** Anything that can be written into `paper-state.json`. */
export interface PersistablePortfolio {
  toPersisted(): PersistedPortfolio;
}

export const PAPER_STATE_PATH = "paper-state.json";

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

/**
 * Load paper state from disk.
 * Missing file → null. Corrupt/invalid → warn and return null.
 */
export async function loadPaperState(path = PAPER_STATE_PATH): Promise<PersistedPaperState | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: could not read ${path}: ${message}`);
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: invalid JSON in ${path}: ${message}`);
    return null;
  }

  const parsed = persistedPaperStateSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    console.warn(`Warning: invalid ${path}: ${details}`);
    return null;
  }

  const portfolios: Record<string, PersistedPortfolio> = {};
  for (const [pair, portfolio] of Object.entries(parsed.data.portfolios)) {
    portfolios[pair] = normalizePortfolio(portfolio);
  }

  return {
    version: 1,
    updatedAt: parsed.data.updatedAt,
    portfolios,
  };
}

/**
 * Atomically persist all paper portfolios (temp file + rename).
 */
export async function savePaperState(
  portfolios: Map<string, PersistablePortfolio>,
  path = PAPER_STATE_PATH,
): Promise<void> {
  const state: PersistedPaperState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    portfolios: {},
  };

  for (const [pair, portfolio] of portfolios) {
    state.portfolios[pair] = portfolio.toPersisted();
  }

  const tmpPath = `${path}.${process.pid}.tmp`;
  const body = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, path);
}
