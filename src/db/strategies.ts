import { query } from "./db.js";

/** `strategy.type` enum. */
export type StrategyKind = "mean-reversion" | "momentum" | "trend-following";

/** One row from `strategy.registry`. */
export interface RegisteredStrategy {
  id: string;
  name: string;
  type: StrategyKind;
}

const STRATEGY_KINDS = new Set<string>(["mean-reversion", "momentum", "trend-following"]);

function asString(value: unknown, field: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  throw new Error(`expected string for ${field}, got ${typeof value}`);
}

function rowToStrategy(row: Record<string, unknown>): RegisteredStrategy {
  const type = asString(row["type"], "type");
  if (!STRATEGY_KINDS.has(type)) {
    throw new Error(`unexpected strategy type ${type}`);
  }
  return {
    id: asString(row["id"], "id"),
    name: asString(row["name"], "name"),
    type: type as StrategyKind,
  };
}

/** Load one strategy by registry id (e.g. bollinger, donchian, grid). */
export async function getStrategy(id: string): Promise<RegisteredStrategy | null> {
  const rows = await query<Record<string, unknown>>(
    `
    SELECT id, name, type
    FROM strategy.registry
    WHERE id = $1
    `,
    [id.trim()],
  );
  const row = rows[0];
  return row ? rowToStrategy(row) : null;
}

/** Load every registered strategy, ordered by id. */
export async function listStrategies(): Promise<RegisteredStrategy[]> {
  const rows = await query<Record<string, unknown>>(
    `
    SELECT id, name, type
    FROM strategy.registry
    ORDER BY id
    `,
  );
  return rows.map(rowToStrategy);
}
