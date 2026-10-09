import { insertPaperTrade, upsertPaperPortfolio } from "../../db/paper.js";
import { perpsOpenFeeUsdc, shortCloseFeePct } from "../../exchange/jupiter/perps-fees.js";
import type {
  Order,
  PairConfig,
  Portfolio,
  Position,
  PortfolioSnapshot,
  Trade,
} from "../../types.js";
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

export interface PaperSnapshot extends PortfolioSnapshot {
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
      strategyId: "",
      slPrice: 0,
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
          snap.position.side === "flat"
            ? "flat"
            : `${snap.position.side} ${snap.position.size.toFixed(6)} @ ${snap.position.entryPrice.toFixed(6)}`;
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
      strategyId: data.position.strategyId ?? "",
      slPrice: data.position.slPrice ?? 0,
    };
    if (data.position.openedAt !== undefined) {
      position.openedAt = new Date(data.position.openedAt);
    }
    if (data.position.paidFee !== undefined && data.position.paidFee > 0) {
      position.paidFee = data.position.paidFee;
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
    if (this.position.strategyId !== undefined) {
      position.strategyId = this.position.strategyId;
    }
    if (this.position.slPrice !== undefined) {
      position.slPrice = this.position.slPrice;
    }
    if (this.position.paidFee !== undefined && this.position.paidFee > 0) {
      position.paidFee = this.position.paidFee;
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
    return {
      simulated: true,
      cashUsdc: this.cashUsdc,
      position: { ...this.position },
      realizedPnl: this.realizedPnl,
      equity: markEquity(this.cashUsdc, this.position, markPrice),
      trades: [...this.trades],
      nativeSol: 0,
      insufficientSol: 0,
    };
  }

  /** Paper cash/size are virtual — nothing to refresh from chain. */
  async syncFromChain(_markPrice: number): Promise<void> {
    /* no-op */
  }

  /**
   * Apply a filled order without persisting (for backtests and unit tests).
   */
  applyOrderSync(order: Order): PaperTrade | null {
    switch (order.intent) {
      case "open-long":
        return this.openLong(order);
      case "close-long":
        return this.closeLong(order);
      case "open-short":
        return this.openShort(order);
      case "close-short":
        return this.closeShort(order);
      case "buy-sol":
        return null;
    }
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

    this.position = openedPosition(order.pair, "long", order);
    const spent = order.size * order.price + order.priorityFeeUsdc;
    this.cashUsdc = Math.max(0, this.cashUsdc - spent);
    this.trades.push(trade);
    return trade;
  }

  private closeLong(order: Order): PaperTrade | null {
    if (this.position.side !== "long" || this.position.size <= 0) {
      return null;
    }

    const size = order.size;
    const priorityFeeUsdc = order.priorityFeeUsdc;
    const paidFee = this.position.paidFee ?? 0;
    const proceeds = size * order.price - priorityFeeUsdc;
    const cost = size * this.position.entryPrice;
    const pnl = proceeds - cost - paidFee;

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

    this.cashUsdc = Math.max(0, this.cashUsdc + proceeds);
    this.realizedPnl += pnl;
    this.position = {
      pair: order.pair,
      side: "flat",
      size: 0,
      entryPrice: 0,
      strategyId: "",
      slPrice: 0,
    };
    this.trades.push(trade);
    return trade;
  }

  private openShort(order: Order): PaperTrade | null {
    if (this.position.side !== "flat") {
      return null;
    }
    if (order.size <= 0 || order.price <= 0) {
      return null;
    }

    const openFeeUsdc = perpsOpenFeeUsdc(order);
    const trade: PaperTrade = {
      pair: order.pair,
      side: "SELL",
      price: order.price,
      size: order.size,
      at: order.at,
      simulated: true,
      reason: order.reason,
      ...(openFeeUsdc > 0 ? { perpsFeeUsdc: openFeeUsdc } : {}),
    };

    this.position = openedPosition(order.pair, "short", order);
    this.trades.push(trade);
    return trade;
  }

  private closeShort(order: Order): PaperTrade | null {
    if (this.position.side !== "short" || this.position.size <= 0) {
      return null;
    }

    const size = order.size;
    const notional = size * this.position.entryPrice;
    const heldMs =
      this.position.openedAt != null ? order.at.getTime() - this.position.openedAt.getTime() : 0;
    const perps = order.fillCosts?.perps;
    const perpsFeeUsdc = perps != null ? notional * shortCloseFeePct({ ...perps, heldMs }) : 0;
    const paidFee = this.position.paidFee ?? 0;
    const pnl =
      size * (this.position.entryPrice - order.price) -
      order.priorityFeeUsdc -
      perpsFeeUsdc -
      paidFee;
    const trade: PaperTrade = {
      pair: order.pair,
      side: "BUY",
      price: order.price,
      size,
      realizedPnl: pnl,
      at: order.at,
      simulated: true,
      reason: order.reason,
      ...(perpsFeeUsdc > 0 ? { perpsFeeUsdc } : {}),
    };

    this.cashUsdc = Math.max(0, this.cashUsdc + pnl);
    this.realizedPnl += pnl;
    this.position = {
      pair: order.pair,
      side: "flat",
      size: 0,
      entryPrice: 0,
      strategyId: "",
      slPrice: 0,
    };
    this.trades.push(trade);
    return trade;
  }
}

function openedPosition(pair: string, side: "long" | "short", order: Order): Position {
  const position: Position = {
    pair,
    side,
    size: order.size,
    entryPrice: order.price,
    openedAt: order.at,
    strategyId: order.strategyId ?? "",
    slPrice: order.slPrice ?? 0,
  };
  const paidFee = order.priorityFeeUsdc + (side === "short" ? perpsOpenFeeUsdc(order) : 0);
  if (paidFee > 0) {
    position.paidFee = paidFee;
  }
  return position;
}

function markEquity(cashUsdc: number, position: Position, markPrice: number): number {
  if (position.side === "long") {
    return cashUsdc + position.size * markPrice;
  }
  if (position.side === "short") {
    return cashUsdc + position.size * (position.entryPrice - markPrice);
  }
  return cashUsdc;
}
