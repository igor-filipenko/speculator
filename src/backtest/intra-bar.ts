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
 * Inserts a mid-range sample between the extremes so the path is not only
 * the four OHLC corners:
 * - green (`close >= open`): open → low → mid → high → close
 * - red (`close < open`): open → high → mid → low → close
 *
 * `side` is accepted for call-site compatibility and does not change the path.
 */
export function intraBarPrices(candle: Candle, _side: PositionSide = "flat"): number[] {
  const { open, high, low, close } = candle;
  const midBody = low + (high - low) * 0.5;
  const rawPath =
    close >= open ? [open, low, midBody, high, close] : [open, high, midBody, low, close];
  return rawPath.filter((price, index, arr) => index === 0 || price !== arr[index - 1]);
}

/**
 * Random intra-bar price path constrained by OHLC.
 *
 * Always visits both High and Low; adds one random midpoint drawn uniformly
 * from [Low, High]; shuffles the three middle prices into a random order.
 * Starts at Open, ends at Close. Consecutive duplicates are dropped.
 *
 * Used by Monte Carlo replay to estimate the distribution of strategy outcomes
 * across different intra-bar price orderings.
 */
export function randomIntraBarPrices(candle: Candle, rng: () => number): number[] {
  const { open, high, low, close } = candle;
  const midPrice = low + rng() * (high - low);
  const middle: [number, number, number] = [high, low, midPrice];

  // Fisher-Yates shuffle using rng.
  for (let i = middle.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = middle[i]!;
    middle[i] = middle[j]!;
    middle[j] = tmp;
  }

  const rawPath = [open, ...middle, close];
  return rawPath.filter((price, index, arr) => index === 0 || price !== arr[index - 1]);
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
    ...closed,
    open,
    high,
    low,
    close: last,
  };
}

/**
 * OHLC ticks for one bar, with a forming last candle at each step (like live).
 *
 * When `rng` is provided, uses {@link randomIntraBarPrices} instead of the
 * deterministic {@link intraBarPrices} path — intended for Monte Carlo replay.
 */
export function intraBarTicks(
  candle: Candle,
  intervalSec: number,
  side: PositionSide = "flat",
  rng?: () => number,
): IntraBarTick[] {
  const prices = rng != null ? randomIntraBarPrices(candle, rng) : intraBarPrices(candle, side);
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

/**
 * Quote path from real 1-minute bars inside `bar`.
 *
 * Each tick price is that minute's close, at the minute's close time.
 * The forming signal bar's high/low expand with the 1m wicks seen so far
 * (hard stops read those), and its close is the latest 1m close.
 * Throws when the signal bar has no 1m child — there is no OHLC-path fallback.
 */
export function minuteQuoteTicks(bar: Candle, minutes: readonly Candle[]): IntraBarTick[] {
  const end = bar.time + bar.intervalSeconds;
  const inside = minutes
    .filter((minute) => minute.time >= bar.time && minute.time < end)
    .slice()
    .sort((a, b) => a.time - b.time);
  if (inside.length === 0) {
    throw new Error(
      `No 1m candles for ${new Date(bar.time * 1000).toISOString()} ${bar.timeframe} bar`,
    );
  }

  const ticks: IntraBarTick[] = [];
  let high = bar.open;
  let low = bar.open;
  let volume = 0;
  for (const minute of inside) {
    if (minute.high > high) {
      high = minute.high;
    }
    if (minute.low < low) {
      low = minute.low;
    }
    volume += minute.volume;
    ticks.push({
      price: minute.close,
      atSec: minute.time + minute.intervalSeconds,
      forming: {
        ...bar,
        high,
        low,
        close: minute.close,
        volume,
      },
    });
  }
  return ticks;
}
