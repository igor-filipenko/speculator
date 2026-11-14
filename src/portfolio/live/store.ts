/** Serializable live position (dates as ISO strings). */
export interface PersistedLivePosition {
  pair: string;
  side: "flat" | "long" | "short";
  size: number;
  entryPrice: number;
  openedAt?: string;
  strategyId?: string;
  slPrice?: number;
  /** Open priority fee plus perps open fee, in USDC. */
  paidFee?: number;
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

/** One strategy instance's durable live ledger. */
export interface PersistedLivePortfolio {
  cashUsdc: number;
  realizedPnl: number;
  position: PersistedLivePosition;
  trades: PersistedLiveTrade[];
  /** `strategy.instances` id. Set once the ledger row exists, including while flat. */
  instanceId?: string;
  /** `strategy.registry` id. Set even when the position is flat. */
  registryId?: string;
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
