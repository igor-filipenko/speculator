/** Wrapped SOL mint (also used as native SOL in Jupiter swaps). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function isSolMint(mint: string): boolean {
  return mint === WSOL_MINT;
}

/** Convert a UI amount to atomic units, flooring so we never overspend. */
export function toAtomic(amount: number, decimals: number): bigint {
  if (!(amount > 0) || !Number.isFinite(amount) || decimals < 0) {
    return 0n;
  }
  return BigInt(Math.floor(amount * 10 ** decimals));
}

/** Convert atomic units to a UI number. */
export function fromAtomic(amount: bigint, decimals: number): number {
  if (decimals < 0) {
    return 0;
  }
  return Number(amount) / 10 ** decimals;
}

/**
 * SOL that can be sold: native + wrapped ATA, minus the fee reserve.
 * Non-SOL bases ignore `nativeSol` / `reserveSol`.
 */
export function tradableBaseSize(params: {
  baseMint: string;
  tokenUi: number;
  nativeSol: number;
  reserveSol: number;
}): number {
  if (!isSolMint(params.baseMint)) {
    return Math.max(0, params.tokenUi);
  }
  return Math.max(0, params.nativeSol + params.tokenUi - params.reserveSol);
}

export function hasFeeSol(nativeSol: number, reserveSol: number): boolean {
  return nativeSol >= reserveSol && nativeSol > 0;
}

/**
 * Derive fill price (quote per base) and base size from Jupiter execute amounts.
 * BUY: input is quote, output is base. SELL: input is base, output is quote.
 */
export function fillFromSwapAmounts(params: {
  side: "BUY" | "SELL";
  inputAmount: bigint;
  outputAmount: bigint;
  baseDecimals: number;
  quoteDecimals: number;
}): { price: number; size: number } | null {
  if (params.inputAmount <= 0n || params.outputAmount <= 0n) {
    return null;
  }

  if (params.side === "BUY") {
    const size = fromAtomic(params.outputAmount, params.baseDecimals);
    const spent = fromAtomic(params.inputAmount, params.quoteDecimals);
    if (!(size > 0) || !(spent > 0)) {
      return null;
    }
    return { price: spent / size, size };
  }

  const size = fromAtomic(params.inputAmount, params.baseDecimals);
  const proceeds = fromAtomic(params.outputAmount, params.quoteDecimals);
  if (!(size > 0) || !(proceeds > 0)) {
    return null;
  }
  return { price: proceeds / size, size };
}
