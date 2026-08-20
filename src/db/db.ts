import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

const DB_FILE = "speculator.duckdb";

const DEFAULT_DATA_DIR = join(process.cwd(), "data");

type DuckDBMode = "standalone" | "server" | "client";

function readMode(): DuckDBMode {
  const raw = process.env["DUCKDB_MODE"] ?? "standalone";
  if (raw === "standalone" || raw === "server" || raw === "client") return raw;
  throw new Error(`Invalid DUCKDB_MODE "${raw}". Expected standalone | server | client.`);
}

function readUrl(): string {
  return process.env["DUCKDB_URL"] ?? "quack:localhost";
}

function readSecret(): string {
  const mode = readMode();
  const secret = process.env["DUCKDB_SECRET"] ?? "";
  if (mode === "server" || mode === "client") {
    if (!secret) throw new Error("DUCKDB_SECRET is required when DUCKDB_MODE is server or client");
    if (secret.includes("'")) throw new Error("DUCKDB_SECRET must not contain single quotes");
  }
  return secret;
}

/** `true` when the client should use TLS. Default is false (plain HTTP). */
function readSsl(): boolean {
  const raw = (process.env["DUCKDB_SSL"] ?? "false").trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0" || raw === "") return false;
  throw new Error(`Invalid DUCKDB_SSL "${raw}". Expected true or false.`);
}

/** @internal Extract the host portion from a quack: URI (strips brackets for IPv6). */
function parseQuackHost(url: string): string {
  const stripped = url.replace(/^quack:\/\//, "").replace(/^quack:/, "");
  return (stripped.split(":")[0] ?? "localhost").replace(/^\[/, "").replace(/\]$/, "");
}

/** Cached connections keyed by absolute DB path (standalone/server) or `client:<url>` (client). */
const connections = new Map<string, Promise<DuckDBConnection>>();

/** Path to the shared app DuckDB file. */
export function speculatorDbPath(dataDir = DEFAULT_DATA_DIR): string {
  return join(dataDir, DB_FILE);
}

/** Default data directory (`data/` under cwd). */
export function defaultDataDir(): string {
  return DEFAULT_DATA_DIR;
}

/** Open (or reuse) the shared speculator DuckDB connection for the current DUCKDB_MODE. */
export async function getSpeculatorDb(dataDir = DEFAULT_DATA_DIR): Promise<DuckDBConnection> {
  const mode = readMode();

  if (mode === "client") {
    const url = readUrl();
    const cacheKey = `client:${url}`;
    let pending = connections.get(cacheKey);
    if (!pending) {
      pending = openClientConnection(url, readSecret(), readSsl());
      connections.set(cacheKey, pending);
    }
    return pending;
  }

  await mkdir(dataDir, { recursive: true });
  const path = speculatorDbPath(dataDir);
  let pending = connections.get(path);
  if (!pending) {
    pending = openLocalConnection(path, mode);
    connections.set(path, pending);
  }
  return pending;
}

async function openLocalConnection(
  path: string,
  mode: "standalone" | "server",
): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.fromCache(path);
  const connection = await instance.connect();
  await initSchema(connection);
  if (mode === "server") {
    await startQuackServer(connection);
  }
  return connection;
}

async function startQuackServer(connection: DuckDBConnection): Promise<void> {
  const url = readUrl();
  const secret = readSecret();
  const host = parseQuackHost(url);
  const isLocal = /^(localhost|127\.0\.0\.1|::1)$/i.test(host);

  let sql = `CALL quack_serve('${url}', token => '${secret}'`;
  if (!isLocal) sql += `, allow_other_hostname => true`;
  sql += `)`;

  const reader = await connection.runAndReadAll(sql);
  await reader.readAll();
  const row = reader.getRowObjectsJS()[0];
  if (row) {
    const listenUri = typeof row["listen_uri"] === "string" ? row["listen_uri"] : url;
    console.log(`[db] Quack server listening at ${listenUri}`);
  }
}

/** Render a bind value as a SQL literal for embedding inside quack_query. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot bind non-finite number ${String(value)} to SQL`);
    }
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (value instanceof Date) return `'${value.toISOString()}'`;
  throw new Error(`Unsupported bind parameter type: ${typeof value}`);
}

/**
 * Substitute DuckDB named parameters (`$symbol`, `$fromTime`) into SQL.
 * Required because quack_query sends a string to the server — client bind
 * values never reach the remote statement.
 */
