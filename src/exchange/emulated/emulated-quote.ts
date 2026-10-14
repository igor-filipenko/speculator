/**
 * Simulated exchange fill pricing from GeckoTerminal candle close.
 * Jupiter-like fee/slippage model — used only for offline backtests.
 * Spot legs pay pool fee + slippage. Perps shorts pay slippage only here;
 * open, close, and borrow fees are applied from {@link JUPITER_PERPS_FEES}.
 */

import { JUPITER_PERPS_FEES } from "../jupiter/perps-fees.js";
import type { PerpsFees } from "../../types.js";

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

/**
 * AMM price-impact scale per tier: `impact = tradeUsdc / candleVolumeUsdc * SCALE`.
 * Derived from constant-product model: liquid pools hold ~20× candle volume in reserves,
 * meme pools ~5×. Impact = trade / (2 × reserves).
 */
export const VOLUME_IMPACT_SCALE: Record<LiquidityTier, number> = {
  liquid: 1 / 40, // reserves ≈ 20× candle vol → impact = trade / (2 × 20 × vol)
  meme: 1 / 10, // reserves ≈  5× candle vol → impact = trade / (2 ×  5 × vol)
};

/** Maximum additional slippage from volume impact, per tier. */
export const MAX_VOLUME_IMPACT: Record<LiquidityTier, number> = {
  liquid: 0.01, // 1 %
  meme: 0.05, // 5 %
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
  /**
   * `perps` drops the spot pool fee and attaches the Jupiter short fee schedule.
   * Open/close/borrow are charged later from entry notional and hold time.
   */
  venue?: "spot" | "perps";
  /**
   * Order size in USDC — used with {@link candleVolumeUsdc} to add AMM price impact.
   * When either field is absent or zero, volume impact is skipped.
   */
  tradeUsdc?: number;
  /**
   * Candle trading volume in USDC (base token volume × close price).
   * Represents pool activity for the bar; used to estimate price impact.
   */
  candleVolumeUsdc?: number;
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
  /** Additional slippage fraction from AMM price impact (0 when volume data absent). */
  volumeImpactSlippage: number;
  /** Present for perps short fills. */
  perps?: PerpsFees;
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
 *
 * When both {@link EmulateFillPriceInput.tradeUsdc} and
 * {@link EmulateFillPriceInput.candleVolumeUsdc} are provided, an AMM price-impact
 * term is added on top of the base slippage: larger trades relative to bar volume
 * pay more slippage, capped at {@link MAX_VOLUME_IMPACT}.
 */
export function emulateFillPrice(input: EmulateFillPriceInput): EmulatedFill {
  const { side, close } = input;
  if (!(close > 0) || !Number.isFinite(close)) {
    throw new Error(`emulateFillPrice: invalid close ${close}`);
  }

  const tier = input.tier ?? "liquid";
  const costs = TIER_COSTS[tier];
  const priorityFeeSol = input.priorityFeeSol ?? PRIORITY_FEE_SOL;
  const perps = input.venue === "perps";
  const poolFee = perps ? 0 : costs.poolFee;

  // Volume-based price impact (skipped for perps — borrow fees already model that risk).
  let volumeImpactSlippage = 0;
  const { tradeUsdc, candleVolumeUsdc } = input;
  if (
    !perps &&
    tradeUsdc != null &&
    tradeUsdc > 0 &&
    candleVolumeUsdc != null &&
    candleVolumeUsdc > 0
  ) {
    const raw = (tradeUsdc / candleVolumeUsdc) * VOLUME_IMPACT_SCALE[tier];
    volumeImpactSlippage = Math.min(raw, MAX_VOLUME_IMPACT[tier]);
  }

  const adverseFraction = costs.slippage + poolFee + volumeImpactSlippage;

  const fillPrice = side === "BUY" ? close * (1 + adverseFraction) : close * (1 - adverseFraction);

  const priorityFeeUsdc = priorityFeeSol * close;

  return {
    fillPrice,
    priorityFeeUsdc,
    breakdown: {
      mid: close,
      slippage: costs.slippage,
      poolFee,
      adverseFraction,
      priorityFeeSol,
      priorityFeeUsdc,
      slippageUsdcPerBase: close * (costs.slippage + volumeImpactSlippage),
      poolFeeUsdcPerBase: close * poolFee,
      volumeImpactSlippage,
      ...(perps ? { perps: JUPITER_PERPS_FEES } : {}),
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
