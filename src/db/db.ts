import postgres, { type Sql } from "postgres";

let sql: Sql | undefined;
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

/** Shared postgres.js pool (singleton). */
export function getSql(): Sql {
  sql ??= postgres(readDatabaseUrl(), {
    max: 10,
    onnotice: () => {
      /* Timescale emits notices during hypertable setup */
    },
  });
  return sql;
}

/** Close the pool (tests / process shutdown). */
export async function closeSql(): Promise<void> {
  if (sql === undefined) {
    return;
  }
  const pending = sql;
  sql = undefined;
  await pending.end({ timeout: 5 });
}

/** Reset pool + bot id (tests). */
export async function resetSpeculatorDbCache(): Promise<void> {
  await closeSql();
  pinnedBotId = undefined;
}
