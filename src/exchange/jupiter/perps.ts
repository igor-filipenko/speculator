import { z } from "zod";
import { ExchangeError } from "../error.js";
import { fromAtomic } from "./amounts.js";
import type { OpenPosition, PairConfig } from "../../types.js";

/** Jupiter Perps markets. https://perps-api.jup.ag/v1 */
type PerpsAsset = "SOL" | "ETH" | "BTC";

const DEFAULT_BASE = "https://perps-api.jup.ag/v1";
/** USD fields on the perps API are integers scaled by 1e6. */
const USD_SCALE = 1_000_000;

const quoteSchema = z.object({
  averagePriceUsd: z.string().optional(),
  sizeTokenDelta: z.string().optional(),
});

const increaseSchema = z.object({
  serializedTxBase64: z.string().min(1),
  positionPubkey: z.string().optional(),
  quote: quoteSchema.optional(),
});

const decreaseQuoteSchema = z.object({
  pnlAfterFeesUsd: z.string().optional(),
  sizeUsdDelta: z.string().optional(),
  transferAmountUsd: z.string().optional(),
});

const decreaseSchema = z.object({
  serializedTxBase64: z.string().min(1),
  quote: decreaseQuoteSchema.optional(),
});

const executeSchema = z.object({
  txid: z.string().optional(),
});

const positionSchema = z.object({
  positionPubkey: z.string(),
  asset: z.string().optional(),
  assetMint: z.string().optional(),
  marketMint: z.string().optional(),
  side: z.string(),
  leverage: z.string().optional(),
  sizeUsd: z.string().optional(),
  sizeTokenAmount: z.string(),
  entryPriceUsd: z.string(),
  markPriceUsd: z.string().optional(),
  liquidationPriceUsd: z.string().optional(),
  collateralUsd: z.string().optional(),
  pnlAfterFeesUsd: z.string().optional(),
});

const positionsSchema = z.object({
  dataList: z.array(positionSchema),
});

/** One open Jupiter Perps position, amounts in UI units. */
export interface ListedPerpsPosition {
  positionPubkey: string;
  asset: string;
  side: string;
  leverage: string;
  sizeToken: number;
  sizeUsd: number;
  collateralUsd: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  pnlUsd: number;
}

export interface JupiterPerpsClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Thin client for the Jupiter Perps HTTP API used by jupiter-perps-api-sdk.
 * Longs stay on the spot swap; this client only opens and closes shorts.
 */
