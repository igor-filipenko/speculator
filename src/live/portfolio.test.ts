import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { resetSpeculatorDbCache } from "../db/db.js";
import { loadAllLivePortfolios } from "../db/live.js";
import { useTestDb } from "../db/test-db.js";
import { WSOL_MINT } from "../exchange/amounts.js";
import type { BalanceSource } from "../exchange/wallet.js";
import type { Order, PairConfig } from "../types.js";
import { LivePortfolio } from "./portfolio.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const PAIR: PairConfig = {
  symbol: "SOL/USDC",
  baseMint: WSOL_MINT,
  quoteMint: USDC,
  baseDecimals: 9,
  quoteDecimals: 6,
  geckoPoolAddress: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
};

class FakeBalances implements BalanceSource {
  readonly owner: PublicKey;
  native = 0.05;
  tokens = new Map<string, number>([[USDC, 100]]);

  constructor() {
    this.owner = Keypair.generate().publicKey;
  }

  async refresh(_mints: readonly string[]): Promise<void> {
    /* no-op */
  }

  nativeSol(): number {
    return this.native;
  }

  tokenUi(mint: string): number {
    return this.tokens.get(mint) ?? 0;
  }
}

function buyOrder(overrides: Partial<Order> = {}): Order {
  return {
    pair: "SOL/USDC",
    side: "BUY",
    reason: "test buy",
    price: 100,
    size: 0.5,
    at: new Date("2026-08-20T10:00:00.000Z"),
    simulated: false,
    priorityFeeUsdc: 0,
    txSignature: "BuySig",
    ...overrides,
  };
}

describe("LivePortfolio", () => {
  let balances: FakeBalances;

  before(async () => {
    await useTestDb();
    balances = new FakeBalances();
  });

  after(async () => {
    await resetSpeculatorDbCache();
  });

  it("opens a long from a live fill and persists simulated=false + signature", async () => {
    balances.native = 0.55;
    balances.tokens.set(USDC, 0);
    balances.tokens.set(WSOL_MINT, 0);

    const portfolio = new LivePortfolio(PAIR, balances, { solReserve: 0.05 });
    const trade = await portfolio.applyOrder(buyOrder());
    assert.ok(trade);
    assert.equal(trade.simulated, false);
    assert.equal(trade.txSignature, "BuySig");

    const snap = portfolio.getSnapshot(100);
    assert.equal(snap.simulated, false);
    assert.equal(snap.position.side, "long");
    assert.equal(snap.position.entryPrice, 100);
    assert.ok(snap.position.size > 0);

    const loaded = await loadAllLivePortfolios();
    const persisted = loaded["SOL/USDC"];
    assert.ok(persisted);
    assert.equal(persisted.trades.length, 1);
    assert.equal(persisted.trades[0]?.simulated, false);
    assert.equal(persisted.trades[0]?.txSignature, "BuySig");
  });

  it("reconciles unexpected on-chain inventory as long at mark (no phantom PnL)", async () => {
    const extra = new FakeBalances();
    extra.native = 1.05;
    extra.tokens.set(USDC, 0);
    const portfolio = new LivePortfolio(PAIR, extra, { solReserve: 0.05 });
    await portfolio.syncFromChain(200);
    const snap = portfolio.getSnapshot(200);
    assert.equal(snap.position.side, "long");
    assert.equal(snap.position.entryPrice, 200);
    assert.equal(snap.realizedPnl, 0);
  });

  it("goes flat when chain size is only the SOL fee reserve", async () => {
    const reserved = new FakeBalances();
    reserved.native = 0.05;
    reserved.tokens.set(USDC, 50);
    const portfolio = new LivePortfolio(PAIR, reserved, { solReserve: 0.05 });
    await portfolio.syncFromChain(150);
    const snap = portfolio.getSnapshot(150);
    assert.equal(snap.position.side, "flat");
    assert.equal(snap.cashUsdc, 50);
  });
});
