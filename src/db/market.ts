import { candleIntervalSeconds } from "../market/gecko-terminal.js";
import type { Candle, HtfTimeframe, MarketIndicators, Trend } from "../types.js";
import { getConnection } from "./db.js";

const UPSERT_SQL = `
  INSERT INTO market.indicators (
    pair, timeframe, bar_time, "at", price, trend,
    ema200, ema50, adx, atr, atr_pct, dist_ema200_pct,
    market_cap_usd, fdv_usd, fetched_at
  )
  VALUES (
    $pair, $timeframe, $barTime, $at::TIMESTAMP, $price, $trend,
    $ema200, $ema50, $adx, $atr, $atrPct, $distEma200Pct,
    $marketCapUsd, $fdvUsd, now()
  )
  ON CONFLICT (pair, timeframe) DO UPDATE SET
    bar_time = excluded.bar_time,
    "at" = excluded."at",
    price = excluded.price,
    trend = excluded.trend,
    ema200 = excluded.ema200,
    ema50 = excluded.ema50,
    adx = excluded.adx,
    atr = excluded.atr,
    atr_pct = excluded.atr_pct,
    dist_ema200_pct = excluded.dist_ema200_pct,
    market_cap_usd = excluded.market_cap_usd,
    fdv_usd = excluded.fdv_usd,
    fetched_at = now()
`;

/** Row in `market.indicators` (OHLCV stays in `candles`). */
export interface PersistedMarketIndicators {
  pair: string;
  timeframe: HtfTimeframe;
  /** Open time of the HTF bar this snapshot was computed from (Unix seconds). */
  barTime: number;
  at: string;
  price: number;
  trend: Trend;
  ema200?: number;
  ema50?: number;
  adx?: number;
  atr?: number;
  atrPct?: number;
  distEma200Pct?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
}

/**
 * True while `nowSec` is still inside the HTF bar that starts at `barTime`.
 * Once that bar closes, Gecko (OHLCV gap + pool stats) should be hit again.
 */
export function isMarketCacheFresh(barTime: number, nowSec: number, intervalSec: number): boolean {
  return nowSec < barTime + intervalSec;
}

export function toPersistedMarketIndicators(
  indicators: MarketIndicators,
): PersistedMarketIndicators {
  const last = indicators.candles[indicators.candles.length - 1];
  const persisted: PersistedMarketIndicators = {
    pair: indicators.pair,
    timeframe: indicators.timeframe,
    barTime: last !== undefined ? last.time : Math.floor(indicators.at.getTime() / 1000),
    at: indicators.at.toISOString(),
    price: indicators.price,
    trend: indicators.trend,
  };
  if (indicators.ema200 !== undefined) persisted.ema200 = indicators.ema200;
  if (indicators.ema50 !== undefined) persisted.ema50 = indicators.ema50;
  if (indicators.adx !== undefined) persisted.adx = indicators.adx;
  if (indicators.atr !== undefined) persisted.atr = indicators.atr;
  if (indicators.atrPct !== undefined) persisted.atrPct = indicators.atrPct;
  if (indicators.distEma200Pct !== undefined) persisted.distEma200Pct = indicators.distEma200Pct;
  if (indicators.marketCapUsd !== undefined) persisted.marketCapUsd = indicators.marketCapUsd;
  if (indicators.fdvUsd !== undefined) persisted.fdvUsd = indicators.fdvUsd;
  return persisted;
}

/** Rebuild live {@link MarketIndicators}: overlay spot on price / ATR% / dist-EMA200. */
export function toMarketIndicators(
  persisted: PersistedMarketIndicators,
  candles: Candle[],
  livePrice: number,
): MarketIndicators {
  const indicators: MarketIndicators = {
    pair: persisted.pair,
    timeframe: persisted.timeframe,
    at: new Date(persisted.at),
    price: livePrice,
    trend: persisted.trend,
    candles,
  };
  if (persisted.ema200 != null) {
    indicators.ema200 = persisted.ema200;
    if (livePrice > 0 && persisted.ema200 > 0) {
      indicators.distEma200Pct = (livePrice - persisted.ema200) / persisted.ema200;
    }
  }
  if (persisted.ema50 != null) {
    indicators.ema50 = persisted.ema50;
  }
  if (persisted.adx != null) {
    indicators.adx = persisted.adx;
  }
  if (persisted.atr != null) {
    indicators.atr = persisted.atr;
    if (livePrice > 0) {
      indicators.atrPct = persisted.atr / livePrice;
    }
  }
  if (persisted.marketCapUsd != null) {
    indicators.marketCapUsd = persisted.marketCapUsd;
  }
  if (persisted.fdvUsd != null) {
    indicators.fdvUsd = persisted.fdvUsd;
  }
  return indicators;
}

