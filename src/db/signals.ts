import type { Signal } from "../types.js";
import { getBotId, query } from "./db.js";

/** Persist one signal for later analysis. */
export async function insertSignal(signal: Signal): Promise<void> {
  const botId = getBotId();
  const emaFast = signal.meta?.emaFast ?? null;
  const emaSlow = signal.meta?.emaSlow ?? null;
  const rsi = signal.meta?.rsi ?? null;
  const trendEma = signal.meta?.trendEma ?? null;
  const atr = signal.meta?.atr ?? null;
  const adx = signal.meta?.adx ?? null;
  await query(
    `
    INSERT INTO market.signals (
      bot_id, "at", pair, side, price, reason, ema_fast, ema_slow, rsi, trend_ema, atr, adx
    )
    VALUES (
      $1, $2::timestamptz, $3, $4,
      $5, $6, $7, $8, $9, $10, $11, $12
    )
    ON CONFLICT (bot_id, pair, "at") DO NOTHING
    `,
    [
      botId,
      signal.at.toISOString(),
      signal.pair,
      signal.side,
      signal.price,
      signal.reason,
      emaFast,
      emaSlow,
      rsi,
      trendEma,
      atr,
      adx,
    ],
  );
}
