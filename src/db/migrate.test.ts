import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getSql, resetSpeculatorDbCache } from "./db.js";
import { loadMigrationFiles, runMigrations } from "./migrate.js";
import { useTestDb } from "./test-db.js";

describe("migrations", () => {
  before(async () => {
    await useTestDb();
  });

  after(async () => {
    await resetSpeculatorDbCache();
  });

  it("records V1 in schema_migrations and creates a candles hypertable", async () => {
    const files = await loadMigrationFiles();
    assert.ok(files.some((f) => f.version === 1));

    const sql = getSql();
    const applied = await sql<{ version: number; description: string }[]>`
      SELECT version, description FROM public.schema_migrations ORDER BY version
    `;
    assert.equal(Number(applied[0]?.version), 1);

    const hypertables = await sql<{ hypertable_name: string }[]>`
      SELECT hypertable_name
      FROM timescaledb_information.hypertables
      WHERE hypertable_schema = 'market' AND hypertable_name = 'candles'
    `;
    assert.equal(hypertables.length, 1);
  });

  it("uses enums for candle timeframe and bot mode", async () => {
    const sql = getSql();
    const rows = await sql<{ col: string; typ: string }[]>`
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
    `;
    const byCol = new Map(rows.map((r) => [r.col, r.typ]));
    assert.equal(byCol.get("candles.timeframe"), "market.timeframe");
    assert.equal(byCol.get("portfolios.mode"), "bot.mode");
    assert.equal(byCol.get("trades.mode"), "bot.mode");
  });

  it("is a no-op on a second runMigrations", async () => {
    const sql = getSql();
    const before = await sql<{ version: number; checksum: string }[]>`
      SELECT version, checksum FROM public.schema_migrations ORDER BY version
    `;
    assert.equal(before.length, 1);

    await runMigrations();

    const after = await sql<{ version: number; checksum: string }[]>`
      SELECT version, checksum FROM public.schema_migrations ORDER BY version
    `;
    assert.deepEqual(after, before);
  });

  it("can re-apply V1 SQL without error", async () => {
    const files = await loadMigrationFiles();
    const v1 = files.find((f) => f.version === 1);
    assert.ok(v1);
    const sql = getSql();
    await sql.unsafe(v1.sql).simple();
  });
});
