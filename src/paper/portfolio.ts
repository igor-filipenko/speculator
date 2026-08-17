import { match } from "ts-pattern";
import { insertPaperTrade, upsertPaperPortfolio } from "../db/paper.js";
import type { Order, PairConfig, Portfolio, Position, Snapshot, Trade } from "../types.js";
import {
  loadPaperState,
  type PersistedPortfolio,
  type PersistedPosition,
  type PersistedTrade,
} from "./store.js";

export type {
  PersistedPaperState,
  PersistedPortfolio,
  PersistedPosition,
  PersistedTrade,
} from "./store.js";

export interface PaperTrade extends Trade {
  simulated: true;
}

export interface PaperSnapshot extends Snapshot {
  simulated: true;
}

/**
 * Single-pair virtual long-only portfolio.
 * Applies simulated exchange orders (not raw strategy signals).
 */
export class PaperPortfolio implements Portfolio {
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

  static async load(pairs: PairConfig[], defaultCashUsdc: number): Promise<Map<string, Portfolio>> {
    const portfolios = new Map<string, Portfolio>();
    const saved = await loadPaperState();
    for (const pair of pairs) {
      const persisted = saved?.portfolios[pair.symbol];
      if (persisted) {
        const portfolio = PaperPortfolio.fromPersisted(persisted);
        portfolios.set(pair.symbol, portfolio);
        const snap = portfolio.toPersisted();
        const pos =
          snap.position.side === "long"
            ? `long ${snap.position.size.toFixed(6)} @ ${snap.position.entryPrice.toFixed(6)}`
            : "flat";
        console.log(
          `Restored paper ${pair.symbol}: cash=${snap.cashUsdc.toFixed(4)} USDC | position=${pos} | realizedPnl=${snap.realizedPnl.toFixed(4)} | trades=${snap.trades.length}`,
        );
      } else {
        portfolios.set(pair.symbol, new PaperPortfolio(pair.symbol, defaultCashUsdc));
      }
    }
    return portfolios;
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
    const positionValue = this.position.side === "long" ? this.position.size * markPrice : 0;
    return {
      simulated: true,
      cashUsdc: this.cashUsdc,
      position: { ...this.position },
      realizedPnl: this.realizedPnl,
      equity: this.cashUsdc + positionValue,
      trades: [...this.trades],
    };
  }

  /**
   * Apply a filled order without persisting (for backtests and unit tests).
   */
  applyOrderSync(order: Order): PaperTrade | null {
    return match(order.side)
      .with("BUY", () => this.openLong(order))
      .with("SELL", () => this.closeLong(order))
      .exhaustive();
  }

  /**
   * Apply a filled order and persist paper state when a fill happens.
   */
  async applyOrder(order: Order): Promise<PaperTrade | null> {
    const nextTrade = this.applyOrderSync(order);

    if (nextTrade != null) {
      const persisted = this.toPersisted();
      await upsertPaperPortfolio(persisted);
      const last = persisted.trades.at(-1);
      if (last != null) {
        await insertPaperTrade(last);
      }
    }

    return nextTrade;
  }

  private openLong(order: Order): PaperTrade | null {
    if (this.position.side === "long") {
      return null;
    }
    if (order.size <= 0 || order.price <= 0) {
      return null;
    }

    const trade: PaperTrade = {
      pair: order.pair,
      side: "BUY",
      price: order.price,
      size: order.size,
      at: order.at,
      simulated: true,
      reason: order.reason,
    };

    this.position = {
      pair: order.pair,
      side: "long",
      size: order.size,
      entryPrice: order.price,
      openedAt: order.at,
    };
    // All-in: exchange already sized from cash − priority fee.
    this.cashUsdc = 0;
    this.trades.push(trade);
    return trade;
  }

  private closeLong(order: Order): PaperTrade | null {
    if (this.position.side !== "long" || this.position.size <= 0) {
      return null;
    }

    const size = order.size;
    const priorityFeeUsdc = order.priorityFeeUsdc;
    const proceeds = size * order.price - priorityFeeUsdc;
    const cost = size * this.position.entryPrice;
    const pnl = proceeds - cost;

    const trade: PaperTrade = {
      pair: order.pair,
      side: "SELL",
      price: order.price,
      size,
      realizedPnl: pnl,
      at: order.at,
      simulated: true,
      reason: order.reason,
    };

    this.cashUsdc = Math.max(0, proceeds);
    this.realizedPnl += pnl;
    this.position = {
      pair: order.pair,
      side: "flat",
      size: 0,
      entryPrice: 0,
    };
    this.trades.push(trade);
    return trade;
  }
}
