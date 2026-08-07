import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

const DB_FILE = "speculator.duckdb";

const DEFAULT_DATA_DIR = join(process.cwd(), "data");

/** Cached connections keyed by absolute DB path. */
const connections = new Map<string, Promise<DuckDBConnection>>();

/** Path to the shared app DuckDB file. */
export function speculatorDbPath(dataDir = DEFAULT_DATA_DIR): string {
  return join(dataDir, DB_FILE);
}

/** Default data directory (`data/` under cwd). */
export function defaultDataDir(): string {
  return DEFAULT_DATA_DIR;
}

/** Open (or reuse) the shared speculator DuckDB and ensure schema exists. */
export async function getSpeculatorDb(dataDir = DEFAULT_DATA_DIR): Promise<DuckDBConnection> {
  await mkdir(dataDir, { recursive: true });
  const path = speculatorDbPath(dataDir);

  let pending = connections.get(path);
  if (!pending) {
    pending = openConnection(path);
    connections.set(path, pending);
  }
  return pending;
}

async function openConnection(path: string): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.fromCache(path);
  const connection = await instance.connect();
  await initSchema(connection);
  return connection;
}

/** Create tables if missing. Add future persistence tables here. */
export async function initSchema(connection: DuckDBConnection): Promise<void> {
  await connection.run(`
    CREATE TABLE IF NOT EXISTS candles (
      pool_address VARCHAR NOT NULL,
      timeframe    VARCHAR NOT NULL,
      time         BIGINT  NOT NULL,
      open         DOUBLE  NOT NULL,
      high         DOUBLE  NOT NULL,
      low          DOUBLE  NOT NULL,
      close        DOUBLE  NOT NULL,
      volume       DOUBLE  NOT NULL,
      fetched_at   TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (pool_address, timeframe, time)
    )
  `);

  await connection.run(`CREATE SEQUENCE IF NOT EXISTS paper_trades_id_seq`);
  await connection.run(`CREATE SEQUENCE IF NOT EXISTS signals_id_seq`);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS paper_portfolios (
      pair           VARCHAR NOT NULL PRIMARY KEY,
      cash_usdc      DOUBLE  NOT NULL,
      realized_pnl   DOUBLE  NOT NULL,
      position_side  VARCHAR NOT NULL,
      position_size  DOUBLE  NOT NULL,
      entry_price    DOUBLE  NOT NULL,
      opened_at      TIMESTAMP,
      updated_at     TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id           BIGINT PRIMARY KEY DEFAULT nextval('paper_trades_id_seq'),
      pair         VARCHAR NOT NULL,
      side         VARCHAR NOT NULL,
      price        DOUBLE  NOT NULL,
      size         DOUBLE  NOT NULL,
      realized_pnl DOUBLE,
      "at"         TIMESTAMP NOT NULL,
      simulated    BOOLEAN NOT NULL DEFAULT true
    )
  `);

  await connection.run(`
    CREATE INDEX IF NOT EXISTS paper_trades_pair_idx ON paper_trades (pair)
  `);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS signals (
      id       BIGINT PRIMARY KEY DEFAULT nextval('signals_id_seq'),
      "at"     TIMESTAMP NOT NULL,
      pair     VARCHAR NOT NULL,
      side     VARCHAR NOT NULL,
      price    DOUBLE  NOT NULL,
      reason   VARCHAR NOT NULL,
      ema_fast DOUBLE,
      ema_slow DOUBLE,
      rsi      DOUBLE
    )
  `);

  await connection.run(`
    CREATE INDEX IF NOT EXISTS signals_at_idx ON signals ("at")
  `);
}

/** Close cached connection for tests (optional cleanup). */
export function resetSpeculatorDbCache(): void {
  connections.clear();
}
