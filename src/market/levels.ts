import type { Candle, PriceLevel } from "../types.js";

export interface KeyLevelsParams {
  swingLeftRight: number;
  clusterAtrMult: number;
  /** Skip clusters within this many ATRs of current price. */
  atPriceAtrMult: number;
  /** Ignore levels farther than this (ATR). Falls back to all if none remain. */
  maxDistAtr: number;
  maxLevelsEach: number;
}

export interface KeyLevels {
  support?: number;
  resistance?: number;
  levels: PriceLevel[];
}

interface Pivot {
  price: number;
  time: number;
  volume: number;
}

/**
 * Confirmed swing highs/lows clustered within ATR, split into support (below)
 * and resistance (above) relative to `price`. Ranking prefers nearby high-volume
 * clusters over distant historical swings.
 */
export function keyLevels(
  candles: Candle[],
  price: number,
  atrNow: number | undefined,
  params: KeyLevelsParams,
): KeyLevels {
  const atr = atrNow != null && atrNow > 0 ? atrNow : fallbackAtr(price);
  const clusterTol = params.clusterAtrMult * atr;
  const atTol = params.atPriceAtrMult * atr;

  const highs = swingPivots(candles, params.swingLeftRight, "high");
  const lows = swingPivots(candles, params.swingLeftRight, "low");

  const resistanceClusters = clusterPivots(highs, clusterTol);
  const supportClusters = clusterPivots(lows, clusterTol);

  const supports = pickSide({
    clusters: supportClusters,
    keep: (p) => p < price - atTol,
    price,
    atr,
    maxDistAtr: params.maxDistAtr,
    max: params.maxLevelsEach,
    kind: "support",
  });
  const resistances = pickSide({
    clusters: resistanceClusters,
    keep: (p) => p > price + atTol,
    price,
    atr,
    maxDistAtr: params.maxDistAtr,
    max: params.maxLevelsEach,
    kind: "resistance",
  });

  supports.sort((a, b) => b.price - a.price);
  resistances.sort((a, b) => a.price - b.price);

  const levels = [...supports, ...resistances];
  const result: KeyLevels = { levels };
  if (supports[0] !== undefined) {
    result.support = supports[0].price;
  }
  if (resistances[0] !== undefined) {
    result.resistance = resistances[0].price;
  }
  return result;
}

function fallbackAtr(price: number): number {
  return Math.max(Math.abs(price) * 0.005, 1e-9);
}

function swingPivots(candles: Candle[], leftRight: number, side: "high" | "low"): Pivot[] {
  const n = candles.length;
  const pivots: Pivot[] = [];
  if (leftRight < 1 || n < 2 * leftRight + 1) {
    return pivots;
  }

  for (let i = leftRight; i <= n - 1 - leftRight; i++) {
    const c = candles[i]!;
    const value = side === "high" ? c.high : c.low;
    let extreme = true;
    for (let j = i - leftRight; j <= i + leftRight; j++) {
      if (j === i) continue;
      const other = side === "high" ? candles[j]!.high : candles[j]!.low;
      if (side === "high" ? other >= value : other <= value) {
        extreme = false;
        break;
      }
    }
    if (extreme) {
      pivots.push({ price: value, time: c.time, volume: pivotVolume(candles, i, leftRight) });
    }
  }
  return pivots;
}

/** Swing bar plus the confirmation window — reaction volume at the pivot. */
function pivotVolume(candles: Candle[], index: number, leftRight: number): number {
  let volume = 0;
  const lo = Math.max(0, index - leftRight);
  const hi = Math.min(candles.length - 1, index + leftRight);
  for (let j = lo; j <= hi; j++) {
    volume += candles[j]!.volume;
  }
  return volume;
}

function clusterPivots(pivots: Pivot[], tol: number): PivotCluster[] {
  if (pivots.length === 0) {
    return [];
  }

  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Pivot[][] = [[sorted[0]!]];

  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i]!;
    const group = clusters[clusters.length - 1]!;
    if (p.price - group[0]!.price <= tol) {
      group.push(p);
    } else {
      clusters.push([p]);
    }
  }

  return clusters.map((group) => {
    let volume = 0;
    let lastTime = 0;
    let weighted = 0;
    for (const g of group) {
      volume += g.volume;
      weighted += g.price * g.volume;
      if (g.time > lastTime) lastTime = g.time;
    }
    const price = volume > 0 ? weighted / volume : medianPrice(group);
    return { price, touches: group.length, lastTime, volume };
  });
}

function medianPrice(group: Pivot[]): number {
  const prices = group.map((g) => g.price).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 1 ? prices[mid]! : (prices[mid - 1]! + prices[mid]!) / 2;
}

interface PivotCluster {
  price: number;
  touches: number;
  lastTime: number;
  volume: number;
}

function clusterScore(cluster: PivotCluster, price: number, atr: number): number {
  const distAtr = Math.abs(price - cluster.price) / atr;
  const strength = Math.max(cluster.volume, 1) * Math.sqrt(cluster.touches);
  return strength / (1 + distAtr) ** 2;
}

function pickSide(input: {
  clusters: PivotCluster[];
  keep: (price: number) => boolean;
  price: number;
  atr: number;
  maxDistAtr: number;
  max: number;
  kind: PriceLevel["kind"];
}): PriceLevel[] {
  const eligible = input.clusters.filter((c) => input.keep(c.price));
  const nearby = eligible.filter(
    (c) => Math.abs(input.price - c.price) / input.atr <= input.maxDistAtr,
  );
  const pool = nearby.length > 0 ? nearby : eligible;
  const ranked = [...pool].sort(
    (a, b) => clusterScore(b, input.price, input.atr) - clusterScore(a, input.price, input.atr),
  );
  const best = ranked[0];
  const minScore = best !== undefined ? clusterScore(best, input.price, input.atr) * 0.5 : 0;
  const strong = ranked.filter((c) => clusterScore(c, input.price, input.atr) >= minScore);
  return strong.slice(0, input.max).map((c) => ({
    price: c.price,
    kind: input.kind,
    touches: c.touches,
    lastTime: c.lastTime,
    volume: c.volume,
  }));
}
