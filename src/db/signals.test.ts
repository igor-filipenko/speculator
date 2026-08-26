import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { getConnection, resetSpeculatorDbCache } from "./db.js";
import { insertSignal } from "./signals.js";

describe("signals (DuckDB)", () => {
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "speculator-signals-"));
  });

  after(async () => {
    resetSpeculatorDbCache();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("inserts a signal with optional meta", async () => {
    await insertSignal(
      {
        pair: "SOL/USDC",
        side: "BUY",
        reason: "test",
        price: 150.5,
        at: new Date("2026-07-31T10:00:00.000Z"),
        meta: { emaFast: 149, emaSlow: 148, rsi: 55 },
      },
      dataDir,
    );

    const conn = await getConnection(dataDir);
    const reader = await conn.runAndReadAll(
      `SELECT pair, side, price, reason, ema_fast, ema_slow, rsi FROM signals`,
    );
    await reader.readAll();
    const rows = reader.getRowObjectsJS();
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
  });
});
