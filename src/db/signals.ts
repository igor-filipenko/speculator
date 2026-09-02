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
  `;
}

export async function deleteSignalsForBot(botId: string): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM market.signals WHERE bot_id = ${botId}`;
}