export async function upsertMarketIndicators(row: PersistedMarketIndicators): Promise<void> {
  const conn = await getConnection();
  await conn.run(UPSERT_SQL, {
    pair: row.pair,
    timeframe: row.timeframe,
    barTime: row.barTime,
    at: row.at,
    price: row.price,
    trend: row.trend,
    ema200: row.ema200 ?? null,
    ema50: row.ema50 ?? null,
    adx: row.adx ?? null,
    atr: row.atr ?? null,
    atrPct: row.atrPct ?? null,
    distEma200Pct: row.distEma200Pct ?? null,
    marketCapUsd: row.marketCapUsd ?? null,
    fdvUsd: row.fdvUsd ?? null,
  });
}

export async function loadMarketIndicators(
  pair: string,
  timeframe: HtfTimeframe,
): Promise<PersistedMarketIndicators | null> {
  const conn = await getConnection();
  const reader = await conn.runAndReadAll(
    `
    SELECT
      pair, timeframe, bar_time, "at", price, trend,
      ema200, ema50, adx, atr, atr_pct, dist_ema200_pct,
      market_cap_usd, fdv_usd
    FROM market.indicators
    WHERE pair = $pair AND timeframe = $timeframe
    `,
    { pair, timeframe },
  );
  await reader.readAll();
  const row = reader.getRowObjectsJS()[0];
  return row ? rowToPersisted(row) : null;
}

export interface LoadFreshMarketOptions {
  pair: string;
  timeframe: HtfTimeframe;
  nowSec: number;
}

/** Cached {@link PersistedMarketIndicators} while the stored HTF bar is still open. */
export async function loadFreshMarketIndicators(
  options: LoadFreshMarketOptions,
): Promise<PersistedMarketIndicators | null> {
  const persisted = await loadMarketIndicators(options.pair, options.timeframe);
  if (persisted === null) {
    return null;
  }

  const interval = candleIntervalSeconds(options.timeframe);
  if (!isMarketCacheFresh(persisted.barTime, options.nowSec, interval)) {
    return null;
  }

  return persisted;
}

function rowToPersisted(row: Record<string, unknown>): PersistedMarketIndicators {
  const at = timestampToIso(row["at"]);
  if (at === undefined) {
    throw new Error("market.indicators row missing at");
  }
  const persisted: PersistedMarketIndicators = {
    pair: asString(row["pair"], "pair"),
    timeframe: asHtfTimeframe(row["timeframe"]),
    barTime: Number(row["bar_time"]),
    at,
    price: Number(row["price"]),
    trend: asTrend(row["trend"]),
  };
  const ema200 = optionalNumber(row["ema200"]);
  if (ema200 !== undefined) persisted.ema200 = ema200;
  const ema50 = optionalNumber(row["ema50"]);
  if (ema50 !== undefined) persisted.ema50 = ema50;
  const adx = optionalNumber(row["adx"]);
  if (adx !== undefined) persisted.adx = adx;
  const atr = optionalNumber(row["atr"]);
  if (atr !== undefined) persisted.atr = atr;
  const atrPct = optionalNumber(row["atr_pct"]);
  if (atrPct !== undefined) persisted.atrPct = atrPct;
  const distEma200Pct = optionalNumber(row["dist_ema200_pct"]);
  if (distEma200Pct !== undefined) persisted.distEma200Pct = distEma200Pct;
  const marketCapUsd = optionalNumber(row["market_cap_usd"]);
  if (marketCapUsd !== undefined) persisted.marketCapUsd = marketCapUsd;
  const fdvUsd = optionalNumber(row["fdv_usd"]);
  if (fdvUsd !== undefined) persisted.fdvUsd = fdvUsd;
  return persisted;
}

function asString(value: unknown, field: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  throw new Error(`expected string for ${field}, got ${typeof value}`);
}

function asHtfTimeframe(value: unknown): HtfTimeframe {
  const raw = asString(value, "timeframe");
  if (raw === "4h" || raw === "1d") {
    return raw;
  }
  throw new Error(`invalid HTF timeframe "${raw}"`);
}

function asTrend(value: unknown): Trend {
  const raw = asString(value, "trend");
  if (raw === "bullish" || raw === "bearish" || raw === "flat" || raw === "unknown") {
    return raw;
  }
  throw new Error(`invalid trend "${raw}"`);
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function timestampToIso(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return new Date(value).toISOString();
  }
  if (typeof value === "object" && "micros" in value) {
    const micros = Number((value as { micros: bigint | number }).micros);
    return new Date(micros / 1000).toISOString();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return new Date(Number(value)).toISOString();
  }
  throw new Error(`unsupported timestamp value: ${typeof value}`);
}
