import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { WSOL_MINT } from "./amounts.js";
import { JupiterSwapExchange } from "./jupiter-swap.js";
import type { BalanceSource } from "./wallet.js";
import type { Command, PairConfig } from "../types.js";

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
  native = 1;
  tokens = new Map<string, number>([[USDC, 10]]);

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

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function buyCommand(): Command {
  return {
    pair: "SOL/USDC",
    side: "BUY",
    reason: "test",
    at: new Date("2026-08-20T00:00:00.000Z"),
    priceHint: 100,
    quoteBudgetUsdc: 1,
  };
}

describe("JupiterSwapExchange.execute", () => {
  it("returns a live fill from mocked /order + /execute", async () => {
    const calls: { url: string; body?: string | undefined }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.includes("/swap/v2/order")) {
        return Promise.resolve(
          new Response(JSON.stringify({ transaction: "dGVzdA==", requestId: "req-1" })),
        );
      }
      if (url.includes("/swap/v2/execute")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "Success",
              signature: "Sig111",
              inputAmountResult: "1000000",
              outputAmountResult: "10000000",
            }),
          ),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 404 }));
    };

    const exchange = new JupiterSwapExchange({
      apiKey: "test-key",
      keypair: Keypair.generate(),
      balances: new FakeBalances(),
      fetchImpl,
      signTransaction: (tx) => `signed:${tx}`,
    });

    const order = await exchange.execute(buyCommand(), PAIR);
    assert.ok(order);
    assert.equal(order.simulated, false);
    assert.equal(order.txSignature, "Sig111");
    assert.equal(order.size, 0.01);
    assert.equal(order.price, 100);
    assert.ok(calls.some((c) => c.url.includes("/swap/v2/order")));
    assert.ok(calls.some((c) => c.url.includes("/swap/v2/execute")));
    const execute = calls.find((c) => c.url.includes("/execute"));
    assert.ok(execute?.body?.includes("signed:dGVzdA=="));
    assert.ok(execute?.body?.includes("req-1"));
  });

  it("returns null when /execute reports Failed", async () => {
    const fetchImpl: typeof fetch = (input) => {
      const url = requestUrl(input);
      if (url.includes("/order")) {
        return Promise.resolve(
          new Response(JSON.stringify({ transaction: "dGVzdA==", requestId: "req-1" })),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ status: "Failed", error: "slippage" })));
    };

    const exchange = new JupiterSwapExchange({
      apiKey: "test-key",
      keypair: Keypair.generate(),
      balances: new FakeBalances(),
      fetchImpl,
      signTransaction: (tx) => tx,
    });

    const order = await exchange.execute(buyCommand(), PAIR);
    assert.equal(order, null);
  });

  it("aborts when native SOL is below the fee reserve", async () => {
    const balances = new FakeBalances();
    balances.native = 0.01;
    let fetched = false;
    const fetchImpl: typeof fetch = () => {
      fetched = true;
      return Promise.resolve(new Response("nope", { status: 500 }));
    };

    const exchange = new JupiterSwapExchange({
      apiKey: "test-key",
      keypair: Keypair.generate(),
      balances,
      solReserve: 0.05,
      fetchImpl,
      signTransaction: (tx) => tx,
    });

    const order = await exchange.execute(buyCommand(), PAIR);
    assert.equal(order, null);
    assert.equal(fetched, false);
  });
});
