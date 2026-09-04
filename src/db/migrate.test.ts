import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getDbPool, query, resetSpeculatorDbCache } from "./db.js";
import { listMigrationFiles, readMigrationUpSql } from "./migrate.js";
import { runMigrations, useTestDb } from "./test-db.js";

describe("migrations", () => {
  before(async () => {
    await useTestDb();
  });

  after(async () => {
    await resetSpeculatorDbCache();
  });

  it("records init in schema_migrations and creates a candles hypertable", async () => {
    const files = await listMigrationFiles();
    const init = files.find((name) => name.endsWith("_init.sql"));
    assert.ok(init);

    const applied = await query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    assert.equal(applied[0]?.version, init.slice(0, init.indexOf("_")));

    const hypertables = await query<{ hypertable_name: string }>(
      `
      SELECT hypertable_name
      FROM timescaledb_information.hypertables
      WHERE hypertable_schema = 'market' AND hypertable_name = 'candles'
      `,
    );
    assert.equal(hypertables.length, 1);
  });

  it("uses enums for candle timeframe and bot mode", async () => {
    const rows = await query<{ col: string; typ: string }>(
      `
      SELECT 'candles.timeframe' AS col, format_type(a.atttypid, a.atttypmod) AS typ
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'market' AND c.relname = 'candles' AND a.attname = 'timeframe'
      UNION ALL
      SELECT 'portfolios.mode', format_type(a.atttypid, a.atttypmod)
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'bot' AND c.relname = 'portfolios' AND a.attname = 'mode'
      UNION ALL
      SELECT 'trades.mode', format_type(a.atttypid, a.atttypmod)
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'bot' AND c.relname = 'trades' AND a.attname = 'mode'
      `,
    );
    const byCol = new Map(rows.map((r) => [r.col, r.typ]));
    assert.equal(byCol.get("candles.timeframe"), "market.timeframe");
    assert.equal(byCol.get("portfolios.mode"), "bot.mode");
    assert.equal(byCol.get("trades.mode"), "bot.mode");
  });

  it("is a no-op on a second runMigrations", async () => {
    const before = await query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    assert.equal(before.length, 1);

    await runMigrations(process.env["DATABASE_URL"] ?? "");

    const after = await query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    assert.deepEqual(after, before);
  });

  it("can re-apply init SQL without error", async () => {
    const files = await listMigrationFiles();
    const init = files.find((name) => name.endsWith("_init.sql"));
    assert.ok(init);
    const upSql = await readMigrationUpSql(init);
    await getDbPool().query(upSql);
  });
});
