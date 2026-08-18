import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { getSpeculatorDb, resetSpeculatorDbCache } from "./db.js";

// Dedicated ports to avoid conflicts with a live deployment on the default 9494.
// Each describe block uses its own port so there is no port-reuse between tests.
const SERVER_TEST_PORT = 39494;
const SERVER_TEST_URL = `quack:localhost:${SERVER_TEST_PORT}`;
const CLIENT_TEST_PORT = 39495;
const CLIENT_TEST_URL = `quack:localhost:${CLIENT_TEST_PORT}`;
const QUACK_SECRET = "speculator_test_token_abc123";

type EnvSnapshot = Record<string, string | undefined>;

function saveEnv(keys: string[]): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ENV_KEYS = ["DUCKDB_MODE", "DUCKDB_URL", "DUCKDB_SECRET"] as const;

// ---------------------------------------------------------------------------
// standalone mode
// ---------------------------------------------------------------------------

describe("standalone mode", () => {
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "speculator-standalone-"));
  });

  after(async () => {
    resetSpeculatorDbCache();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("opens a local file and initialises the schema", async () => {
    // No DUCKDB_MODE set → defaults to standalone.
    const conn = await getSpeculatorDb(dataDir);
    const reader = await conn.runAndReadAll(`SELECT count(*)::BIGINT AS n FROM candles`);
    await reader.readAll();
    const row = reader.getRowObjectsJS()[0];
    assert.ok(row, "expected a result row");
    assert.equal(Number(row["n"]), 0);
  });

  it("seeds solana.tokens on first open", async () => {
    const conn = await getSpeculatorDb(dataDir);
    const reader = await conn.runAndReadAll(`SELECT count(*)::BIGINT AS n FROM solana.tokens`);
    await reader.readAll();
    const row = reader.getRowObjectsJS()[0];
    assert.ok(row);
    assert.ok(Number(row["n"]) >= 4, "expected at least 4 seeded tokens");
  });
});

// ---------------------------------------------------------------------------
// server mode
// Note: requires network access the first time to auto-install the quack
// extension from the DuckDB extension repository.
// ---------------------------------------------------------------------------

describe("server mode", () => {
  let dataDir: string;
  let conn: DuckDBConnection;
  let envSnap: EnvSnapshot;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "speculator-server-"));
    envSnap = saveEnv([...ENV_KEYS]);
    process.env["DUCKDB_MODE"] = "server";
    process.env["DUCKDB_URL"] = SERVER_TEST_URL;
    process.env["DUCKDB_SECRET"] = QUACK_SECRET;
    conn = await getSpeculatorDb(dataDir);
  });

  after(async () => {
    try {
      await conn.run(`CALL quack_stop('${SERVER_TEST_URL}')`);
    } catch {
      // expected if already stopped
    }
    resetSpeculatorDbCache();
    restoreEnv(envSnap);
    await rm(dataDir, { recursive: true, force: true });
  });

  it("starts quack_serve and the schema is accessible via the local connection", async () => {
    const reader = await conn.runAndReadAll(`SELECT count(*)::BIGINT AS n FROM candles`);
    await reader.readAll();
    const row = reader.getRowObjectsJS()[0];
    assert.ok(row, "expected a result row");
    assert.equal(Number(row["n"]), 0);
  });

  it("solana.tokens is populated on the server", async () => {
    const reader = await conn.runAndReadAll(`SELECT symbol FROM solana.tokens ORDER BY symbol`);
    await reader.readAll();
    const symbols = reader.getRowObjectsJS().map((r) => r["symbol"] as string);
    assert.ok(symbols.includes("SOL"), "expected SOL token");
    assert.ok(symbols.includes("USDC"), "expected USDC token");
  });
});

// ---------------------------------------------------------------------------
// client mode — integration test (server + client in the same process)
//
// The before() block opens a server connection (DUCKDB_MODE=server), inserts
// one test candle, then clears our connection Map.  The underlying DuckDB
// instance and quack_serve remain alive in @duckdb/node-api's own cache.
// The test then opens a client connection (DUCKDB_MODE=client) which routes
// all SQL through quack_query() — a Proxy around an in-memory DuckDB forwards
// every run()/runAndReadAll() call to the remote server over HTTP.
// ---------------------------------------------------------------------------

describe("client mode — integration", () => {
  let serverDir: string;
  let serverConn: DuckDBConnection;
  let envSnap: EnvSnapshot;

  before(async () => {
    serverDir = await mkdtemp(join(tmpdir(), "speculator-client-svr-"));
    envSnap = saveEnv([...ENV_KEYS]);

    // 1. Start quack server.
    process.env["DUCKDB_MODE"] = "server";
    process.env["DUCKDB_URL"] = CLIENT_TEST_URL;
    process.env["DUCKDB_SECRET"] = QUACK_SECRET;
    serverConn = await getSpeculatorDb(serverDir);

    // 2. Insert one test candle directly via the server connection.
    await serverConn.run(`
      INSERT INTO candles (symbol, timeframe, time, open, high, low, close, volume)
      VALUES ('TEST/USDC', '15m', 1000000, 100.0, 110.0, 90.0, 105.0, 1000.0)
    `);

    // 3. Clear our Map — the DuckDB instance + quack_serve remain alive.
    resetSpeculatorDbCache();

    // 4. Switch to client mode (URL and SECRET stay the same).
    process.env["DUCKDB_MODE"] = "client";
  });

  after(async () => {
    resetSpeculatorDbCache();
    try {
      await serverConn.run(`CALL quack_stop('${CLIENT_TEST_URL}')`);
    } catch {
      // expected if already stopped
    }
    restoreEnv(envSnap);
    await rm(serverDir, { recursive: true, force: true });
  });

  it("reads candles from the remote server via quack_query proxy", async () => {
    const conn = await getSpeculatorDb(); // DUCKDB_MODE=client → quack_query proxy
    const reader = await conn.runAndReadAll(
      `SELECT count(*)::BIGINT AS n FROM candles WHERE symbol = 'TEST/USDC'`,
    );
    await reader.readAll();
    const row = reader.getRowObjectsJS()[0];
    assert.ok(row, "expected a result row");
    assert.equal(Number(row["n"]), 1, "client should see the candle inserted via server");
  });

  it("reads solana.tokens from the remote schema", async () => {
    const conn = await getSpeculatorDb();
    const reader = await conn.runAndReadAll(`SELECT count(*)::BIGINT AS n FROM solana.tokens`);
    await reader.readAll();
    const row = reader.getRowObjectsJS()[0];
    assert.ok(row);
    assert.ok(Number(row["n"]) >= 4, "client should see seeded tokens via remote schema");
  });

  it("writes candles through the proxy and reads them back", async () => {
    const conn = await getSpeculatorDb();
    await conn.run(
      `INSERT INTO candles (symbol, timeframe, time, open, high, low, close, volume)
       VALUES ('PROXY/USDC', '15m', 9000000, 50.0, 55.0, 45.0, 52.0, 200.0)`,
    );
    const reader = await conn.runAndReadAll(
      `SELECT close FROM candles WHERE symbol = 'PROXY/USDC'`,
    );
    await reader.readAll();
    const row = reader.getRowObjectsJS()[0];
    assert.ok(row, "expected inserted row to be readable via proxy");
    assert.equal(Number(row["close"]), 52);
  });
});
