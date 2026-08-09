import type { Command, Exchange, Order, PairConfig } from "../types.js";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Quote asset per 1 base asset (e.g. USDC per SOL). */
  price: number;
  raw: unknown;
}

export interface JupiterExchangeOptions {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Live Jupiter Swap API exchange (quote only — no on-chain swaps).
 * Docs: https://developers.jup.ag/docs/swap/get-quote
 */
export class JupiterExchange implements Exchange {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: JupiterExchangeOptions = {}) {
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = options.baseUrl ?? "https://api.jup.ag";
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

  /**
   * Simulate a fill at the current Jupiter spot (paper trading).
   * Does not submit an on-chain swap.
   */
  async execute(command: Command, pair: PairConfig): Promise<Order> {
    const price = await this.spotPrice(pair);
    if (!(price > 0)) {
      throw new Error(`JupiterExchange: invalid spot price ${price} for ${pair.symbol}`);
    }

    if (command.side === "BUY") {
      const budget = command.quoteBudgetUsdc ?? 0;
      if (budget <= 0) {
        throw new Error(`JupiterExchange: BUY requires quoteBudgetUsdc > 0`);
      }
      return {
        pair: command.pair,
        side: "BUY",
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
      throw new Error(`JupiterExchange: SELL requires baseSize > 0`);
    }
    return {
      pair: command.pair,
      side: "SELL",
      price,
      size,
      at: command.at,
      simulated: true,
      reason: command.reason,
      priorityFeeUsdc: 0,
    };
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
    url.searchParams.set("slippageBps", String(params.slippageBps ?? 50));

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const response = await fetch(url, { headers });
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
}
