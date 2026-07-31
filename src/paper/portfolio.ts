import type { Position, Signal } from "../types.js";

export interface PaperTrade {
  pair: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  /** Realized P&L in quote currency (set on SELL). */
  realizedPnl?: number;
  at: Date;
  simulated: true;
}

export interface PaperSnapshot {
  cashUsdc: number;
  position: Position;
  realizedPnl: number;
  /** Mark-to-market equity = cash + position * markPrice. */
  equity: number;
  trades: PaperTrade[];
}

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

/**
 * Single-pair virtual long-only portfolio.
 * Fills are simulated at the provided price (typically a Jupiter quote).
 */
export class PaperPortfolio {
  private cashUsdc: number;
  private position: Position;
  private realizedPnl = 0;
  private readonly trades: PaperTrade[] = [];

  constructor(pair: string, startingCashUsdc: number) {
    this.cashUsdc = startingCashUsdc;
    this.position = {
      pair,
      side: "flat",
      size: 0,
      entryPrice: 0,
    };
  }

  /** Restore a portfolio from persisted state. */
  static fromPersisted(data: PersistedPortfolio): PaperPortfolio {
    const portfolio = new PaperPortfolio(data.position.pair, 0);
    portfolio.cashUsdc = data.cashUsdc;
    portfolio.realizedPnl = data.realizedPnl;

    const position: Position = {
      pair: data.position.pair,
      side: data.position.side,
      size: data.position.size,
      entryPrice: data.position.entryPrice,
    };
    if (data.position.openedAt !== undefined) {
      position.openedAt = new Date(data.position.openedAt);
    }
    portfolio.position = position;

    for (const t of data.trades) {
      const trade: PaperTrade = {
        pair: t.pair,
        side: t.side,
        price: t.price,
        size: t.size,
        at: new Date(t.at),
        simulated: true,
      };
      if (t.realizedPnl !== undefined) {
        trade.realizedPnl = t.realizedPnl;
      }
      portfolio.trades.push(trade);
    }

    return portfolio;
  }

  /** Snapshot suitable for JSON persistence (no mark-to-market equity). */
  toPersisted(): PersistedPortfolio {
    const position: PersistedPosition = {
      pair: this.position.pair,
      side: this.position.side,
      size: this.position.size,
      entryPrice: this.position.entryPrice,
    };
    if (this.position.openedAt !== undefined) {
      position.openedAt = this.position.openedAt.toISOString();
    }

    const trades: PersistedTrade[] = this.trades.map((t) => {
      const trade: PersistedTrade = {
        pair: t.pair,
        side: t.side,
        price: t.price,
        size: t.size,
        at: t.at.toISOString(),
        simulated: true,
      };
      if (t.realizedPnl !== undefined) {
        trade.realizedPnl = t.realizedPnl;
      }
      return trade;
    });

    return {
      cashUsdc: this.cashUsdc,
      realizedPnl: this.realizedPnl,
      position,
      trades,
    };
  }

  getSnapshot(markPrice: number): PaperSnapshot {
    const positionValue =
      this.position.side === "long" ? this.position.size * markPrice : 0;
    return {
      cashUsdc: this.cashUsdc,
      position: { ...this.position },
      realizedPnl: this.realizedPnl,
      equity: this.cashUsdc + positionValue,
      trades: [...this.trades],
    };
  }

  /**
   * Apply a signal. BUY opens a long with all cash; SELL closes to cash.
   * Returns a trade if a fill happened, otherwise null.
   */
  applySignal(signal: Signal): PaperTrade | null {
    if (signal.side === "HOLD") {
      return null;
    }

    if (signal.side === "BUY") {
      return this.openLong(signal);
    }

    return this.closeLong(signal);
  }

  private openLong(signal: Signal): PaperTrade | null {
    if (this.position.side === "long") {
      return null;
    }
    if (this.cashUsdc <= 0 || signal.price <= 0) {
      return null;
    }

    const size = this.cashUsdc / signal.price;
    const trade: PaperTrade = {
      pair: signal.pair,
      side: "BUY",
      price: signal.price,
      size,
      at: signal.at,
      simulated: true,
    };

    this.position = {
      pair: signal.pair,
      side: "long",
      size,
      entryPrice: signal.price,
      openedAt: signal.at,
    };
    this.cashUsdc = 0;
    this.trades.push(trade);
    return trade;
  }

  private closeLong(signal: Signal): PaperTrade | null {
    if (this.position.side !== "long" || this.position.size <= 0) {
      return null;
    }

    const proceeds = this.position.size * signal.price;
    const cost = this.position.size * this.position.entryPrice;
    const pnl = proceeds - cost;

    const trade: PaperTrade = {
      pair: signal.pair,
      side: "SELL",
      price: signal.price,
      size: this.position.size,
      realizedPnl: pnl,
      at: signal.at,
      simulated: true,
    };

    this.cashUsdc = proceeds;
    this.realizedPnl += pnl;
    this.position = {
      pair: signal.pair,
      side: "flat",
      size: 0,
      entryPrice: 0,
    };
    this.trades.push(trade);
    return trade;
  }
}
