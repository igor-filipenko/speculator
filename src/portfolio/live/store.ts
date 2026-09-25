/** Serializable live position (dates as ISO strings). */
export interface PersistedLivePosition {
  pair: string;
  side: "flat" | "long";
  size: number;
  entryPrice: number;
  openedAt?: string;
}

/** Serializable live trade (dates as ISO strings). */
export interface PersistedLiveTrade {
  pair: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  realizedPnl?: number;
  at: string;
  simulated: boolean;
  txSignature?: string;
}

/** One pair's durable live ledger. */
export interface PersistedLivePortfolio {
  cashUsdc: number;
  realizedPnl: number;
  position: PersistedLivePosition;
  trades: PersistedLiveTrade[];
}

/** Live state envelope (versioned for loaders). */
export interface PersistedLiveState {
  version: 1;
  updatedAt: string;
  portfolios: Record<string, PersistedLivePortfolio>;
}

export interface PersistableLivePortfolio {
  toPersisted(): PersistedLivePortfolio;
}
