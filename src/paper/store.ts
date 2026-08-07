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

/** Paper state envelope (versioned for loaders). */
export interface PersistedPaperState {
  version: 1;
  updatedAt: string;
  portfolios: Record<string, PersistedPortfolio>;
}

/** Anything that can be written into paper persistence. */
export interface PersistablePortfolio {
  toPersisted(): PersistedPortfolio;
}

/**
 * Load paper state from DuckDB (`paper.portfolios` / `paper.trades`).
 * Empty tables → null.
 */
export async function loadPaperState(dataDir?: string): Promise<PersistedPaperState | null> {
  const count = await paperPortfolioCount(dataDir);
  if (count === 0) {
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
