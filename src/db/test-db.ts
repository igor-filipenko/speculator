import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getSql, resetSpeculatorDbCache, setBotId } from "./db.js";
import { runMigrations } from "./migrate.js";

export const TIMESCALEDB_IMAGE = "timescale/timescaledb:2.29.2-pg18";

let started: Promise<StartedPostgreSqlContainer> | undefined;

async function startContainer(): Promise<StartedPostgreSqlContainer> {
  process.env["TESTCONTAINERS_REUSE_ENABLE"] = "true";
  try {
    return await new PostgreSqlContainer(TIMESCALEDB_IMAGE)
      .withDatabase("speculator")
      .withEnvironment({ SPECULATOR_SCHEMA: "v1-signals-uidx" })
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
  const url = container.getConnectionUri();
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
  const sql = getSql();
  await sql`TRUNCATE market.candles, market.signals, bot.portfolios, bot.trades`;
}
