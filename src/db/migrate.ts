import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrateLockKey, readDatabaseUrl } from "./db.js";

export interface MigrationFile {
  version: number;
  description: string;
  filename: string;
  checksum: string;
  sql: string;
}

const FILE_RE = /^V(\d+)__(.+)\.sql$/;

export function migrationsDir(): string {
  const fromModule = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
  return fromModule;
}

export async function loadMigrationFiles(dir = migrationsDir()): Promise<MigrationFile[]> {
  const names = await readdir(dir);
  const files: MigrationFile[] = [];
  for (const filename of names) {
    const match = FILE_RE.exec(filename);
    if (!match) {
      continue;
    }
    const version = Number(match[1]);
    const description = match[2] ?? "";
    const sql = await readFile(join(dir, filename), "utf8");
    const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
    files.push({ version, description, filename, checksum, sql });
  }
  files.sort((a, b) => a.version - b.version);
  if (files.length === 0) {
    throw new Error(`No migration files matching V<n>__<name>.sql in ${dir}`);
  }
  return files;
}

async function ensureHistoryTable(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

export async function appliedMigrations(
  sql: postgres.Sql,
): Promise<Map<number, { checksum: string; description: string }>> {
  await ensureHistoryTable(sql);
  const rows = await sql<{ version: number; checksum: string; description: string }[]>`
    SELECT version, checksum, description
    FROM public.schema_migrations
    ORDER BY version
  `;
  const map = new Map<number, { checksum: string; description: string }>();
  for (const row of rows) {
    map.set(Number(row.version), { checksum: row.checksum, description: row.description });
  }
  return map;
}

/** Throw if disk migrations are ahead of (or mismatch) the database. */
export async function assertMigrationsApplied(): Promise<void> {
  const sql = postgres(readDatabaseUrl(), { max: 1, onnotice: () => undefined });
  try {
    const files = await loadMigrationFiles();
    const applied = await appliedMigrations(sql);
    for (const file of files) {
      const row = applied.get(file.version);
      if (!row) {
        throw new Error(
          `Database is missing migration V${file.version}__${file.description}. Run \`pnpm migrate\`.`,
        );
      }
      if (row.checksum !== file.checksum) {
        throw new Error(
          `Migration V${file.version}__${file.description} checksum mismatch (file changed after apply).`,
        );
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function runMigrations(databaseUrl = readDatabaseUrl()): Promise<void> {
  const files = await loadMigrationFiles();
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql`SELECT pg_advisory_lock(${migrateLockKey()})`;
    try {
      const applied = await appliedMigrations(sql);
      for (const file of files) {
        const existing = applied.get(file.version);
        if (existing) {
          if (existing.checksum !== file.checksum) {
            throw new Error(
              `Migration V${file.version}__${file.description} checksum mismatch (file changed after apply).`,
            );
          }
          console.log(`V${file.version}__${file.description} already applied`);
          continue;
        }
        await sql.begin(async (tx) => {
          await tx.unsafe(file.sql).simple();
          await tx`
            INSERT INTO public.schema_migrations (version, description, checksum)
            VALUES (${file.version}, ${file.description}, ${file.checksum})
          `;
        });
        console.log(`Applied V${file.version}__${file.description}`);
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(${migrateLockKey()})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
