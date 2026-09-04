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
 * Load paper state from `bot.portfolios` / `bot.trades` (mode=paper).
 * Empty tables → null.
 */
export async function loadPaperState(): Promise<PersistedPaperState | null> {
  const count = await paperPortfolioCount();
  if (count === 0) {
    return null;
  }

  const portfolios = await loadAllPaperPortfolios();
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
 * Persist paper portfolios (per-pair upsert + trade sync).
 * Only pairs present in the map are written; other pairs are left untouched.
 */
export async function savePaperState(portfolios: Map<string, PersistablePortfolio>): Promise<void> {
  for (const portfolio of portfolios.values()) {
    await syncPaperPortfolio(portfolio.toPersisted());
  }
}
