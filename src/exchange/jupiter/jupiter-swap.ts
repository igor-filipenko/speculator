import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { ExchangeError } from "../error.js";
import type {
  BalanceSource,
  Command,
  Error,
  Exchange,
  OpenPosition,
  Order,
  PairConfig,
  PositionSource,
} from "../../types.js";
import {
  fillFromSwapAmounts,
  hasFeeSol,
  toAtomic,
  tradableBaseSize,
  WSOL_MINT,
} from "./amounts.js";
import { JupiterExchange } from "./jupiter.js";
import { JupiterPerpsClient } from "./perps.js";

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
  perpsBaseUrl?: string;
  /** Override signing so tests need not deserialize a real transaction. */
  signTransaction?: (txBase64: string) => string;
}

const DEFAULT_BASE = "https://api.jup.ag";

/**
 * Live Jupiter Swap API V2 exchange: sized `/swap/v2/order`, sign, `/swap/v2/execute`.
 * Docs: https://developers.jup.ag/docs/swap/order-and-execute
 */
export class JupiterSwapExchange implements Exchange, PositionSource {
  private readonly quotes: JupiterExchange;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly keypair: Keypair;
  private readonly balances: BalanceSource;
  private readonly slippageBps: number;
  private readonly solReserve: number;
  private readonly fetchImpl: typeof fetch;
  private readonly signTransaction: (txBase64: string) => string;
  private readonly perps: JupiterPerpsClient;

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
    const perpsOpts: { fetchImpl: typeof fetch; baseUrl?: string } = { fetchImpl: this.fetchImpl };
    if (options.perpsBaseUrl !== undefined) {
      perpsOpts.baseUrl = options.perpsBaseUrl;
    }
    this.perps = new JupiterPerpsClient(perpsOpts);
  }

  async spotPrice(pair: PairConfig): Promise<number> {
    return this.quotes.spotPrice(pair);
  }

  /** On-chain Jupiter Perps short, if one is open for this pair. */
  async findOpenPosition(pair: PairConfig): Promise<OpenPosition | null> {
    return this.perps.findOpenShortPosition(this.keypair.publicKey.toBase58(), pair);
  }

  async execute(command: Command, pair: PairConfig): Promise<Order | Error> {
    try {
      if (command.intent === "open-short" || command.intent === "close-short") {
        return await this.executeShort(command, pair);
      }
      return await this.executeSpot(command, pair);
    } catch (err) {
      const message = err instanceof globalThis.Error ? err.message : String(err);
      return new ExchangeError(message);
    }
  }

  private async executeSpot(command: Command, pair: PairConfig): Promise<Order | Error> {
    await this.balances.refresh([pair.baseMint, pair.quoteMint]);
    const wantToBySol = command.side === "BUY" && pair.baseMint === WSOL_MINT;
    if (!wantToBySol && !hasFeeSol(this.balances.nativeSol(), this.solReserve)) {
      return new ExchangeError(`abort swap: native SOL below reserve ${this.solReserve}`);
    }

    const amount = this.atomicInAmount(command, pair);
    if (amount <= 0n) {
      return new ExchangeError("abort swap: atomic amount is 0");
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
      const detail = order.errorMessage !== undefined ? `: ${order.errorMessage}` : "";
      return new ExchangeError(`Jupiter /order has no transaction${detail}`);
    }

    const signed = this.signTransaction(order.transaction);
    const result = await this.fetchExecute(signed, order.requestId);
    if (result.status !== "Success") {
      const detail = result.error !== undefined ? `: ${result.error}` : "";
      return new ExchangeError(`Jupiter /execute failed${detail}`);
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
      return new ExchangeError("Jupiter execute returned unusable fill amounts");
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
  }

  private async executeShort(command: Command, pair: PairConfig): Promise<Order | Error> {
    if (!hasFeeSol(this.balances.nativeSol(), this.solReserve)) {
      return new ExchangeError(`abort perps: native SOL below reserve ${this.solReserve}`);
    }
    const wallet = this.keypair.publicKey.toBase58();
    if (command.intent === "open-short") {
      const amount = toAtomic(command.quoteBudgetUsdc ?? 0, pair.quoteDecimals);
      if (amount <= 0n) {
        return new ExchangeError("abort perps short: atomic amount is 0");
      }
      const opened = await this.perps.increaseShort({
        walletAddress: wallet,
        pair,
        inputTokenAmount: amount.toString(),
        maxSlippageBps: this.slippageBps,
      });
      const signed = this.signTransaction(opened.serializedTxBase64);
      const txid = await this.perps.execute("increase-position", signed);
      if (!(opened.price > 0) || !(opened.size > 0)) {
        return new ExchangeError("jupiter perps increase returned unusable fill");
      }
      return this.filledShort(command, opened.price, opened.size, txid);
    }

    const closed = await this.perps.decreaseShort({
      walletAddress: wallet,
      pair,
      maxSlippageBps: this.slippageBps,
    });
    const signed = this.signTransaction(closed.serializedTxBase64);
    const txid = await this.perps.execute("decrease-position", signed);
    const size = command.baseSize ?? 0;
    const price = command.priceHint ?? 0;
    if (!(price > 0) || !(size > 0)) {
      return new ExchangeError("jupiter perps decrease has no size or price");
    }
    return this.filledShort(command, price, size, txid);
  }

  private filledShort(
    command: Command,
    price: number,
    size: number,
    txid: string | undefined,
  ): Order {
    const filled: Order = {
      pair: command.pair,
      side: command.side,
      price,
      size,
      at: command.at,
      simulated: false,
      reason: command.reason,
      priorityFeeUsdc: 0,
    };
    if (txid !== undefined && txid.length > 0) {
      filled.txSignature = txid;
    }
    return filled;
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
