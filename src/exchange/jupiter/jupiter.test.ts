import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { Keypair } from "@solana/web3.js";
import { WSOL_MINT } from "./amounts.js";
import { ExchangeError } from "../error.js";
import { isOrder, type BalanceSource, type Command, type PairConfig } from "../../types.js";
import { JupiterExchange } from "./jupiter.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const PAIR: PairConfig = {
  symbol: "SOL/USDC",
  baseMint: WSOL_MINT,
  quoteMint: USDC,
  baseDecimals: 9,
  quoteDecimals: 6,
  geckoPoolAddress: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
};

const TOKEN_PAIR: PairConfig = {
  symbol: "JUP/USDC",
  baseMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  quoteMint: USDC,
  baseDecimals: 6,
  quoteDecimals: 6,
  geckoPoolAddress: "test-pool",
};

class FakeBalances implements BalanceSource {
  native = 1;
  tokens = new Map<string, number>([[USDC, 10]]);

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

function buyCommand(pair = "SOL/USDC"): Command {
  return {
    pair,
    intent: "open-long",
    orderType: "market",
    reason: "test",
    at: new Date("2026-08-20T00:00:00.000Z"),
    priceHint: 100,
    quoteBudgetUsdc: 1,
  };
}

function sellCommand(pair = "SOL/USDC"): Command {
  return {
    pair,
    intent: "close-long",
    orderType: "market",
    reason: "test",
    at: new Date("2026-08-20T00:00:00.000Z"),
    priceHint: 100,
    baseSize: 0.5,
  };
}

function belowReserveBalances(): FakeBalances {
  const balances = new FakeBalances();
  balances.native = 0.01;
  return balances;
}

function trackingFetch(): { fetched: { value: boolean }; fetchImpl: typeof fetch } {
  const fetched = { value: false };
  const fetchImpl: typeof fetch = () => {
    fetched.value = true;
    return Promise.resolve(new Response("nope", { status: 500 }));
  };
  return { fetched, fetchImpl };
}

describe("JupiterExchange.execute", () => {
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

    const exchange = new JupiterExchange({
      apiKey: "test-key",
      keypair: Keypair.generate(),
      balances: new FakeBalances(),
      fetchImpl,
      signTransaction: (tx) => `signed:${tx}`,
    });

    const order = await exchange.execute(buyCommand(), PAIR);
    assert.ok(isOrder(order));
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

  it("returns an error when /execute reports Failed", async () => {
    const fetchImpl: typeof fetch = (input) => {
      const url = requestUrl(input);
      if (url.includes("/order")) {
        return Promise.resolve(
          new Response(JSON.stringify({ transaction: "dGVzdA==", requestId: "req-1" })),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ status: "Failed", error: "slippage" })));
    };

    const exchange = new JupiterExchange({
      apiKey: "test-key",
      keypair: Keypair.generate(),
      balances: new FakeBalances(),
      fetchImpl,
      signTransaction: (tx) => tx,
    });

    const order = await exchange.execute(buyCommand(), PAIR);
    assert.ok(!isOrder(order));
    assert.match(order.message, /slippage/);
  });

  it("allows BUY SOL when native SOL is below the fee reserve", async () => {
    let fetched = false;
    const fetchImpl: typeof fetch = (input) => {
      fetched = true;
      const url = requestUrl(input);
      if (url.includes("/order")) {
        return Promise.resolve(
          new Response(JSON.stringify({ transaction: "dGVzdA==", requestId: "req-1" })),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "Success",
            signature: "SigLowSol",
            inputAmountResult: "1000000",
            outputAmountResult: "10000000",
          }),
        ),
      );
    };

    const exchange = new JupiterExchange({
      apiKey: "test-key",
      keypair: Keypair.generate(),
      balances: belowReserveBalances(),
      solReserveMin: 0.05,
      fetchImpl,
      signTransaction: (tx) => tx,
    });

