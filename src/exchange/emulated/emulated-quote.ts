/**
 * Simulated exchange fill pricing from GeckoTerminal candle close.
 * Jupiter-like fee/slippage model — used only for offline backtests.
 */

export type LiquidityTier = "liquid" | "meme";

export interface TierCostParams {
  /** Fractional slippage (e.g. 0.003 = 0.30%). */
  slippage: number;
  /** Fractional pool fee (e.g. 0.0025 = 0.25%). */
  poolFee: number;
}

/** Realistic defaults for Jupiter swaps at small/medium sizes. */
export const TIER_COSTS: Record<LiquidityTier, TierCostParams> = {
  liquid: { slippage: 0.0005, poolFee: 0.0004 },
  meme: { slippage: 0.008, poolFee: 0.0025 },
};

/** Priority fee paid per fill, in SOL (mid of ~0.000005–0.001). */
export const PRIORITY_FEE_SOL = 0.0001;

export interface EmulateFillPriceInput {
  side: "BUY" | "SELL";
  /** Candle close used as mid. */
  close: number;
  tier?: LiquidityTier;
  /** Override priority fee in SOL (default {@link PRIORITY_FEE_SOL}). */
  priorityFeeSol?: number;
}

export interface EmulatedFillBreakdown {
  mid: number;
  slippage: number;
  poolFee: number;
  /** Combined fractional adverse cost applied to mid (slippage + poolFee). */
  adverseFraction: number;
  priorityFeeSol: number;
  priorityFeeUsdc: number;
  /** Slippage cost in USDC per 1 base unit at mid (informational). */
  slippageUsdcPerBase: number;
  /** Pool fee in USDC per 1 base unit at mid (informational). */
  poolFeeUsdcPerBase: number;
}

export interface EmulatedFill {
  /** Adverse fill price (worse than mid for both sides). */
  fillPrice: number;
  /** Network priority fee converted to USDC via candle close. */
  priorityFeeUsdc: number;
  breakdown: EmulatedFillBreakdown;
}

/**
 * Emulate a Jupiter swap fill from candle close + tier costs.
 * BUY pays above mid; SELL receives below mid. Priority fee is separate USDC.
 */
export function emulateFillPrice(input: EmulateFillPriceInput): EmulatedFill {
  const { side, close } = input;
  if (!(close > 0) || !Number.isFinite(close)) {
    throw new Error(`emulateFillPrice: invalid close ${close}`);
  }

  const tier = input.tier ?? "liquid";
  const costs = TIER_COSTS[tier];
  const priorityFeeSol = input.priorityFeeSol ?? PRIORITY_FEE_SOL;
  const adverseFraction = costs.slippage + costs.poolFee;

  const fillPrice = side === "BUY" ? close * (1 + adverseFraction) : close * (1 - adverseFraction);

  const priorityFeeUsdc = priorityFeeSol * close;

  return {
    fillPrice,
    priorityFeeUsdc,
    breakdown: {
      mid: close,
      slippage: costs.slippage,
      poolFee: costs.poolFee,
      adverseFraction,
      priorityFeeSol,
      priorityFeeUsdc,
      slippageUsdcPerBase: close * costs.slippage,
      poolFeeUsdcPerBase: close * costs.poolFee,
    },
  };
}

/** Map known pair symbols to liquidity tier (v1: SOL/USDC is liquid). */
export function liquidityTierForPair(symbol: string): LiquidityTier {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === "SOL/USDC") {
    return "liquid";
  }
  return "meme";
}
