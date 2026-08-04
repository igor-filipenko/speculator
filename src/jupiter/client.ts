export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Quote asset per 1 base asset (e.g. USDC per SOL). */
  price: number;
  raw: unknown;
}

export interface JupiterClientOptions {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Minimal Jupiter Swap API client (quote only).
 * Docs: https://developers.jup.ag/docs/swap/get-quote
 */
export class JupiterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: JupiterClientOptions = {}) {
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = options.baseUrl ?? "https://api.jup.ag";
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

  /** Convenience: price of base mint in quote mint units. */
  async spotPrice(params: {
    baseMint: string;
    quoteMint: string;
    baseDecimals: number;
    quoteDecimals: number;
    /** Native base units to quote (default: 1 whole base token). */
    amountNative?: bigint;
  }): Promise<number> {
    const amount = params.amountNative ?? 10n ** BigInt(params.baseDecimals);
    const q = await this.quote({
      inputMint: params.baseMint,
      outputMint: params.quoteMint,
      amount,
      inputDecimals: params.baseDecimals,
      outputDecimals: params.quoteDecimals,
    });
    return q.price;
  }
}
