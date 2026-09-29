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
import { JupiterPerpsClient } from "./perps.js";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Quote asset per 1 base asset (e.g. USDC per SOL). */
  price: number;
  raw: unknown;
}

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

export interface JupiterExchangeOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Present for live fills. Absent keeps paper/watch on a simulated quote fill. */
  keypair?: Keypair;
  balances?: BalanceSource;
  slippageBps?: number;
  /** Abort other swaps and perps when native SOL is below this. */
  solReserveMin?: number;
  /** SOL below this is not sold. Tradable size subtracts it. */
  solReserveMax?: number;
  fetchImpl?: typeof fetch;
  perpsBaseUrl?: string;
  /** Override signing so tests need not deserialize a real transaction. */
  signTransaction?: (txBase64: string) => string;
}

const DEFAULT_BASE = "https://api.jup.ag";

/**
 * Jupiter exchange. Without a keypair, `execute` is a simulated quote fill.
 * With a keypair: `open-long` buys spot, `close-long` sells spot, shorts use Jupiter Perps,
 * and `buy-sol` tops up native SOL from the pair quote.
 */
export class JupiterExchange implements Exchange, PositionSource {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly keypair: Keypair | undefined;
  private readonly balances: BalanceSource | undefined;
  private readonly slippageBps: number;
  private readonly solReserveMin: number;
  private readonly solReserveMax: number;
  private readonly fetchImpl: typeof fetch;
  private readonly signTransaction: ((txBase64: string) => string) | undefined;
  private readonly perps: JupiterPerpsClient;

  constructor(options: JupiterExchangeOptions = {}) {
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE;
    this.keypair = options.keypair;
    this.balances = options.balances;
    this.slippageBps = options.slippageBps ?? 50;
    this.solReserveMin = options.solReserveMin ?? 0.03;
    this.solReserveMax = options.solReserveMax ?? 0.05;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (options.keypair !== undefined) {
      const keypair = options.keypair;
      this.signTransaction = options.signTransaction ?? ((tx) => signVersionedTx(tx, keypair));
    }
    const perpsOpts: { fetchImpl: typeof fetch; baseUrl?: string } = { fetchImpl: this.fetchImpl };
    if (options.perpsBaseUrl !== undefined) {
      perpsOpts.baseUrl = options.perpsBaseUrl;
    }
    this.perps = new JupiterPerpsClient(perpsOpts);

    if (!options.apiKey) {
      console.warn("Warning: JUPITER_API_KEY is empty; quotes may fail or be rate-limited.");
    }
    if (options.keypair !== undefined && options.balances === undefined) {
      throw new Error("JupiterExchange live mode requires balances");
    }
  }

  async spotPrice(pair: PairConfig): Promise<number> {
    const amount = 10n ** BigInt(pair.baseDecimals);
    const q = await this.quote({
      inputMint: pair.baseMint,
      outputMint: pair.quoteMint,
      amount,
      inputDecimals: pair.baseDecimals,
      outputDecimals: pair.quoteDecimals,
    });
    return q.price;
  }

  /** On-chain Jupiter Perps short, if one is open for this pair. */
  async findOpenPosition(pair: PairConfig): Promise<OpenPosition | null> {
    if (this.keypair === undefined) {
      return null;
    }
    return this.perps.findOpenShortPosition(this.keypair.publicKey.toBase58(), pair);
  }

  async execute(command: Command, pair: PairConfig): Promise<Order | Error> {
    if (command.orderType !== "market") {
      return new ExchangeError(`JupiterExchange: ${command.orderType} orders are not supported`);
    }
    if (this.keypair === undefined || this.balances === undefined) {
      return this.executeSimulated(command, pair);
    }
    try {
      switch (command.intent) {
        case "open-long":
          return await this.executeSpot(command, pair, "BUY");
        case "close-long":
          return await this.executeSpot(command, pair, "SELL");
        case "open-short":
        case "close-short":
          return await this.executeShort(command, pair);
        case "buy-sol":
          return await this.executeBuySol(command, pair);
      }
    } catch (err) {
      const message = err instanceof globalThis.Error ? err.message : String(err);
      return new ExchangeError(message);
    }
  }

