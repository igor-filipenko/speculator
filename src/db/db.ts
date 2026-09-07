import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

let pool: Pool | undefined;
let pinnedBotId: string | undefined;

/** Pin BOT_ID for tests. Pass `undefined` to restore env. */
export function setBotId(botId: string | undefined): void {
  pinnedBotId = botId;
}

/** Bot identifier for `bot.*` and `market.signals`. */
export function getBotId(): string {
  const id = (pinnedBotId ?? process.env["BOT_ID"] ?? "").trim();
  if (!id) {
    throw new Error("BOT_ID is required");
  }
  return id;
}

export function readDatabaseUrl(): string {
  const url = (process.env["DATABASE_URL"] ?? "").trim();
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  return url;
}

/** Low CLI defaults (pg-pool itself uses max 10, idle 10s, no connect timeout). */
export const DEFAULT_POOL_MAX = 2;
export const DEFAULT_POOL_MIN = 0;
export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 1_000;
export const DEFAULT_POOL_CONNECTION_TIMEOUT_MS = 5_000;

export interface DbPoolLimits {
  max: number;
  min: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

/** Pool size and timeouts from env, with low defaults. */
export function readPoolLimits(): DbPoolLimits {
  const max = envInt("DATABASE_POOL_MAX", DEFAULT_POOL_MAX, 1);
  const min = envInt("DATABASE_POOL_MIN", DEFAULT_POOL_MIN, 0);
  if (min > max) {
    throw new Error(`DATABASE_POOL_MIN (${min}) must be <= DATABASE_POOL_MAX (${max})`);
  }
  return {
    max,
    min,
    idleTimeoutMillis: envInt("DATABASE_POOL_IDLE_TIMEOUT_MS", DEFAULT_POOL_IDLE_TIMEOUT_MS, 0),
    connectionTimeoutMillis: envInt(
      "DATABASE_POOL_CONNECTION_TIMEOUT_MS",
      DEFAULT_POOL_CONNECTION_TIMEOUT_MS,
      0,
    ),
  };
}

/**
 * pg 8 does not retry without TLS when `sslmode=prefer` (unlike libpq).
 * Strip those modes from the URL and disable SSL so local Docker and Testcontainers work.
 * `require` / `verify-*` stay on the connection string so hosted TLS is unchanged.
 */
function poolOptions(): PoolConfig {
  const limits = readPoolLimits();
  const raw = readDatabaseUrl();
  const url = new URL(raw);
  const sslmode = (url.searchParams.get("sslmode") ?? "").toLowerCase();
  const sized: PoolConfig = {
    max: limits.max,
    min: limits.min,
    idleTimeoutMillis: limits.idleTimeoutMillis,
    connectionTimeoutMillis: limits.connectionTimeoutMillis,
    allowExitOnIdle: true,
  };
  if (sslmode === "disable" || sslmode === "allow" || sslmode === "prefer") {
    url.searchParams.delete("sslmode");
    return { ...sized, connectionString: url.toString(), ssl: false };
  }
  return { ...sized, connectionString: raw };
}

/** Shared `pg.Pool` (singleton). */
export function getDbPool(): Pool {
  if (pool === undefined) {
    pool = new Pool(poolOptions());
    pool.on("connect", (client) => {
      client.on("notice", () => {
        /* Timescale emits notices during hypertable setup */
      });
    });
    pool.on("error", () => {
      /* Idle-client errors must be handled so the process does not crash. */
    });
  }
  return pool;
}

export type SqlValue = string | number | boolean | Date | Buffer | null;

/** Run a parameterized query on the shared pool and return rows. */
export async function query<T extends QueryResultRow>(
  text: string,
  values?: SqlValue[],
): Promise<T[]> {
  const db = getDbPool();
  const result = values === undefined ? await db.query<T>(text) : await db.query<T>(text, values);
  return result.rows;
}

/** Run a parameterized query on a checked-out client (transactions). */
export async function queryWith<T extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values?: SqlValue[],
): Promise<T[]> {
  const result =
    values === undefined ? await client.query<T>(text) : await client.query<T>(text, values);
  return result.rows;
}

/** Checkout one client, BEGIN/COMMIT (ROLLBACK on error), then release. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* keep the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool (tests / process shutdown). */
export async function closeDbPool(): Promise<void> {
  if (pool === undefined) {
    return;
  }
  const pending = pool;
  pool = undefined;
  await pending.end();
}

/** Reset pool + bot id (tests). */
export async function resetSpeculatorDbCache(): Promise<void> {
  await closeDbPool();
  pinnedBotId = undefined;
}
