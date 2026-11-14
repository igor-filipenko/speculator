import { portfolioForRegistry, assignedDepositUsdc } from "../../db/bot.js";
import { insertPaperTrade, upsertPaperPortfolio } from "../../db/paper.js";
import { perpsOpenFeeUsdc, shortCloseFeePct } from "../../exchange/jupiter/perps-fees.js";
import { tighterStopPrice } from "../../risk/risk-manager.js";
import type {
  Order,
  PairConfig,
  Portfolio,
  Position,
  PositionData,
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
 * Virtual book for one strategy instance.
 * Opening a long debits this book's cash. A short leaves cash until its PnL is realized.
 */
export class PaperPortfolio implements Portfolio {
  private cashUsdc: number;
  private position: Position;
  private realizedPnl = 0;
  private instanceId: string | undefined;
  private registryId: string | undefined;
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

  static async load(
    pairs: PairConfig[],
    defaultCashUsdc: number,
    registryId: string,
  ): Promise<Map<string, Portfolio>> {
    const portfolios = new Map<string, Portfolio>();
    const saved = await loadPaperState();
    for (const pair of pairs) {
      const persisted =
        saved == null ? undefined : portfolioForRegistry(saved.portfolios, pair.symbol, registryId);
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
        const deposit = await assignedDepositUsdc(pair.symbol, registryId);
        portfolios.set(pair.symbol, new PaperPortfolio(pair.symbol, deposit ?? defaultCashUsdc));
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
    portfolio.instanceId = data.instanceId;
    portfolio.registryId =
      data.registryId ?? (position.strategyId === "" ? undefined : position.strategyId);

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

    const registryId =
      this.registryId ?? (this.position.strategyId === "" ? undefined : this.position.strategyId);
    return {
      cashUsdc: this.cashUsdc,
      realizedPnl: this.realizedPnl,
      position,
      trades,
      ...(this.instanceId !== undefined ? { instanceId: this.instanceId } : {}),
      ...(registryId !== undefined ? { registryId } : {}),
    };
  }

  noteInstance(instanceId: string): void {
    this.instanceId = instanceId;
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
   * Tighten the stored stop in memory. No trade and no database write.
   * Backtests use this; paper trading persists through {@link applyPositionData}.
   */
  applyPositionDataSync(data: PositionData): boolean {
    const next = tighterStopPrice(
      this.position.side,
      this.position.size,
      this.position.slPrice,
      data.slPrice,
    );
    if (next == null || data.pair !== this.position.pair) return false;
    this.position = { ...this.position, slPrice: next };
    return true;
  }

  /** Tighten the stored stop and upsert the paper book. Does not insert a trade. */
  async applyPositionData(data: PositionData): Promise<void> {
    if (!this.applyPositionDataSync(data)) return;
    const instanceId = await upsertPaperPortfolio(this.toPersisted());
    if (instanceId != null) this.noteInstance(instanceId);
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
      const instanceId = await upsertPaperPortfolio(persisted);
      if (instanceId != null) this.noteInstance(instanceId);
      const last = persisted.trades.at(-1);
      if (last != null) {
        await insertPaperTrade(last, instanceId);
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

    const size = takenBaseSize(this.position.size, order.size);
    if (!(size > 0)) return null;
    const priorityFeeUsdc = order.priorityFeeUsdc;
    const paidFee = feeForClose(this.position.paidFee ?? 0, size, this.position.size);
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
    this.position = reduceOrFlat(this.position, size, order.slPrice);
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

    const size = takenBaseSize(this.position.size, order.size);
    if (!(size > 0)) return null;
    const notional = size * this.position.entryPrice;
    const heldMs =
      this.position.openedAt != null ? order.at.getTime() - this.position.openedAt.getTime() : 0;
    const perps = order.fillCosts?.perps;
    const perpsFeeUsdc = perps != null ? notional * shortCloseFeePct({ ...perps, heldMs }) : 0;
    const paidFee = feeForClose(this.position.paidFee ?? 0, size, this.position.size);
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
    this.position = reduceOrFlat(this.position, size, order.slPrice);
    this.trades.push(trade);
    return trade;
  }
}

/** Base size this close actually takes. Never more than the open size. */
function takenBaseSize(positionSize: number, orderSize: number): number {
  if (!(orderSize > 0) || !(positionSize > 0)) return 0;
  return Math.min(orderSize, positionSize);
}

/** Open fee attributed to this close, in proportion to the size taken. */
function feeForClose(paidFee: number, taken: number, positionSize: number): number {
  if (!(paidFee > 0) || !(positionSize > 0) || !(taken > 0)) return 0;
  return paidFee * (taken / positionSize);
}

/**
 * Leave the unsold size open, or go flat when the close takes the position.
 * A tighter stop on the order replaces the stored stop for the remainder.
 */
function reduceOrFlat(position: Position, taken: number, slPrice: number | undefined): Position {
  const remain = position.size - taken;
  if (!(remain > position.size * 1e-9) || !(remain > 1e-12)) {
    return {
      pair: position.pair,
      side: "flat",
      size: 0,
      entryPrice: 0,
      strategyId: "",
      slPrice: 0,
    };
  }
  const paid = position.paidFee ?? 0;
  const next: Position = { ...position, size: remain };
  if (paid > 0) {
    const left = paid * (1 - taken / position.size);
    if (left > 0) next.paidFee = left;
  }
  if (slPrice != null && slPrice > 0) next.slPrice = slPrice;
  return next;
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
