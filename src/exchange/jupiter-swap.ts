import { Keypair, VersionedTransaction } from "@solana/web3.js";
import type { Command, Exchange, Order, PairConfig } from "../types.js";
import { fillFromSwapAmounts, hasFeeSol, toAtomic, tradableBaseSize } from "./amounts.js";
import { JupiterExchange } from "./jupiter.js";
import type { BalanceSource } from "./wallet.js";

export interface JupiterOrderResponse {
  transaction: string | null;
  requestId: string;
  outAmount?: string;
  errorCode?: number;
  errorMessage?: string;
}

export interface JupiterExecuteResponse {
  status: "Success" | "Failed";
  signature?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  error?: string;
}

export interface JupiterSwapExchangeOptions {
  apiKey?: string;
  baseUrl?: string;
  keypair: Keypair;
  balances: BalanceSource;
  slippageBps?: number;
  solReserve?: number;
  fetchImpl?: typeof fetch;
  /** Override signing so tests need not deserialize a real transaction. */
  signTransaction?: (txBase64: string) => string;
}

const DEFAULT_BASE = "https://api.jup.ag";

/**
 * Live Jupiter Swap API V2 exchange: sized `/swap/v2/order`, sign, `/swap/v2/execute`.
 * Docs: https://developers.jup.ag/docs/swap/order-and-execute
 */
export class JupiterSwapExchange implements Exchange {
  private readonly quotes: JupiterExchange;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly keypair: Keypair;
  private readonly balances: BalanceSource;
  private readonly slippageBps: number;
  private readonly solReserve: number;
  private readonly fetchImpl: typeof fetch;
  private readonly signTransaction: (txBase64: string) => string;

  constructor(options: JupiterSwapExchangeOptions) {
    const quoteOpts: { apiKey?: string; baseUrl?: string } = {};
    if (options.apiKey !== undefined) {
      quoteOpts.apiKey = options.apiKey;
    }
    if (options.baseUrl !== undefined) {
      quoteOpts.baseUrl = options.baseUrl;
    }
    this.quotes = new JupiterExchange(quoteOpts);
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE;
    this.keypair = options.keypair;
    this.balances = options.balances;
    this.slippageBps = options.slippageBps ?? 50;
    this.solReserve = options.solReserve ?? 0.05;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.signTransaction = options.signTransaction ?? ((tx) => signVersionedTx(tx, this.keypair));
  }

  async spotPrice(pair: PairConfig): Promise<number> {
    return this.quotes.spotPrice(pair);
  }

  async execute(command: Command, pair: PairConfig): Promise<Order | null> {
    try {
      await this.balances.refresh([pair.baseMint, pair.quoteMint]);
      if (!hasFeeSol(this.balances.nativeSol(), this.solReserve)) {
        console.error(`[${pair.symbol}] abort swap: native SOL below reserve ${this.solReserve}`);
        return null;
      }

      const amount = this.atomicInAmount(command, pair);
      if (amount <= 0n) {
        console.error(`[${pair.symbol}] abort swap: atomic amount is 0`);
        return null;
      }

      const inputMint = command.side === "BUY" ? pair.quoteMint : pair.baseMint;
      const outputMint = command.side === "BUY" ? pair.baseMint : pair.quoteMint;

      const order = await this.fetchOrder({
        inputMint,
        outputMint,
        amount,
        taker: this.keypair.publicKey.toBase58(),
      });
      if (!order.transaction) {
        console.error(
          `[${pair.symbol}] Jupiter /order has no transaction` +
            (order.errorMessage !== undefined ? `: ${order.errorMessage}` : ""),
        );
        return null;
      }

      const signed = this.signTransaction(order.transaction);
      const result = await this.fetchExecute(signed, order.requestId);
      if (result.status !== "Success") {
        console.error(
          `[${pair.symbol}] Jupiter /execute failed` +
            (result.error !== undefined ? `: ${result.error}` : ""),
        );
        return null;
      }

      const inputAmount = parseAmount(result.inputAmountResult ?? result.totalInputAmount);
      const outputAmount = parseAmount(result.outputAmountResult ?? result.totalOutputAmount);
      const fill = fillFromSwapAmounts({
        side: command.side,
        inputAmount,
        outputAmount,
        baseDecimals: pair.baseDecimals,
        quoteDecimals: pair.quoteDecimals,
      });
      if (!fill) {
        console.error(`[${pair.symbol}] Jupiter execute returned unusable fill amounts`);
        return null;
      }

      const filled: Order = {
        pair: command.pair,
        side: command.side,
        price: fill.price,
        size: fill.size,
        at: command.at,
        simulated: false,
        reason: command.reason,
        priorityFeeUsdc: 0,
      };
      if (result.signature !== undefined && result.signature.length > 0) {
        filled.txSignature = result.signature;
      }
      return filled;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${pair.symbol}] swap failed: ${message}`);
      return null;
    }
  }

  private atomicInAmount(command: Command, pair: PairConfig): bigint {
    if (command.side === "BUY") {
      return toAtomic(command.quoteBudgetUsdc ?? 0, pair.quoteDecimals);
    }

    const requested = command.baseSize ?? 0;
    const tokenUi = this.balances.tokenUi(pair.baseMint);
    const tradable = tradableBaseSize({
      baseMint: pair.baseMint,
      tokenUi,
      nativeSol: this.balances.nativeSol(),
      reserveSol: this.solReserve,
    });
    return toAtomic(Math.min(requested, tradable), pair.baseDecimals);
  }

  private async fetchOrder(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    taker: string;
  }): Promise<JupiterOrderResponse> {
    const url = new URL(`${this.baseUrl}/swap/v2/order`);
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount.toString());
    url.searchParams.set("taker", params.taker);
    url.searchParams.set("slippageBps", String(this.slippageBps));

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jupiter /order failed (${response.status}): ${body.slice(0, 300)}`);
    }
    return (await response.json()) as JupiterOrderResponse;
  }

  private async fetchExecute(
    signedTransaction: string,
    requestId: string,
  ): Promise<JupiterExecuteResponse> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/swap/v2/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ signedTransaction, requestId }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jupiter /execute failed (${response.status}): ${body.slice(0, 300)}`);
    }
    return (await response.json()) as JupiterExecuteResponse;
  }
}

export function signVersionedTx(txBase64: string, keypair: Keypair): string {
  const transaction = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  transaction.sign([keypair]);
  return Buffer.from(transaction.serialize()).toString("base64");
}

function parseAmount(raw: string | undefined): bigint {
  if (raw === undefined || raw === "") {
    return 0n;
  }
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}
