import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getSql, resetSpeculatorDbCache } from "./db.js";
import { loadMigrationFiles } from "./migrate.js";
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
});
