import type { Signal } from "../types.js";
import { getBotId, getSql } from "./db.js";

/** Persist one signal for later analysis. */
export async function insertSignal(signal: Signal): Promise<void> {
  const sql = getSql();
  const botId = getBotId();
  const emaFast = signal.meta?.emaFast ?? null;
  const emaSlow = signal.meta?.emaSlow ?? null;
  const rsi = signal.meta?.rsi ?? null;
  const trendEma = signal.meta?.trendEma ?? null;
  const atr = signal.meta?.atr ?? null;
  const adx = signal.meta?.adx ?? null;
  await sql`
    INSERT INTO market.signals (
      bot_id, "at", pair, side, price, reason, ema_fast, ema_slow, rsi, trend_ema, atr, adx
    )
    VALUES (
      ${botId}, ${signal.at.toISOString()}::timestamptz, ${signal.pair}, ${signal.side},
      ${signal.price}, ${signal.reason}, ${emaFast}, ${emaSlow}, ${rsi}, ${trendEma}, ${atr}, ${adx}
    )
    ON CONFLICT (bot_id, pair, "at") DO NOTHING
  `;
}

export interface SignalRow {
  at: string;
  pair: string;
  side: string;
  price: number;
  reason: string;
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  trendEma: number | null;
  atr: number | null;
  adx: number | null;
}

/** Insert signals for a bot, skipping rows that already exist (DuckDB import). */
export async function insertSignalsForBot(botId: string, rows: SignalRow[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const sql = getSql();
  await sql.begin(async (tx) => {
    for (const row of rows) {
      await tx`
        INSERT INTO market.signals (
          bot_id, "at", pair, side, price, reason, ema_fast, ema_slow, rsi, trend_ema, atr, adx
        )
        VALUES (
          ${botId}, ${row.at}::timestamptz, ${row.pair}, ${row.side}, ${row.price}, ${row.reason},
          ${row.emaFast}, ${row.emaSlow}, ${row.rsi}, ${row.trendEma}, ${row.atr}, ${row.adx}
        )
        ON CONFLICT (bot_id, pair, "at") DO NOTHING
      `;
    }
  });
}
