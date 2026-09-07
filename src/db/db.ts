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
/** Longer than Gecko's 3s page gap so the client is not dropped between OHLCV upserts. */
export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 15_000;
/** Hosted Timescale often needs more than a few seconds to accept a new TCP+TLS session. */
export const DEFAULT_POOL_CONNECTION_TIMEOUT_MS = 30_000;

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

const INITIAL_RETRY_DELAY_MS = 3_000;
const MAX_RETRY_DELAY_MS = 60_000;

const RETRYABLE_PG_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "40001",
  "40P01",
  "53300",
  "57P01",
  "57P02",
  "57P03",
]);

const RETRYABLE_NODE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function errorCode(err: Error): string | undefined {
  if (!("code" in err) || typeof err.code !== "string") {
    return undefined;
  }
  return err.code;
}

/** Transient pool / network / Postgres errors that are safe to retry. */
export function isRetryableDbError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = errorCode(err);
  if (code !== undefined && (RETRYABLE_PG_CODES.has(code) || RETRYABLE_NODE_CODES.has(code))) {
    return true;
  }
  const msg = err.message.toLowerCase();
  return (
    msg.includes("connection terminated due to connection timeout") ||
    msg.includes("timeout exceeded when trying to connect") ||
    msg.includes("connection terminated unexpectedly") ||
    msg.includes("client has encountered a connection error") ||
    msg.includes("connection timeout") ||
    msg.includes("too many clients already") ||
    msg.includes("remaining connection slots are reserved") ||
    msg.includes("the database system is starting up") ||
    msg.includes("the database system is shutting down")
  );
}

function nextRetryDelayMs(failStreak: number): number {
  const exp = Math.min(Math.max(failStreak - 1, 0), 6);
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** exp, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WithDbRetryOptions {
  /** Override sleep (tests). */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Retry `fn` forever on {@link isRetryableDbError}, with Gecko-style exponential backoff. */
export async function withDbRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options?: WithDbRetryOptions,
): Promise<T> {
  const wait = options?.sleepFn ?? sleep;
  let failStreak = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableDbError(err)) {
        throw err;
      }
      failStreak += 1;
      const delay = nextRetryDelayMs(failStreak);
      console.warn(
        `Database ${label} failed (${err instanceof Error ? err.message : String(err)}); ` +
          `retry in ${delay}ms`,
      );
      await wait(delay);
    }
  }
}

/** Run a parameterized query on the shared pool and return rows. */
export async function query<T extends QueryResultRow>(
  text: string,
  values?: SqlValue[],
): Promise<T[]> {
  return withDbRetry("query", async () => {
    const db = getDbPool();
    const result = values === undefined ? await db.query<T>(text) : await db.query<T>(text, values);
    return result.rows;
  });
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
  const client = await withDbRetry("connect", () => getDbPool().connect());
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
