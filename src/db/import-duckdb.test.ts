import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { candleCount } from "./candles.js";
import { getSql, resetSpeculatorDbCache } from "./db.js";
import { importDuckdb } from "./import-duckdb.js";
import { migrationsDir } from "./migrate.js";
import { useTestDb } from "./test-db.js";
import { listTokens } from "./tokens.js";

const TEST_POOL = "TestPool11111111111111111111111111111111111";
const TEST_MINT = "TestMint11111111111111111111111111111111111";

async function runSql(conn: DuckDBConnection, sql: string): Promise<void> {
  const statements = await conn.extractStatements(sql);
  for (let i = 0; i < statements.count; i++) {
    const prepared = await statements.prepare(i);
    try {
      await prepared.run();
    } finally {
      prepared.destroySync();
    }
  }
}

async function writeFixture(path: string): Promise<void> {
  const schema = await readFile(join(migrationsDir(), "legacy_duckdb.sql"), "utf8");
  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  try {
    await runSql(conn, schema);
    await conn.run(`
      INSERT INTO solana.tokens (symbol, mint, decimals, pool_address)
      VALUES ('TEST', '${TEST_MINT}', 6, '${TEST_POOL}')
    `);
    await conn.run(`
      INSERT INTO candles (symbol, timeframe, time, open, high, low, close, volume)
      VALUES
        ('TEST/USDC', '15m', 1700000000, 1, 1.1, 0.9, 1.05, 10),
        ('TEST/USDC', '15m', 1700000900, 1.05, 1.2, 1.0, 1.1, 12)
    `);
    await conn.run(`
      INSERT INTO signals ("at", pair, side, price, reason, ema_fast, ema_slow, rsi, trend_ema, atr, adx)
      VALUES (
        TIMESTAMP '2026-07-31 10:00:00', 'TEST/USDC', 'BUY', 1.05, 'test buy',
        1.0, 0.99, 40, 1.01, 0.02, 18
      )
    `);
    await conn.run(`
      INSERT INTO paper.portfolios (
        pair, cash_usdc, realized_pnl, position_side, position_size, entry_price, opened_at
      )
      VALUES ('TEST/USDC', 900, 0, 'long', 100, 1.0, TIMESTAMP '2026-07-31 10:00:00')
    `);
    await conn.run(`
      INSERT INTO paper.trades (pair, side, price, size, realized_pnl, "at", simulated)
      VALUES ('TEST/USDC', 'BUY', 1.0, 100, NULL, TIMESTAMP '2026-07-31 10:00:00', true)
    `);
    await conn.run(`
      INSERT INTO live.portfolios (
        pair, cash_usdc, realized_pnl, position_side, position_size, entry_price, opened_at
      )
      VALUES ('TEST/USDC', 800, 5, 'long', 50, 1.1, TIMESTAMP '2026-07-31 11:00:00')
    `);
    await conn.run(`
      INSERT INTO live.trades (pair, side, price, size, realized_pnl, "at", simulated, tx_signature)
      VALUES ('TEST/USDC', 'BUY', 1.1, 50, NULL, TIMESTAMP '2026-07-31 11:00:00', false, 'sig')
    `);
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

interface ImportCounts {
  tokens: number;
  pools: number;
  candles: number;
  signals: number;
  paperPortfolios: number;
  paperTrades: number;
  livePortfolios: number;
  liveTrades: number;
}

async function importCounts(botId: string): Promise<ImportCounts> {
  const sql = getSql();
  const [tokens, pools, signals, paperP, paperT, liveP, liveT] = await Promise.all([
    listTokens(),
    sql<{ cnt: string | number | bigint }[]>`SELECT count(*)::BIGINT AS cnt FROM solana.pools`,
    sql<{ cnt: string | number | bigint }[]>`
      SELECT count(*)::BIGINT AS cnt FROM market.signals WHERE bot_id = ${botId}
    `,
    sql<{ cnt: string | number | bigint }[]>`
      SELECT count(*)::BIGINT AS cnt FROM bot.portfolios
      WHERE bot_id = ${botId} AND mode = 'paper'
    `,
    sql<{ cnt: string | number | bigint }[]>`
      SELECT count(*)::BIGINT AS cnt FROM bot.trades
      WHERE bot_id = ${botId} AND mode = 'paper'
    `,
    sql<{ cnt: string | number | bigint }[]>`
      SELECT count(*)::BIGINT AS cnt FROM bot.portfolios
      WHERE bot_id = ${botId} AND mode = 'live'
    `,
    sql<{ cnt: string | number | bigint }[]>`
      SELECT count(*)::BIGINT AS cnt FROM bot.trades
      WHERE bot_id = ${botId} AND mode = 'live'
    `,
  ]);
  return {
    tokens: tokens.length,
    pools: Number(pools[0]?.cnt ?? 0),
    candles: await candleCount(TEST_POOL, "15m"),
    signals: Number(signals[0]?.cnt ?? 0),
    paperPortfolios: Number(paperP[0]?.cnt ?? 0),
    paperTrades: Number(paperT[0]?.cnt ?? 0),
    livePortfolios: Number(liveP[0]?.cnt ?? 0),
    liveTrades: Number(liveT[0]?.cnt ?? 0),
  };
}

describe("import-duckdb", () => {
  let dir = "";

  before(async () => {
    await useTestDb();
    dir = await mkdtemp(join(tmpdir(), "speculator-duckdb-"));
    await writeFixture(join(dir, "speculator.duckdb"));
  });

  after(async () => {
    await resetSpeculatorDbCache();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not duplicate rows on a second import", async () => {
    const botId = process.env["BOT_ID"];
    assert.ok(botId);
    const path = join(dir, "speculator.duckdb");

    await importDuckdb(path);
    const first = await importCounts(botId);
    assert.equal(first.candles, 2);
    assert.equal(first.signals, 1);
    assert.equal(first.paperPortfolios, 1);
    assert.equal(first.paperTrades, 1);
    assert.equal(first.livePortfolios, 1);
    assert.equal(first.liveTrades, 1);
    assert.ok(first.tokens >= 5);
    assert.ok(first.pools >= 4);

    await importDuckdb(path);
    const second = await importCounts(botId);
    assert.deepEqual(second, first);
  });
});
