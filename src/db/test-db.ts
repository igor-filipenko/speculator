import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { resolveBinary } from "dbmate";
import { query, resetSpeculatorDbCache, setBotId } from "./db.js";
import { migrationsDir } from "./migrate.js";

export const TIMESCALEDB_IMAGE = "timescale/timescaledb:2.29.2-pg18";

let started: Promise<StartedPostgreSqlContainer> | undefined;

function withSslMode(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (!url.searchParams.has("sslmode")) {
    url.searchParams.set("sslmode", "prefer");
  }
  return url.toString();
}

/** Apply pending dbmate migrations (tests). Prefer `pnpm migrate` at the CLI. */
export function runMigrations(databaseUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveBinary(),
      [
        "--url",
        withSslMode(databaseUrl),
        "--no-dump-schema",
        "--migrations-dir",
        migrationsDir(),
        "up",
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`dbmate up failed (exit ${code ?? "unknown"})`));
    });
  });
}

async function startContainer(): Promise<StartedPostgreSqlContainer> {
  process.env["TESTCONTAINERS_REUSE_ENABLE"] = "true";
  try {
    return await new PostgreSqlContainer(TIMESCALEDB_IMAGE)
      .withDatabase("speculator")
      .withEnvironment({ SPECULATOR_SCHEMA: "dbmate-10-init" })
      .withReuse()
      .start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Docker is required for database tests (image ${TIMESCALEDB_IMAGE}). ${message}`,
      {
        cause: err,
      },
    );
  }
}

export async function useTestDb(botId = `test-${randomUUID()}`): Promise<string> {
  started ??= startContainer();
  const container = await started;
  const url = withSslMode(container.getConnectionUri());
  process.env["DATABASE_URL"] = url;
  process.env["BOT_ID"] = botId;
  await resetSpeculatorDbCache();
  process.env["DATABASE_URL"] = url;
  process.env["BOT_ID"] = botId;
  setBotId(botId);
  await runMigrations(url);
  await truncateBotAndMarket();
  return botId;
}

export async function truncateBotAndMarket(): Promise<void> {
  await query(`TRUNCATE market.candles, market.signals, bot.portfolios, bot.trades`);
}
