import { match } from "ts-pattern";
import { insertLiveTrade, loadLiveState, upsertLivePortfolio } from "../db/live.js";
import { tradableBaseSize } from "../exchange/amounts.js";
import type { BalanceSource } from "../exchange/wallet.js";
import type { Order, PairConfig, Portfolio, Position, Snapshot, Trade } from "../types.js";
import type {
  PersistableLivePortfolio,
  PersistedLivePortfolio,
  PersistedLiveTrade,
} from "./store.js";

const DUST = 1e-9;

export interface LivePortfolioOptions {
  solReserve: number;
  dataDir?: string;
}

/**
 * Long-only live portfolio. Cash and size come from on-chain balances;
 * entry price, opened-at, and realized P&L are the DuckDB ledger.
 */
export class LivePortfolio implements Portfolio, PersistableLivePortfolio {
  private cashUsdc = 0;
  private position: Position;
  private realizedPnl = 0;
  private readonly trades: Trade[] = [];
  private readonly pairConfig: PairConfig;
  private readonly balances: BalanceSource;
  private readonly solReserve: number;
  private readonly dataDir?: string;

  constructor(pair: PairConfig, balances: BalanceSource, options: LivePortfolioOptions) {
    this.pairConfig = pair;
    this.balances = balances;
    this.solReserve = options.solReserve;
    if (options.dataDir !== undefined) {
      this.dataDir = options.dataDir;
    }
    this.position = {
      pair: pair.symbol,
      side: "flat",
      size: 0,
      entryPrice: 0,
    };
  }

  static async load(
    pairs: PairConfig[],
    balances: BalanceSource,
    options: LivePortfolioOptions,
  ): Promise<Map<string, Portfolio>> {
    const portfolios = new Map<string, Portfolio>();
    const saved = await loadLiveState(options.dataDir);
    for (const pair of pairs) {
      const persisted = saved?.portfolios[pair.symbol];
      const portfolio = persisted
        ? LivePortfolio.fromPersisted(pair, balances, options, persisted)
        : new LivePortfolio(pair, balances, options);
      portfolios.set(pair.symbol, portfolio);
      const snap = portfolio.toPersisted();
      const pos =
        snap.position.side === "long"
          ? `long ${snap.position.size.toFixed(6)} @ ${snap.position.entryPrice.toFixed(6)}`
          : "flat";
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
    };
    if (data.position.openedAt !== undefined) {
      position.openedAt = new Date(data.position.openedAt);
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

  getSnapshot(markPrice: number): Snapshot {
    const positionValue = this.position.side === "long" ? this.position.size * markPrice : 0;
    return {
      simulated: false,
      cashUsdc: this.cashUsdc,
      position: { ...this.position },
      realizedPnl: this.realizedPnl,
      equity: this.cashUsdc + positionValue,
      trades: [...this.trades],
    };
  }

  async syncFromChain(markPrice: number): Promise<void> {
    const before = snapshotKey(this);
    await this.overlayChain(markPrice);
    if (snapshotKey(this) !== before) {
      await upsertLivePortfolio(this.toPersisted(), this.dataDir);
    }
  }

  async applyOrder(order: Order): Promise<Trade | null> {
    const nextTrade = match(order.side)
      .with("BUY", () => this.openLong(order))
      .with("SELL", () => this.closeLong(order))
      .exhaustive();

    if (nextTrade == null) {
      return null;
    }

    await this.overlayChain(order.price);
    if (order.side === "BUY" && this.position.side !== "long") {
      // RPC can lag the fill; keep the just-opened long until the next refresh.
      this.position = {
        pair: this.pairConfig.symbol,
        side: "long",
        size: order.size,
        entryPrice: order.price,
        openedAt: order.at,
      };
    }
    const persisted = this.toPersisted();
    await upsertLivePortfolio(persisted, this.dataDir);
    const last = persisted.trades.at(-1);
    if (last != null) {
      await insertLiveTrade(last, this.dataDir);
    }
    return nextTrade;
  }

  private async overlayChain(markPrice: number): Promise<void> {
    await this.balances.refresh([this.pairConfig.baseMint, this.pairConfig.quoteMint]);
    this.cashUsdc = this.balances.tokenUi(this.pairConfig.quoteMint);
    const size = tradableBaseSize({
      baseMint: this.pairConfig.baseMint,
      tokenUi: this.balances.tokenUi(this.pairConfig.baseMint),
      nativeSol: this.balances.nativeSol(),
      reserveSol: this.solReserve,
    });

    if (size > DUST) {
      if (this.position.side !== "long") {
        this.position = {
          pair: this.pairConfig.symbol,
          side: "long",
          size,
          entryPrice: markPrice,
          openedAt: new Date(),
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

    this.position = {
      pair: this.pairConfig.symbol,
      side: "long",
      size: order.size,
      entryPrice: order.price,
      openedAt: order.at,
    };
    this.trades.push(trade);
    return trade;
  }

  private closeLong(order: Order): Trade | null {
    if (this.position.side !== "long" || this.position.size <= 0) {
      return null;
    }

    const size = order.size;
    const proceeds = size * order.price - order.priorityFeeUsdc;
    const cost = size * this.position.entryPrice;
    const pnl = proceeds - cost;

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
