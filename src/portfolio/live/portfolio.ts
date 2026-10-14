import { match } from "ts-pattern";
import { insertLiveTrade, loadLiveState, upsertLivePortfolio } from "../../db/live.js";
import { tradableBaseSize } from "../../exchange/jupiter/amounts.js";
import { perpsOpenFeeUsdc, shortCloseFeePct } from "../../exchange/jupiter/perps-fees.js";
import type {
  BalanceSource,
  Order,
  PairConfig,
  Portfolio,
  Position,
  PortfolioSnapshot,
  PositionSource,
  Trade,
} from "../../types.js";
import type {
  PersistableLivePortfolio,
  PersistedLivePortfolio,
  PersistedLiveTrade,
} from "./store.js";

const DUST = 1e-9;

export interface LivePortfolioOptions {
  solReserveMin: number;
  solReserveMax: number;
  positions?: PositionSource;
}

/**
 * Live portfolio. Spot size is a long; a Jupiter Perps short overrides it.
 * entry price, opened-at, and realized P&L are the Timescale ledger.
 */
export class LivePortfolio implements Portfolio, PersistableLivePortfolio {
  private cashUsdc = 0;
  private position: Position;
  private realizedPnl = 0;
  private readonly trades: Trade[] = [];
  private readonly pairConfig: PairConfig;
  private readonly balances: BalanceSource;
  private readonly solReserveMin: number;
  private readonly solReserveMax: number;
  private readonly positions: PositionSource | undefined;
  private shortCollateralUsd = 0;

  constructor(pair: PairConfig, balances: BalanceSource, options: LivePortfolioOptions) {
    this.pairConfig = pair;
    this.balances = balances;
    this.solReserveMin = options.solReserveMin;
    this.solReserveMax = options.solReserveMax;
    this.positions = options.positions;
    this.position = {
      pair: pair.symbol,
      side: "flat",
      size: 0,
      entryPrice: 0,
      strategyId: "",
      slPrice: 0,
    };
  }

  static async load(
    pairs: PairConfig[],
    balances: BalanceSource,
    options: LivePortfolioOptions,
  ): Promise<Map<string, Portfolio>> {
    const portfolios = new Map<string, Portfolio>();
    const saved = await loadLiveState();
    for (const pair of pairs) {
      const persisted = saved?.portfolios[pair.symbol];
      const portfolio = persisted
        ? LivePortfolio.fromPersisted(pair, balances, options, persisted)
        : new LivePortfolio(pair, balances, options);
      portfolios.set(pair.symbol, portfolio);
      const snap = portfolio.toPersisted();
      const pos =
        snap.position.side === "flat"
          ? "flat"
          : `${snap.position.side} ${snap.position.size.toFixed(6)} @ ${snap.position.entryPrice.toFixed(6)}`;
      console.log(
        `Live ${pair.symbol}: ledger cash=${snap.cashUsdc.toFixed(4)} USDC | position=${pos} | realizedPnl=${snap.realizedPnl.toFixed(4)} | trades=${snap.trades.length}`,
      );
    }
    return portfolios;
  }

  static fromPersisted(
    pair: PairConfig,
    balances: BalanceSource,
    options: LivePortfolioOptions,
    data: PersistedLivePortfolio,
  ): LivePortfolio {
    const portfolio = new LivePortfolio(pair, balances, options);
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
      const trade: Trade = {
        pair: t.pair,
        side: t.side,
        price: t.price,
        size: t.size,
        at: new Date(t.at),
        simulated: t.simulated,
      };
      if (t.realizedPnl !== undefined) {
        trade.realizedPnl = t.realizedPnl;
      }
      if (t.txSignature !== undefined) {
        trade.txSignature = t.txSignature;
      }
      portfolio.trades.push(trade);
    }