function bindNamedParams(sql: string, values?: unknown): string {
  if (values == null) return sql;
  if (Array.isArray(values)) {
    throw new Error("Client-mode quack_query proxy only supports named bind parameters");
  }
  if (typeof values !== "object") return sql;
  const params = values as Record<string, unknown>;
  const names = Object.keys(params).sort((a, b) => b.length - a.length);
  let out = sql;
  for (const name of names) {
    out = out.replace(new RegExp(`\\$${name}\\b`, "g"), () => sqlLiteral(params[name]));
  }
  return out;
}

function wrapQuackQuery(url: string, sql: string, secret: string, ssl: boolean): string {
  let tag = "qq";
  while (sql.includes(`$${tag}$`)) tag += "q";
  let query = `FROM quack_query('${url}', $${tag}$${sql}$${tag}$, token => '${secret}'`;
  if (!ssl) query += `, disable_ssl => true`;
  query += `)`;
  return query;
}

async function openClientConnection(
  url: string,
  secret: string,
  ssl: boolean,
): Promise<DuckDBConnection> {
  // DuckDB 1.5.x quack ATTACH hits a binder error on any server schema that contains
  // column defaults with function calls (DEFAULT now(), DEFAULT nextval(...)).  The
  // workaround is to skip ATTACH entirely and route every SQL statement through
  // quack_query(), which sends the SQL to the server over HTTP and returns the result.
  // A Proxy intercepts run() / runAndReadAll() so all existing callers are transparent.
  const instance = await DuckDBInstance.create(":memory:");
  const rawConn = await instance.connect();
  await rawConn.run(`LOAD quack`);

  return new Proxy(rawConn, {
    get(target: DuckDBConnection, prop: string | symbol): unknown {
      if (prop === "run") {
        return async (sql: string, values?: unknown): Promise<void> => {
          await target.runAndReadAll(
            wrapQuackQuery(url, bindNamedParams(sql, values), secret, ssl),
          );
        };
      }
      if (prop === "runAndReadAll") {
        return (sql: string, values?: unknown) =>
          target.runAndReadAll(wrapQuackQuery(url, bindNamedParams(sql, values), secret, ssl));
      }
      // Delegate every other property / method to the underlying connection.
      const val: unknown = Reflect.get(target, prop);
      if (typeof val === "function") {
        return (val as (this: DuckDBConnection) => unknown).bind(target);
      }
      return val;
    },
  });
}

/** Create schemas/tables if missing. Add future persistence tables here. */
export async function initSchema(connection: DuckDBConnection): Promise<void> {
  await connection.run(`CREATE SCHEMA IF NOT EXISTS paper`);
  await connection.run(`CREATE SCHEMA IF NOT EXISTS solana`);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS candles (
      symbol     VARCHAR NOT NULL,
      timeframe  VARCHAR NOT NULL,
      time       BIGINT  NOT NULL,
      open       DOUBLE  NOT NULL,
      high       DOUBLE  NOT NULL,
      low        DOUBLE  NOT NULL,
      close      DOUBLE  NOT NULL,
      volume     DOUBLE  NOT NULL,
      fetched_at TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (symbol, timeframe, time)
    )
  `);

  await connection.run(`CREATE SEQUENCE IF NOT EXISTS paper.trades_id_seq`);
  await connection.run(`CREATE SEQUENCE IF NOT EXISTS signals_id_seq`);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS paper.portfolios (
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
    CREATE TABLE IF NOT EXISTS paper.trades (
      id           BIGINT PRIMARY KEY DEFAULT nextval('paper.trades_id_seq'),
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
    CREATE INDEX IF NOT EXISTS paper_trades_pair_idx ON paper.trades (pair)
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

  await connection.run(`
    CREATE TABLE IF NOT EXISTS solana.tokens (
      symbol       VARCHAR NOT NULL PRIMARY KEY,
      mint         VARCHAR NOT NULL,
      decimals     INTEGER NOT NULL,
      pool_address VARCHAR
    )
  `);

  // Seed known Solana tokens when missing (idempotent).
  await connection.run(`
    INSERT INTO solana.tokens (symbol, mint, decimals, pool_address)
    VALUES
      ('SOL', 'So11111111111111111111111111111111111111112', 9, '8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj'),
      ('USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, NULL),
      ('JUP', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 6, 'HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL'),
      ('JTO', 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', 9, '93MjUKNKxazKmgS3GBX2Gj2BttEjJUyi7NYeyDHdHSc2')
    ON CONFLICT (symbol) DO NOTHING
  `);
}

/** Clear cached connections (for tests). */
export function resetSpeculatorDbCache(): void {
  connections.clear();
}