export class JupiterPerpsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JupiterPerpsClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async increaseShort(input: {
    walletAddress: string;
    pair: PairConfig;
    inputTokenAmount: string;
    maxSlippageBps: number;
  }): Promise<{ serializedTxBase64: string; price: number; size: number }> {
    const asset = assetFor(input.pair);
    const body = await this.post("/positions/increase", {
      walletAddress: input.walletAddress,
      asset,
      inputToken: "USDC",
      inputTokenAmount: input.inputTokenAmount,
      side: "short",
      leverage: "1.1",
      maxSlippageBps: String(input.maxSlippageBps),
    });
    const parsed = increaseSchema.parse(body);
    const price = usd(parsed.quote?.averagePriceUsd);
    const size = fromAtomic(parseAmount(parsed.quote?.sizeTokenDelta), input.pair.baseDecimals);
    return { serializedTxBase64: parsed.serializedTxBase64, price, size };
  }

  async decreaseShort(input: {
    walletAddress: string;
    pair: PairConfig;
    maxSlippageBps: number;
  }): Promise<{
    serializedTxBase64: string;
    pnlUsd: number;
    sizeUsd: number;
    transferUsd: number;
  }> {
    const open = await this.findShort(input.walletAddress, input.pair);
    if (open == null) {
      throw new ExchangeError(`no jupiter perps short for ${input.pair.symbol}`);
    }
    const body = await this.post("/positions/decrease", {
      positionPubkey: open.positionPubkey,
      receiveToken: "USDC",
      entirePosition: true,
      maxSlippageBps: String(input.maxSlippageBps),
    });
    const parsed = decreaseSchema.parse(body);
    return {
      serializedTxBase64: parsed.serializedTxBase64,
      pnlUsd: usd(parsed.quote?.pnlAfterFeesUsd),
      sizeUsd: usd(parsed.quote?.sizeUsdDelta),
      transferUsd: usd(parsed.quote?.transferAmountUsd),
    };
  }

  async listPositions(walletAddress: string): Promise<ListedPerpsPosition[]> {
    const url = new URL(`${this.baseUrl}/positions`);
    url.searchParams.set("walletAddress", walletAddress);
    const body = await this.send(url, { method: "GET" });
    const parsed = positionsSchema.parse(body);
    return parsed.dataList.map((row) => toListedPosition(row));
  }

  async execute(
    action: "increase-position" | "decrease-position",
    serializedTxBase64: string,
  ): Promise<string | undefined> {
    const body = await this.post("/transaction/execute", { action, serializedTxBase64 });
    return executeSchema.parse(body).txid;
  }

  async findOpenShortPosition(
    walletAddress: string,
    pair: PairConfig,
  ): Promise<OpenPosition | null> {
    const found = await this.findShort(walletAddress, pair);
    if (found == null) {
      return null;
    }
    return {
      size: found.size,
      entryPrice: found.entryPrice,
      collateralUsd: found.collateralUsd,
    };
  }

  private async findShort(
    walletAddress: string,
    pair: PairConfig,
  ): Promise<(OpenPosition & { positionPubkey: string }) | null> {
    const asset = assetFor(pair);
    const url = new URL(`${this.baseUrl}/positions`);
    url.searchParams.set("walletAddress", walletAddress);
    const body = await this.send(url, { method: "GET" });
    const parsed = positionsSchema.parse(body);
    const match = parsed.dataList.find(
      (row) => row.side.toLowerCase() === "short" && rowMatchesAsset(row, asset, pair),
    );
    if (match == null) {
      return null;
    }
    const size = fromAtomic(parseAmount(match.sizeTokenAmount), pair.baseDecimals);
    if (!(size > 0)) {
      return null;
    }
    return {
      positionPubkey: match.positionPubkey,
      size,
      entryPrice: usd(match.entryPriceUsd),
      collateralUsd: usd(match.collateralUsd),
    };
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    return this.send(new URL(`${this.baseUrl}${path}`), {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  private async send(url: URL, init: { method: string; body?: string }): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-perps-api-version": "v2",
    };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const request: RequestInit = { method: init.method, headers };
    if (init.body !== undefined) {
      request.body = init.body;
    }
    const response = await this.fetchImpl(url, request);
    const text = await response.text();
    if (!response.ok) {
      throw new ExchangeError(
        `jupiter perps ${url.pathname} failed (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    if (text.length === 0) {
      return {};
    }
    return JSON.parse(text) as unknown;
  }
}

function assetFor(pair: PairConfig): PerpsAsset {
  const base = pair.symbol.split("/")[0]?.toUpperCase();
  if (base === "SOL" || base === "ETH" || base === "BTC") {
    return base;
  }
  throw new ExchangeError(`jupiter perps has no market for ${pair.symbol}`);
}

function rowMatchesAsset(
  row: z.infer<typeof positionSchema>,
  asset: PerpsAsset,
  pair: PairConfig,
): boolean {
  const labeled = row.asset?.toUpperCase();
  if (labeled === "SOL" || labeled === "ETH" || labeled === "BTC") {
    return labeled === asset;
  }
  const mint = row.assetMint ?? row.marketMint;
  if (mint === undefined || mint.length === 0) {
    return asset === pair.symbol.split("/")[0]?.toUpperCase();
  }
  return mint === pair.baseMint;
}

function labeledAsset(row: z.infer<typeof positionSchema>): string {
  const named = row.asset?.toUpperCase();
  if (named !== undefined && named.length > 0) {
    return named;
  }
  return assetFromMint(row.assetMint ?? row.marketMint) ?? "?";
}

function toListedPosition(row: z.infer<typeof positionSchema>): ListedPerpsPosition {
  const asset = labeledAsset(row);
  return {
    positionPubkey: row.positionPubkey,
    asset,
    side: row.side.toLowerCase(),
    leverage: row.leverage ?? "",
    sizeToken: fromAtomic(parseAmount(row.sizeTokenAmount), decimalsForAsset(asset)),
    sizeUsd: usd(row.sizeUsd),
    collateralUsd: usd(row.collateralUsd),
    entryPrice: usd(row.entryPriceUsd),
    markPrice: usd(row.markPriceUsd),
    liquidationPrice: usd(row.liquidationPriceUsd),
    pnlUsd: usd(row.pnlAfterFeesUsd),
  };
}

function assetFromMint(mint: string | undefined): PerpsAsset | undefined {
  if (mint === "So11111111111111111111111111111111111111112") {
    return "SOL";
  }
  if (mint === "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs") {
    return "ETH";
  }
  if (mint === "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh") {
    return "BTC";
  }
  return undefined;
}

function decimalsForAsset(asset: string): number {
  if (asset === "SOL") {
    return 9;
  }
  if (asset === "ETH" || asset === "BTC") {
    return 8;
  }
  return 0;
}

function usd(raw: string | undefined): number {
  const amount = parseAmount(raw);
  return Number(amount) / USD_SCALE;
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