    return portfolio;
  }

  toPersisted(): PersistedLivePortfolio {
    const position = {
      pair: this.position.pair,
      side: this.position.side,
      size: this.position.size,
      entryPrice: this.position.entryPrice,
      ...(this.position.openedAt !== undefined
        ? { openedAt: this.position.openedAt.toISOString() }
        : {}),
      ...(this.position.strategyId !== undefined ? { strategyId: this.position.strategyId } : {}),
      ...(this.position.slPrice !== undefined ? { slPrice: this.position.slPrice } : {}),
      ...(this.position.paidFee !== undefined && this.position.paidFee > 0
        ? { paidFee: this.position.paidFee }
        : {}),
    };

    const trades: PersistedLiveTrade[] = this.trades.map((t) => {
      const trade: PersistedLiveTrade = {
        pair: t.pair,
        side: t.side,
        price: t.price,
        size: t.size,
        at: t.at.toISOString(),
        simulated: t.simulated,
      };
      if (t.realizedPnl !== undefined) {
        trade.realizedPnl = t.realizedPnl;
      }
      if (t.txSignature !== undefined) {
        trade.txSignature = t.txSignature;
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

  getSnapshot(markPrice: number): PortfolioSnapshot {
    const positionValue =
      this.position.side === "long"
        ? this.position.size * markPrice
        : this.position.side === "short"
          ? this.shortCollateralUsd + this.position.size * (this.position.entryPrice - markPrice)
          : 0;
    const nativeSol = this.balances.nativeSol();
    return {
      simulated: false,
      cashUsdc: this.cashUsdc,
      position: { ...this.position },
      realizedPnl: this.realizedPnl,
      equity: this.cashUsdc + positionValue,
      trades: [...this.trades],
      nativeSol,
      insufficientSol: calcInsufficientSol(nativeSol, this.solReserveMin, this.solReserveMax),
    };
  }

  async syncFromChain(markPrice: number): Promise<void> {
    const before = snapshotKey(this);
    await this.overlayChain(markPrice);
    if (snapshotKey(this) !== before) {
      await upsertLivePortfolio(this.toPersisted());
    }
  }

  async applyOrder(order: Order): Promise<Trade | null> {
    if (order.intent === "buy-sol") {
      await this.overlayChain(order.price);
      return null;
    }

    const before = this.position.side;
    const nextTrade = match(order.intent)
      .with("open-long", () => this.openLong(order))
      .with("close-long", () => this.closeLong(order))
      .with("open-short", () => this.openShort(order))
      .with("close-short", () => this.closeShort(order))
      .exhaustive();

    if (nextTrade == null) {
      return null;
    }

    await this.overlayChain(order.price);
    if (order.intent === "open-long" && before === "flat" && this.position.side !== "long") {
      // RPC can lag the fill; keep the just-opened long until the next refresh.
      this.position = openedPosition(this.pairConfig.symbol, "long", order);
    }
    if (order.intent === "open-short" && before === "flat" && this.position.side !== "short") {
      this.shortCollateralUsd = 0;
      this.position = openedPosition(this.pairConfig.symbol, "short", order);
    }
    if (order.intent === "open-long" && this.position.side === "long") {
      this.position = openedPosition(this.pairConfig.symbol, "long", {
        ...order,
        size: this.position.size,
      });
    }
    if (order.intent === "open-short" && this.position.side === "short") {
      this.position = openedPosition(this.pairConfig.symbol, "short", {
        ...order,
        size: this.position.size,
      });
    }
    const persisted = this.toPersisted();
    await upsertLivePortfolio(persisted);
    const last = persisted.trades.at(-1);
    if (last != null) {
      await insertLiveTrade(last);
    }
    return nextTrade;
  }

  private async overlayChain(markPrice: number): Promise<void> {
    await this.balances.refresh([this.pairConfig.baseMint, this.pairConfig.quoteMint]);
    this.cashUsdc = this.balances.tokenUi(this.pairConfig.quoteMint);
    const short = this.positions ? await this.positions.findOpenPosition(this.pairConfig) : null;
    const size = tradableBaseSize({
      baseMint: this.pairConfig.baseMint,
      tokenUi: this.balances.tokenUi(this.pairConfig.baseMint),
      nativeSol: this.balances.nativeSol(),
      reserveSol: this.solReserveMax,
    });

    if (short != null && size > DUST) {
      console.error(
        `[${this.pairConfig.symbol}] spot long and jupiter perps short are both open; keeping the short`,
      );
    }
    if (short != null) {
      this.shortCollateralUsd = short.collateralUsd;
      if (this.position.side !== "short") {
        this.position = {
          pair: this.pairConfig.symbol,
          side: "short",
          size: short.size,
          entryPrice: short.entryPrice,
          openedAt: new Date(),
          strategyId: "",
          slPrice: 0,
        };
      } else {
        this.position = { ...this.position, size: short.size };
      }
      return;
    }
    this.shortCollateralUsd = 0;

    if (size > DUST) {
      if (this.position.side !== "long") {
        this.position = {
          pair: this.pairConfig.symbol,
          side: "long",
          size,
          entryPrice: markPrice,
          openedAt: new Date(),
          strategyId: "",
          slPrice: 0,
        };
      } else {
        this.position = { ...this.position, size };
      }
      return;
    }

    this.position = {
      pair: this.pairConfig.symbol,
      side: "flat",
      size: 0,
      entryPrice: 0,
      strategyId: "",
      slPrice: 0,
    };
  }

  private openLong(order: Order): Trade | null {
    if (this.position.side === "long") {
      return null;
    }
    if (order.size <= 0 || order.price <= 0) {
      return null;
    }

    const trade: Trade = {
      pair: order.pair,
      side: "BUY",
      price: order.price,
      size: order.size,
      at: order.at,
      simulated: false,
      reason: order.reason,
    };
    if (order.txSignature !== undefined) {
      trade.txSignature = order.txSignature;
    }

    this.position = openedPosition(this.pairConfig.symbol, "long", order);
    this.trades.push(trade);
    return trade;
  }

  private closeLong(order: Order): Trade | null {
    if (this.position.side !== "long" || this.position.size <= 0) {
      return null;
    }

    const size = order.size;
    const paidFee = this.position.paidFee ?? 0;
    const proceeds = size * order.price - order.priorityFeeUsdc;
    const cost = size * this.position.entryPrice;
    const pnl = proceeds - cost - paidFee;

    const trade: Trade = {
      pair: order.pair,
      side: "SELL",
      price: order.price,
      size,
      realizedPnl: pnl,
      at: order.at,
      simulated: false,
      reason: order.reason,
    };
    if (order.txSignature !== undefined) {
      trade.txSignature = order.txSignature;
    }

    this.realizedPnl += pnl;
    this.position = {
      pair: this.pairConfig.symbol,
      side: "flat",
      size: 0,
      entryPrice: 0,
      strategyId: "",
      slPrice: 0,
    };
    this.trades.push(trade);
    return trade;
  }

  private openShort(order: Order): Trade | null {
    if (this.position.side === "short") {
      return null;
    }
    if (order.size <= 0 || order.price <= 0) {
      return null;
    }
    const openFeeUsdc = perpsOpenFeeUsdc(order);
    const trade: Trade = {
      pair: order.pair,
      side: "SELL",
      price: order.price,
      size: order.size,
      at: order.at,
      simulated: false,
      reason: order.reason,
      ...(openFeeUsdc > 0 ? { perpsFeeUsdc: openFeeUsdc } : {}),
    };
    if (order.txSignature !== undefined) {
      trade.txSignature = order.txSignature;
    }
    this.position = openedPosition(this.pairConfig.symbol, "short", order);
    this.trades.push(trade);
    return trade;
  }

  private closeShort(order: Order): Trade | null {
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
    const trade: Trade = {
      pair: order.pair,
      side: "BUY",
      price: order.price,
      size,
      realizedPnl: pnl,
      at: order.at,
      simulated: false,
      reason: order.reason,
      ...(perpsFeeUsdc > 0 ? { perpsFeeUsdc } : {}),
    };
    if (order.txSignature !== undefined) {
      trade.txSignature = order.txSignature;
    }
    this.realizedPnl += pnl;
    this.shortCollateralUsd = 0;
    this.position = {
      pair: this.pairConfig.symbol,
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

function snapshotKey(portfolio: LivePortfolio): string {
  const persisted = portfolio.toPersisted();
  return JSON.stringify({
    cash: persisted.cashUsdc,
    side: persisted.position.side,
    size: persisted.position.size,
    entry: persisted.position.entryPrice,
    pnl: persisted.realizedPnl,
  });
}

/**
 * SOL to buy so native balance reaches `max` after falling below `min`.
 * At or above `min`, no top-up.
 */
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

function calcInsufficientSol(
  nativeSol: number,
  solReserveMin: number,
  solReserveMax: number,
): number {
  return nativeSol < solReserveMin ? solReserveMax - nativeSol : 0;
}
