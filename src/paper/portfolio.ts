import { match } from "ts-pattern";
import { insertPaperTrade, upsertPaperPortfolio } from "../db/paper.js";
import type { PairConfig, Portfolio, Position, Signal, Snapshot, Trade } from "../types.js";
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

/** Optional costs applied on fill (e.g. Solana priority fee in backtests). */
export interface FillOptions {
  /** Deducted from cash before sizing (BUY) or from proceeds (SELL). */
  priorityFeeUsdc?: number;
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
   * Apply a signal without persisting (for backtests and unit tests).
   * BUY opens a long with all cash; SELL closes to cash.
   */
  applySignalSync(signal: Signal, options: FillOptions = {}): PaperTrade | null {
    return match(signal.side)
      .with("HOLD", () => null)
      .with("BUY", () => this.openLong(signal, options))
      .with("SELL", () => this.closeLong(signal, options))
      .exhaustive();
  }

  /**
   * Apply a signal and persist paper state when a fill happens.
   * Returns a trade if a fill happened, otherwise null.
   */
  async applySignal(signal: Signal, options: FillOptions = {}): Promise<PaperTrade | null> {
    const nextTrade = this.applySignalSync(signal, options);

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

  private openLong(signal: Signal, options: FillOptions): PaperTrade | null {
    if (this.position.side === "long") {
      return null;
    }
    if (this.cashUsdc <= 0 || signal.price <= 0) {
      return null;
    }

    const priorityFeeUsdc = options.priorityFeeUsdc ?? 0;
    const spendable = this.cashUsdc - priorityFeeUsdc;
    if (spendable <= 0) {
      return null;
    }

    const size = spendable / signal.price;
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

  private closeLong(signal: Signal, options: FillOptions): PaperTrade | null {
    if (this.position.side !== "long" || this.position.size <= 0) {
      return null;
    }

    const priorityFeeUsdc = options.priorityFeeUsdc ?? 0;
    const proceeds = this.position.size * signal.price - priorityFeeUsdc;
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

    this.cashUsdc = Math.max(0, proceeds);
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
