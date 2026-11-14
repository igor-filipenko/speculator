import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "dbmate";
import { config as loadDotenv } from "dotenv";
import { Client } from "pg";
import { dbClientConfig, query, readDatabaseUrl } from "./db.js";

const FILE_RE = /^(\d+)_.+\.sql$/;
const UP_HEADER = /^-- migrate:up(?:[^\n]*)\n/;
const DOWN_HEADER = /\n-- migrate:down\b/;

export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function migrationsDir(): string {
  return join(repoRoot(), "migrations");
}

export async function listMigrationFiles(dir = migrationsDir()): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((name) => FILE_RE.test(name)).sort();
}

export async function readMigrationUpSql(filename: string): Promise<string> {
  const text = await readFile(join(migrationsDir(), filename), "utf8");
  if (!UP_HEADER.test(text)) {
    throw new Error(`${filename} is missing -- migrate:up`);
  }
  const withoutHeader = text.replace(UP_HEADER, "");
  const downAt = withoutHeader.search(DOWN_HEADER);
  return (downAt >= 0 ? withoutHeader.slice(0, downAt) : withoutHeader).trim();
}

function isUndefinedTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "42P01";
}

/** Throw if disk migrations are ahead of the database. */
export async function assertMigrationsApplied(): Promise<void> {
  const files = await listMigrationFiles();
  if (files.length === 0) {
    throw new Error(`No dbmate migration files in ${migrationsDir()}`);
  }
  const versions = files.map((name) => name.slice(0, name.indexOf("_")));
  let applied: Set<string>;
  try {
    const rows = await query<{ version: string }>(`SELECT version FROM schema_migrations`);
    applied = new Set(rows.map((row) => row.version));
  } catch (err) {
    if (!isUndefinedTable(err)) {
      throw err;
    }
    applied = new Set();
  }
  const missing = versions.filter((version) => !applied.has(version));
  if (missing[0] !== undefined) {
    throw new Error(`Database is missing migration ${missing[0]}. Run \`pnpm migrate\`.`);
  }
}

/** Apply `scripts/grant-privileges.sql` as the current `DATABASE_URL` role (the object owner). */
export async function applyPrivilegeGrants(): Promise<void> {
  const sql = await readFile(join(repoRoot(), "scripts", "grant-privileges.sql"), "utf8");
  const client = new Client(dbClientConfig());
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function dbmateDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  // Node pg uses sslmode=no-verify for a self-signed server cert. dbmate/libpq uses require.
  if ((url.searchParams.get("sslmode") ?? "").toLowerCase() === "no-verify") {
    url.searchParams.set("sslmode", "require");
  }
  return url.toString();
}

function runDbmate(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      resolveBinary(),
      [
        "--url",
        dbmateDatabaseUrl(readDatabaseUrl()),
        "--no-dump-schema",
        "--migrations-dir",
        migrationsDir(),
        "up",
      ],
      { cwd: repoRoot(), stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`dbmate up failed (exit ${code ?? "unknown"})`));
    });
  });
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  loadDotenv({ path: join(repoRoot(), ".env") });
  try {
    await runDbmate();
    await applyPrivilegeGrants();
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