    const order = await exchange.execute(buyCommand(), PAIR);
    assert.ok(isOrder(order));
    assert.equal(order.txSignature, "SigLowSol");
    assert.equal(fetched, true);
  });

  it("aborts a token BUY when native SOL is below the fee reserve", async () => {
    const { fetched, fetchImpl } = trackingFetch();
    const exchange = new JupiterExchange({
      apiKey: "test-key",
      keypair: Keypair.generate(),
      balances: belowReserveBalances(),
      solReserveMin: 0.05,
      fetchImpl,
      signTransaction: (tx) => tx,
    });

    const order = await exchange.execute(buyCommand(TOKEN_PAIR.symbol), TOKEN_PAIR);
    assert.ok(!isOrder(order));
    assert.match(order.message, /native SOL/);
    assert.equal(fetched.value, false);
  });

  it("aborts a SELL when native SOL is below the fee reserve", async () => {
    const { fetched, fetchImpl } = trackingFetch();
    const exchange = new JupiterExchange({
      apiKey: "test-key",
      keypair: Keypair.generate(),
      balances: belowReserveBalances(),
      solReserveMin: 0.05,
      fetchImpl,
      signTransaction: (tx) => tx,
    });

    const order = await exchange.execute(sellCommand(), PAIR);
    assert.ok(!isOrder(order));
    assert.match(order.message, /native SOL/);
    assert.equal(fetched.value, false);
  });

  it("loads perps fees once per mint and reuses the cache", async () => {
    let poolInfoCalls = 0;
    const fetchImpl: typeof fetch = (input) => {
      const url = requestUrl(input);
      if (url.includes("/pool-info")) {
        poolInfoCalls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              openFeePercent: "0.06",
              shortBorrowRatePercent: "0.0012",
            }),
          ),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    };
    const exchange = new JupiterExchange({
      fetchImpl,
      perpsBaseUrl: "https://perps.test/v1",
    });
    const first = await exchange.perpsFeeSchedule(PAIR);
    const second = await exchange.perpsFeeSchedule(PAIR);
    assert.equal(poolInfoCalls, 1);
    assert.equal(first, second);
    assert.equal(first.openFeePct, Number("0.06") / 100);
    assert.equal(first.closeFeePct, first.openFeePct);
    assert.equal(first.borrowFeePctPerHour, Number("0.0012") / 100);
  });

  it("refetches perps fees after one hour", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00.000Z") });
    try {
      let poolInfoCalls = 0;
      const fetchImpl: typeof fetch = (input) => {
        const url = requestUrl(input);
        if (url.includes("/pool-info")) {
          poolInfoCalls += 1;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                openFeePercent: "0.06",
                shortBorrowRatePercent: "0.0012",
              }),
            ),
          );
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      };
      const exchange = new JupiterExchange({
        fetchImpl,
        perpsBaseUrl: "https://perps.test/v1",
      });
      await exchange.perpsFeeSchedule(PAIR);
      mock.timers.tick(60 * 60 * 1000 - 1);
      await exchange.perpsFeeSchedule(PAIR);
      assert.equal(poolInfoCalls, 1);
      mock.timers.tick(1);
      await exchange.perpsFeeSchedule(PAIR);
      assert.equal(poolInfoCalls, 2);
    } finally {
      mock.timers.reset();
    }
  });

  it("does not request pool-info for a market jupiter perps does not list", async () => {
    let called = false;
    const exchange = new JupiterExchange({
      fetchImpl: () => {
        called = true;
        return Promise.resolve(new Response("no", { status: 500 }));
      },
    });
    const fees = await exchange.perpsFeeSchedule(TOKEN_PAIR);
    assert.equal(called, false);
    assert.equal(fees.openFeePct, 0.0006);
    assert.equal(fees.borrowFeePctPerHour, 0.000007);
  });

  it("opens a short through jupiter perps", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/positions/increase")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              serializedTxBase64: "dHh4",
              quote: { averagePriceUsd: "100000000", sizeTokenDelta: "1000000000" },
            }),
          ),
        );
      }
      if (url.includes("/transaction/execute")) {
        return Promise.resolve(new Response(JSON.stringify({ txid: "PerpsSig" })));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    };
    const exchange = new JupiterExchange({
      keypair: Keypair.generate(),
      balances: new FakeBalances(),
      fetchImpl,
      signTransaction: (tx) => tx,
      perpsBaseUrl: "https://perps.test/v1",
    });
    const order = await exchange.execute(
      { ...sellCommand(), intent: "open-short", quoteBudgetUsdc: 10 },
      PAIR,
    );
    assert.ok(isOrder(order));
    assert.equal(order.intent, "open-short");
    assert.equal(order.price, 100);
    assert.equal(order.size, 1);
    assert.equal(order.txSignature, "PerpsSig");
    assert.ok(calls.some((call) => call.includes("/positions/increase")));
  });

  it("rejects a perps short on a market jupiter does not list", async () => {
    const exchange = new JupiterExchange({
      keypair: Keypair.generate(),
      balances: new FakeBalances(),
      fetchImpl: () => {
        throw new Error("network");
      },
      signTransaction: (tx) => tx,
    });
    const order = await exchange.execute(
      { ...sellCommand(TOKEN_PAIR.symbol), intent: "open-short", quoteBudgetUsdc: 10 },
      TOKEN_PAIR,
    );
    assert.ok(order instanceof ExchangeError);
    assert.ok(order.message.includes("no market"));
  });

  it("buys SOL for the shortfall using quote as exact-in", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.includes("/swap/v1/quote")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              inputMint: WSOL_MINT,
              outputMint: USDC,
              inAmount: "1000000000",
              outAmount: "100000000",
            }),
          ),
        );
      }
      if (url.includes("/swap/v2/order")) {
        return Promise.resolve(
          new Response(JSON.stringify({ transaction: "dGVzdA==", requestId: "req-sol" })),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "Success",
            signature: "TopUpSig",
            inputAmountResult: "2000000",
            outputAmountResult: "20000000",
          }),
        ),
      );
    };

    const exchange = new JupiterExchange({
      apiKey: "test-key",
      keypair: Keypair.generate(),
      balances: belowReserveBalances(),
      solReserveMin: 0.03,
      solReserveMax: 0.05,
      fetchImpl,
      signTransaction: (tx) => tx,
    });

    const order = await exchange.execute(
      { ...buyCommand(), intent: "buy-sol", baseSize: 0.02 },
      PAIR,
    );
    assert.ok(isOrder(order));
    assert.equal(order.intent, "buy-sol");
    assert.equal(order.txSignature, "TopUpSig");
    assert.equal(order.size, 0.02);
    const orderUrl = urls.find((url) => url.includes("/swap/v2/order"));
    assert.ok(orderUrl);
    const params = new URL(orderUrl).searchParams;
    assert.equal(params.get("inputMint"), USDC);
    assert.equal(params.get("outputMint"), WSOL_MINT);
    assert.equal(params.get("amount"), "2000000");
  });

  it("caps buy-sol at the quote balance", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.includes("/swap/v1/quote")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              inputMint: WSOL_MINT,
              outputMint: USDC,
              inAmount: "1000000000",
              outAmount: "100000000",
            }),
          ),
        );
      }
      if (url.includes("/swap/v2/order")) {
        return Promise.resolve(
          new Response(JSON.stringify({ transaction: "dGVzdA==", requestId: "req-sol" })),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "Success",
            signature: "TopUpCap",
            inputAmountResult: "1000000",
            outputAmountResult: "10000000",
          }),
        ),
      );
    };

    const balances = belowReserveBalances();
    balances.tokens.set(USDC, 1);
    const exchange = new JupiterExchange({
      apiKey: "test-key",
      keypair: Keypair.generate(),
      balances,
      fetchImpl,
      signTransaction: (tx) => tx,
    });

    const order = await exchange.execute(
      { ...buyCommand(), intent: "buy-sol", baseSize: 0.02 },
      PAIR,
    );
    assert.ok(isOrder(order));
    assert.equal(order.size, 0.01);
    const orderUrl = urls.find((url) => url.includes("/swap/v2/order"));
    assert.ok(orderUrl);
    assert.equal(new URL(orderUrl).searchParams.get("amount"), "1000000");
  });

  it("aborts buy-sol when native SOL is zero", async () => {
    const balances = new FakeBalances();
    balances.native = 0;
    const exchange = new JupiterExchange({
      apiKey: "test-key",
      keypair: Keypair.generate(),
      balances,
      fetchImpl: () => {
        throw new Error("should not quote");
      },
      signTransaction: (tx) => tx,
    });
    const order = await exchange.execute(
      { ...buyCommand(), intent: "buy-sol", baseSize: 0.05 },
      PAIR,
    );
    assert.ok(!isOrder(order));
    assert.match(order.message, /native SOL is 0/);
  });
});
