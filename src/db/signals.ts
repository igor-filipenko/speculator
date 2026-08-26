import type { Signal } from "../types.js";
import { getConnection } from "./db.js";

const INSERT_SIGNAL_SQL = `
  INSERT INTO signals ("at", pair, side, price, reason, ema_fast, ema_slow, rsi)
  VALUES ($at::TIMESTAMP, $pair, $side, $price, $reason, $emaFast, $emaSlow, $rsi)
`;

/** Persist one signal for later analysis. */
export async function insertSignal(signal: Signal, dataDir?: string): Promise<void> {
  const conn = await getConnection(dataDir);
  await conn.run(INSERT_SIGNAL_SQL, {
    at: signal.at.toISOString(),
    pair: signal.pair,
    side: signal.side,
    price: signal.price,
    reason: signal.reason,
    emaFast: signal.meta?.emaFast ?? null,
    emaSlow: signal.meta?.emaSlow ?? null,
    rsi: signal.meta?.rsi ?? null,
  });
}
