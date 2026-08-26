import { candleIntervalSeconds } from "../market/gecko-terminal.js";
import type { Candle, HtfTimeframe, MarketState, StrategyMode, Trend } from "../types.js";
import { getConnection } from "./db.js";

const UPSERT_SQL = `
  INSERT INTO market.states (
    pair, timeframe, bar_time, "at", price, trend,
    ema200, ema50, adx, atr, atr_pct, dist_ema200_pct,
    market_cap_usd, fdv_usd, strategy_mode, fetched_at
  )
  VALUES (
    $pair, $timeframe, $barTime, $at::TIMESTAMP, $price, $trend,
    $ema200, $ema50, $adx, $atr, $atrPct, $distEma200Pct,
    $marketCapUsd, $fdvUsd, $strategyMode, now()
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
    strategy_mode = excluded.strategy_mode,
    fetched_at = now()
`;

/** Row in `market.states` (OHLCV stays in `candles`). */
export interface PersistedMarket {
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
  strategyMode: StrategyMode;
}

/**
 * True while `nowSec` is still inside the HTF bar that starts at `barTime`.
 * Once that bar closes, Gecko (OHLCV gap + pool stats) should be hit again.
 */
export function isMarketCacheFresh(barTime: number, nowSec: number, intervalSec: number): boolean {
  return nowSec < barTime + intervalSec;
}

export function toPersistedMarket(state: MarketState): PersistedMarket {
  const last = state.candles[state.candles.length - 1];
  const persisted: PersistedMarket = {
    pair: state.pair,
    timeframe: state.timeframe,
    barTime: last !== undefined ? last.time : Math.floor(state.at.getTime() / 1000),
    at: state.at.toISOString(),
    price: state.price,
    trend: state.trend,
    strategyMode: state.strategyMode,
  };
  if (state.ema200 !== undefined) persisted.ema200 = state.ema200;
  if (state.ema50 !== undefined) persisted.ema50 = state.ema50;
  if (state.adx !== undefined) persisted.adx = state.adx;
  if (state.atr !== undefined) persisted.atr = state.atr;
  if (state.atrPct !== undefined) persisted.atrPct = state.atrPct;
  if (state.distEma200Pct !== undefined) persisted.distEma200Pct = state.distEma200Pct;
  if (state.marketCapUsd !== undefined) persisted.marketCapUsd = state.marketCapUsd;
  if (state.fdvUsd !== undefined) persisted.fdvUsd = state.fdvUsd;
  return persisted;
}

/** Rebuild a live {@link MarketState}: overlay spot on price / ATR% / dist-EMA200. */
export function toMarketState(
  persisted: PersistedMarket,
  candles: Candle[],
  livePrice: number,
  strategyMode: StrategyMode,
): MarketState {
  const state: MarketState = {
    pair: persisted.pair,
    timeframe: persisted.timeframe,
    at: new Date(persisted.at),
    price: livePrice,
    trend: persisted.trend,
    strategyMode,
    candles,
  };
  if (persisted.ema200 != null) {
    state.ema200 = persisted.ema200;
    if (livePrice > 0 && persisted.ema200 > 0) {
      state.distEma200Pct = (livePrice - persisted.ema200) / persisted.ema200;
    }
  }
  if (persisted.ema50 != null) {
    state.ema50 = persisted.ema50;
  }
  if (persisted.adx != null) {
    state.adx = persisted.adx;
  }
  if (persisted.atr != null) {
    state.atr = persisted.atr;
    if (livePrice > 0) {
      state.atrPct = persisted.atr / livePrice;
    }
  }
  if (persisted.marketCapUsd != null) {
    state.marketCapUsd = persisted.marketCapUsd;
  }
  if (persisted.fdvUsd != null) {
    state.fdvUsd = persisted.fdvUsd;
  }
  return state;
}

export async function upsertMarket(row: PersistedMarket): Promise<void> {
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
    strategyMode: row.strategyMode,
  });
}

export async function loadMarket(
  pair: string,
  timeframe: HtfTimeframe,
): Promise<PersistedMarket | null> {
  const conn = await getConnection();
  const reader = await conn.runAndReadAll(
    `
    SELECT
      pair, timeframe, bar_time, "at", price, trend,
      ema200, ema50, adx, atr, atr_pct, dist_ema200_pct,
      market_cap_usd, fdv_usd, strategy_mode
    FROM market.states
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

/** Cached {@link PersistedMarket} while the stored HTF bar is still open. */
export async function loadFreshMarketState(
  options: LoadFreshMarketOptions,
): Promise<PersistedMarket | null> {
  const persisted = await loadMarket(options.pair, options.timeframe);
  if (persisted === null) {
    return null;
  }

  const interval = candleIntervalSeconds(options.timeframe);
  if (!isMarketCacheFresh(persisted.barTime, options.nowSec, interval)) {
    return null;
  }

  return persisted;
}

function rowToPersisted(row: Record<string, unknown>): PersistedMarket {
  const at = timestampToIso(row["at"]);
  if (at === undefined) {
    throw new Error("market.states row missing at");
  }
  const persisted: PersistedMarket = {
    pair: asString(row["pair"], "pair"),
    timeframe: asHtfTimeframe(row["timeframe"]),
    barTime: Number(row["bar_time"]),
    at,
    price: Number(row["price"]),
    trend: asTrend(row["trend"]),
    strategyMode: asStrategyMode(row["strategy_mode"]),
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

function asStrategyMode(value: unknown): StrategyMode {
  const raw = asString(value, "strategy_mode");
  if (raw === "ema-rsi" || raw === "bollinger" || raw === "grid") {
    return raw;
  }
  throw new Error(`invalid strategy mode "${raw}"`);
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
