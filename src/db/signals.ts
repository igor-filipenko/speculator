import type { Signal } from "../types.js";
import { instanceIdForPair } from "./bot.js";
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
  const strategyId = await instanceIdForPair(
    (text, values) => query(text, values),
    signal.pair,
    signal.strategyId,
  );
  await query(
    `
    INSERT INTO market.signals (
      bot_id, strategy_id, "at", pair, side, price, reason,
      ema_fast, ema_slow, rsi, trend_ema, atr, adx
    )
    VALUES (
      $1, $2::uuid, $3::timestamptz, $4, $5,
      $6, $7, $8, $9, $10, $11, $12, $13
    )
    ON CONFLICT (bot_id, strategy_id, "at") DO NOTHING
    `,
    [
      botId,
      strategyId,
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
