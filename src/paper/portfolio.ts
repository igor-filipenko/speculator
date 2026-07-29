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
