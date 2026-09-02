import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getSql, resetSpeculatorDbCache } from "./db.js";
import { insertSignal } from "./signals.js";
import { useTestDb } from "./test-db.js";

describe("market.signals", () => {
  before(async () => {
    await useTestDb();
  });

  after(async () => {
    await resetSpeculatorDbCache();
  });

  it("inserts a signal with optional meta", async () => {
    await insertSignal({
      pair: "SOL/USDC",
      side: "BUY",
      reason: "test",
      price: 150.5,
      at: new Date("2026-07-31T10:00:00.000Z"),
      meta: { emaFast: 149, emaSlow: 148, rsi: 55, trendEma: 150, atr: 2.5, adx: 22 },
    });

    const botId = process.env["BOT_ID"];
    const sql = getSql();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT pair, side, price, reason, ema_fast, ema_slow, rsi, trend_ema, atr, adx
      FROM market.signals
      WHERE bot_id = ${botId ?? ""}
    `;
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row["pair"], "SOL/USDC");
    assert.equal(row["side"], "BUY");
    assert.equal(Number(row["price"]), 150.5);
    assert.equal(row["reason"], "test");
    assert.equal(Number(row["ema_fast"]), 149);
    assert.equal(Number(row["ema_slow"]), 148);
    assert.equal(Number(row["rsi"]), 55);
    assert.equal(Number(row["trend_ema"]), 150);
    assert.equal(Number(row["atr"]), 2.5);
    assert.equal(Number(row["adx"]), 22);
  });
});
