import type { Candle, PositionSide } from "../types.js";

export interface IntraBarTick {
  /** Spot price at this step. */
  price: number;
  /** Unix seconds (bar open + a fraction of the interval). */
  atSec: number;
  /** Forming last candle: OHLC only includes prices seen up to this tick. */
  forming: Candle;
}

/**
 * Intra-bar trade path from OHLC. Consecutive duplicate prices are dropped.
 *
 * An open position walks the adverse extreme first so a stop can fire before
 * this bar's favorable extreme ratchets the trail:
 * - long: open → low → close → high (high last)
 * - short: open → high → close → low (low last)
 *
 * Flat keeps the candle-color path (no position to punish):
 * - green (`close >= open`): open → low → high → close
 * - red (`close < open`): open → high → low → close
 */
export function intraBarPrices(candle: Candle, side: PositionSide = "flat"): number[] {
  const { open, high, low, close } = candle;
  const ordered =
    side === "long"
      ? [open, low, close, high]
      : side === "short"
        ? [open, high, close, low]
        : close >= open
          ? [open, low, high, close]
          : [open, high, low, close];
  const prices: number[] = [];
  for (const price of ordered) {
    if (prices.length === 0 || prices[prices.length - 1] !== price) {
      prices.push(price);
    }
  }
  return prices;
}

/**
 * Last (forming) candle after walking `pricesSeen` from the open.
 * Close is the latest tick; high/low span only prices seen so far.
 */
export function formingCandle(closed: Candle, pricesSeen: readonly number[]): Candle {
  const open = closed.open;
  const last = pricesSeen[pricesSeen.length - 1] ?? open;
  let high = open;
  let low = open;
  for (const price of pricesSeen) {
    if (price > high) {
      high = price;
    }
    if (price < low) {
      low = price;
    }
  }
  return {
    time: closed.time,
    open,
    high,
    low,
    close: last,
    volume: closed.volume,
  };
}

/** OHLC ticks for one bar, with a forming last candle at each step (like live). */
export function intraBarTicks(
  candle: Candle,
  intervalSec: number,
  side: PositionSide = "flat",
): IntraBarTick[] {
  const prices = intraBarPrices(candle, side);
  const n = prices.length;
  const ticks: IntraBarTick[] = [];
  const seen: number[] = [];
  const step = n > 1 && intervalSec > 0 ? intervalSec : 0;
  for (let i = 0; i < n; i++) {
    const price = prices[i]!;
    seen.push(price);
    ticks.push({
      price,
      atSec: candle.time + (step === 0 ? 0 : Math.floor((i * step) / n)),
      forming: formingCandle(candle, seen),
    });
  }
  return ticks;
}