  /**
   * Get a swap quote and derive a spot price in quote-per-base units.
   */
  async quote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps?: number;
    inputDecimals: number;
    outputDecimals: number;
  }): Promise<JupiterQuote> {
    const url = new URL(`${this.baseUrl}/swap/v1/quote`);
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount.toString());
    url.searchParams.set("slippageBps", String(params.slippageBps ?? this.slippageBps));

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jupiter quote failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const raw = (await response.json()) as {
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      error?: string;
    };

    if (raw.error) {
      throw new Error(`Jupiter quote error: ${raw.error}`);
    }

    const inAmount = BigInt(raw.inAmount);
    const outAmount = BigInt(raw.outAmount);
    const inUi = Number(inAmount) / 10 ** params.inputDecimals;
    const outUi = Number(outAmount) / 10 ** params.outputDecimals;

    if (inUi <= 0) {
      throw new Error("Jupiter quote returned zero input amount");
    }

    return {
      inputMint: raw.inputMint,
      outputMint: raw.outputMint,
      inAmount,
      outAmount,
      price: outUi / inUi,
      raw,
    };
  }

  /** Simulate a fill at the current Jupiter spot. Does not submit an on-chain swap. */
  private async executeSimulated(command: Command, pair: PairConfig): Promise<Order | Error> {
    if (command.intent === "buy-sol") {
      return new ExchangeError("JupiterExchange: buy-sol is live only");
    }

    let price: number;
    try {
      price = await this.spotPrice(pair);
    } catch (err) {
      const message = err instanceof globalThis.Error ? err.message : String(err);
      return new ExchangeError(message);
    }
    if (!(price > 0)) {
      return new ExchangeError(`JupiterExchange: invalid spot price ${price} for ${pair.symbol}`);
    }

    const opens = command.intent === "open-long" || command.intent === "open-short";
    if (opens) {
      const budget = command.quoteBudgetUsdc ?? 0;
      if (budget <= 0) {
        return new ExchangeError("JupiterExchange: open requires quoteBudgetUsdc > 0");
      }
      return {
        pair: command.pair,
        type: "market",
        intent: command.intent,
        price,
        size: budget / price,
        at: command.at,
        simulated: true,
        reason: command.reason,
        priorityFeeUsdc: 0,
      };
    }

    const size = command.baseSize ?? 0;
    if (size <= 0) {
      return new ExchangeError("JupiterExchange: close requires baseSize > 0");
    }
    return {
      pair: command.pair,
      type: "market",
      intent: command.intent,
      price,
      size,
      at: command.at,
      simulated: true,
      reason: command.reason,
      priorityFeeUsdc: 0,
    };
  }

  private async executeSpot(
    command: Command,
    pair: PairConfig,
    side: "BUY" | "SELL",
  ): Promise<Order | Error> {
    const balances = this.requireBalances();
    await balances.refresh([pair.baseMint, pair.quoteMint]);
    const buyingSol = side === "BUY" && pair.baseMint === WSOL_MINT;
    if (!buyingSol && !hasFeeSol(balances.nativeSol(), this.solReserveMin)) {
      return new ExchangeError(`abort swap: native SOL below reserve ${this.solReserveMin}`);
    }

    const amount = this.atomicInAmount(command, pair, side);
    if (amount <= 0n) {
      return new ExchangeError("abort swap: atomic amount is 0");
    }

    return this.submitSwap({
      command,
      side,
      inputMint: side === "BUY" ? pair.quoteMint : pair.baseMint,
      outputMint: side === "BUY" ? pair.baseMint : pair.quoteMint,
      amount,
      baseDecimals: pair.baseDecimals,
      quoteDecimals: pair.quoteDecimals,
    });
  }

  /**
   * Buy native SOL with the pair quote so the fee reserve reaches the target.
   * Skips the minimum-reserve abort; still needs dust SOL to pay the fee.
   */
  private async executeBuySol(command: Command, pair: PairConfig): Promise<Order | Error> {
    const balances = this.requireBalances();
    await balances.refresh([WSOL_MINT, pair.quoteMint]);
    if (!(balances.nativeSol() > 0)) {
      return new ExchangeError("abort buy-sol: native SOL is 0, cannot pay transaction fee");
    }

    const solSize = command.baseSize ?? 0;
    if (!(solSize > 0)) {
      return new ExchangeError("abort buy-sol: baseSize must be > 0");
    }

    const quoted = await this.quote({
      inputMint: WSOL_MINT,
      outputMint: pair.quoteMint,
      amount: 10n ** 9n,
      inputDecimals: 9,
      outputDecimals: pair.quoteDecimals,
    });
    if (!(quoted.price > 0)) {
      return new ExchangeError("abort buy-sol: SOL price is 0");
    }

    const available = balances.tokenUi(pair.quoteMint);
    if (!(available > 0)) {
      return new ExchangeError("abort buy-sol: quote balance is 0");
    }

    const amount = toAtomic(Math.min(solSize * quoted.price, available), pair.quoteDecimals);
    if (amount <= 0n) {
      return new ExchangeError("abort buy-sol: quote amount is 0");
    }

    return this.submitSwap({
      command,
      side: "BUY",
      inputMint: pair.quoteMint,
      outputMint: WSOL_MINT,
      amount,
      baseDecimals: 9,
      quoteDecimals: pair.quoteDecimals,
    });
  }

  private async submitSwap(params: {
    command: Command;
    side: "BUY" | "SELL";
    inputMint: string;
    outputMint: string;
    amount: bigint;
    baseDecimals: number;
    quoteDecimals: number;
  }): Promise<Order | Error> {
    const order = await this.fetchOrder({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      taker: this.requireKeypair().publicKey.toBase58(),
    });
    if (!order.transaction) {
      const detail = order.errorMessage !== undefined ? `: ${order.errorMessage}` : "";
      return new ExchangeError(`Jupiter /order has no transaction${detail}`);
    }

    const signed = this.requireSigner()(order.transaction);
    const result = await this.fetchExecute(signed, order.requestId);
    if (result.status !== "Success") {
      const detail = result.error !== undefined ? `: ${result.error}` : "";
      return new ExchangeError(`Jupiter /execute failed${detail}`);
    }

    const inputAmount = parseAmount(result.inputAmountResult ?? result.totalInputAmount);
    const outputAmount = parseAmount(result.outputAmountResult ?? result.totalOutputAmount);
    const fill = fillFromSwapAmounts({
      side: params.side,
      inputAmount,
      outputAmount,
      baseDecimals: params.baseDecimals,
      quoteDecimals: params.quoteDecimals,
    });
    if (!fill) {
      return new ExchangeError("Jupiter execute returned unusable fill amounts");
    }

    const filled: Order = {
      pair: params.command.pair,
      type: "market",
      intent: params.command.intent,
      price: fill.price,
      size: fill.size,
      at: params.command.at,
      simulated: false,
      reason: params.command.reason,
      priorityFeeUsdc: 0,
    };
    if (result.signature !== undefined && result.signature.length > 0) {
      filled.txSignature = result.signature;
    }
    return filled;
  }

  private async executeShort(command: Command, pair: PairConfig): Promise<Order | Error> {
    const balances = this.requireBalances();
    if (!hasFeeSol(balances.nativeSol(), this.solReserveMin)) {
      const nativeSol = balances.nativeSol();
      return new ExchangeError(
        `abort perps: native SOL ${nativeSol} below reserve ${this.solReserveMin}`,
      );
    }
    const wallet = this.requireKeypair().publicKey.toBase58();
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
      const signed = this.requireSigner()(opened.serializedTxBase64);
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
    const signed = this.requireSigner()(closed.serializedTxBase64);
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
      type: "market",
      intent: command.intent,
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

  private atomicInAmount(command: Command, pair: PairConfig, side: "BUY" | "SELL"): bigint {
    if (side === "BUY") {
      return toAtomic(command.quoteBudgetUsdc ?? 0, pair.quoteDecimals);
    }
    const balances = this.requireBalances();
    const requested = command.baseSize ?? 0;
    const tradable = tradableBaseSize({
      baseMint: pair.baseMint,
      tokenUi: balances.tokenUi(pair.baseMint),
      nativeSol: balances.nativeSol(),
      reserveSol: this.solReserveMax,
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

  private requireKeypair(): Keypair {
    if (this.keypair === undefined) {
      throw new ExchangeError("JupiterExchange live mode requires a keypair");
    }
    return this.keypair;
  }

  private requireBalances(): BalanceSource {
    if (this.balances === undefined) {
      throw new ExchangeError("JupiterExchange live mode requires balances");
    }
    return this.balances;
  }

  private requireSigner(): (txBase64: string) => string {
    if (this.signTransaction === undefined) {
      throw new ExchangeError("JupiterExchange live mode requires a signer");
    }
    return this.signTransaction;
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
