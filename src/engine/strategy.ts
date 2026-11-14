import { getBotId, query, queryWith, withTransaction } from "../db/db.js";
import { applyStrategyParamPatch, defaultStrategyParams } from "../strategy/strategy-manager.js";

const DEFAULT_EXCHANGE_ID = "jupiter";
const DEFAULT_RISK_PERCENT = 2;

export type StrategyCommand =
  | { kind: "list" }
  | { kind: "add"; registryId: string; pair: string; candleSource: string; depositUsdc: number }
  | { kind: "use"; id: string }
  | { kind: "remove"; id: string }
  | {
      kind: "set";
      id: string;
      candleSource?: string;
      pair?: string;
      depositUsdc?: number;
      riskPercent?: number;
      params: Record<string, string>;
    };

interface StrategyRow {
  id: string;
  registryId: string;
  pair: string;
  candleSource: string;
  exchangeId: string;
  depositUsdc: number;
  riskPercent: number;
  params: unknown;
  selected: boolean;
}

export function strategyUsage(): string {
  return [
    "Usage:",
    "  strategy list",
    "  strategy add <registryId> <pair> --candle-source <source> --deposit <usdc>",
    "  strategy use <uuid>",
    "  strategy remove <uuid>",
    "  strategy set <uuid> [--candle-source <source>] [--pair <pair>] [--deposit <usdc>] [--risk-percent <n>] [key=value ...]",
  ].join("\n");
}

export function parseStrategyArgs(argv: string[]): StrategyCommand {
  const [action, ...rest] = argv;
  if (action === "list" && rest.length === 0) {
    return { kind: "list" };
  }
  if (action === "add") {
    return parseAdd(rest);
  }
  if (action === "use" && rest.length === 1) {
    return { kind: "use", id: parseInstanceId(rest[0] ?? "") };
  }
  if (action === "remove" && rest.length === 1) {
    return { kind: "remove", id: parseInstanceId(rest[0] ?? "") };
  }
  if (action === "set") {
    return parseSet(rest);
  }
  throw new Error(strategyUsage());
}

/** Assign, select, and edit strategy instances for the current `BOT_ID`. */
export async function runStrategy(argv: string[]): Promise<void> {
  await applyStrategyCommand(parseStrategyArgs(argv));
}

export async function applyStrategyCommand(command: StrategyCommand): Promise<void> {
  const botId = getBotId();
  switch (command.kind) {
    case "list":
      await printStrategies(botId);
      return;
    case "add":
      await addStrategy(botId, command);
      return;
    case "use":
      await useStrategy(botId, command.id);
      return;
    case "remove":
      await removeStrategy(botId, command.id);
      return;
    case "set":
      await setStrategy(botId, command);
      return;
  }
}

export function formatStrategyRow(row: StrategyRow): string {
  const mark = row.selected ? "*" : " ";
  return [
    mark,
    row.id,
    row.registryId,
    row.pair,
    row.candleSource,
    row.exchangeId,
    `deposit ${row.depositUsdc}`,
    `risk ${row.riskPercent}%`,
    JSON.stringify(row.params),
  ].join("  ");
}

async function printStrategies(botId: string): Promise<void> {
  const rows = await loadStrategies(botId);
  if (rows.length === 0) {
    console.log(`no strategies assigned to ${botId}`);
    return;
  }
  for (const row of rows) {
    console.log(formatStrategyRow(row));
  }
}

async function loadStrategies(botId: string): Promise<StrategyRow[]> {
  const rows = await query<Record<string, unknown>>(
    `
    SELECT
      i.id::text AS id,
      i.registry_id,
      i.pair,
      i.candle_source::text AS candle_source,
      i.exchange_id,
      s.deposit_usdc,
      i.risk_percent,
      i.params,
      (sel.strategy_id IS NOT NULL) AS selected
    FROM bot.strategies s
    JOIN strategy.instances i ON i.id = s.strategy_id
    LEFT JOIN bot.selection sel
      ON sel.bot_id = s.bot_id AND sel.strategy_id = i.id
    WHERE s.bot_id = $1
    ORDER BY i.pair, i.registry_id, i.id
    `,
    [botId],
  );
  return rows.map((row) => ({
    id: text(row["id"]),
    registryId: text(row["registry_id"]),
    pair: text(row["pair"]),
    candleSource: text(row["candle_source"]),
    exchangeId: text(row["exchange_id"]),
    depositUsdc: Number(row["deposit_usdc"]),
    riskPercent: Number(row["risk_percent"]),
    params: row["params"],
    selected: row["selected"] === true,
  }));
}

async function addStrategy(
  botId: string,
  command: Extract<StrategyCommand, { kind: "add" }>,
): Promise<void> {
  await assertCandleSource(command.candleSource);
  const params = await defaultStrategyParams(command.registryId);
  const id = await withTransaction(async (client) => {
    const inserted = await queryWith<{ id: string }>(
      client,
      `
      INSERT INTO strategy.instances (
        registry_id, pair, candle_source, exchange_id, risk_percent, params
      )
      VALUES ($1, $2, $3::market.candle_source, $4, $5, $6::jsonb)
      RETURNING id::text AS id
      `,
      [
        command.registryId,
        command.pair,
        command.candleSource,
        DEFAULT_EXCHANGE_ID,
        DEFAULT_RISK_PERCENT,
        JSON.stringify(params),
      ],
    );
    const created = inserted[0]?.id;
    if (created === undefined) {
      throw new Error("failed to create strategy instance");
    }
    await queryWith(
      client,
      `
      INSERT INTO bot.strategies (bot_id, strategy_id, deposit_usdc)
      VALUES ($1, $2::uuid, $3)
      `,
      [botId, created, command.depositUsdc],
    );
    await queryWith(
      client,
      `
      INSERT INTO bot.selection (bot_id, strategy_id)
      SELECT $1, $2::uuid
      WHERE NOT EXISTS (SELECT 1 FROM bot.selection WHERE bot_id = $1)
      `,
      [botId, created],
    );
    return created;
  });
  console.log(id);
}

async function useStrategy(botId: string, id: string): Promise<void> {
  const assigned = await query(
    `
    SELECT 1
    FROM bot.strategies
    WHERE bot_id = $1 AND strategy_id = $2::uuid
    `,
    [botId, id],
  );
  if (assigned.length === 0) {
    throw new Error(`strategy ${id} is not assigned to this bot`);
  }
  await query(
    `
    INSERT INTO bot.selection (bot_id, strategy_id)
    VALUES ($1, $2::uuid)
    ON CONFLICT (bot_id) DO UPDATE SET strategy_id = EXCLUDED.strategy_id
    `,
    [botId, id],
  );
  console.log(`selected ${id}`);
}

async function removeStrategy(botId: string, id: string): Promise<void> {
  const assigned = await query(
    `
    SELECT 1
    FROM bot.strategies
    WHERE bot_id = $1 AND strategy_id = $2::uuid
    `,
    [botId, id],
  );
  if (assigned.length === 0) {
    throw new Error(`strategy ${id} is not assigned to this bot`);
  }
  const open = await query(
    `
    SELECT 1
    FROM bot.positions
    WHERE strategy_id = $1::uuid
    LIMIT 1
    `,
    [id],
  );
  if (open.length > 0) {
    throw new Error(`strategy ${id} has an open position`);
  }
  await query(`DELETE FROM strategy.instances WHERE id = $1::uuid`, [id]);
  console.log(`removed ${id}`);
}

async function setStrategy(
  botId: string,
  command: Extract<StrategyCommand, { kind: "set" }>,
): Promise<void> {
  if (command.candleSource !== undefined) {
    await assertCandleSource(command.candleSource);
  }
  const rows = await query<{ registry_id: string; params: unknown }>(
    `
    SELECT registry_id, params
    FROM strategy.instances
    WHERE id = $1::uuid
    `,
    [command.id],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`unknown strategy instance ${command.id}`);
  }
  const params =
    Object.keys(command.params).length === 0
      ? null
      : applyStrategyParamPatch(
          await defaultStrategyParams(row.registry_id),
          row.params,
          command.params,
        );
  await withTransaction(async (client) => {
    await queryWith(
      client,
      `
      UPDATE strategy.instances
      SET
        pair = COALESCE($2, pair),
        candle_source = COALESCE($3::market.candle_source, candle_source),
        risk_percent = COALESCE($4, risk_percent),
        params = COALESCE($5::jsonb, params)
      WHERE id = $1::uuid
      `,
      [
        command.id,
        command.pair ?? null,
        command.candleSource ?? null,
        command.riskPercent ?? null,
        params === null ? null : JSON.stringify(params),
      ],
    );
    if (command.depositUsdc !== undefined) {
      await queryWith(
        client,
        `
        INSERT INTO bot.strategies (bot_id, strategy_id, deposit_usdc)
        VALUES ($1, $2::uuid, $3)
        ON CONFLICT (bot_id, strategy_id) DO UPDATE SET deposit_usdc = EXCLUDED.deposit_usdc
        `,
        [botId, command.id, command.depositUsdc],
      );
    }
  });
  console.log(`updated ${command.id}`);
}

async function assertCandleSource(source: string): Promise<void> {
  const rows = await query<{ label: string }>(
    `SELECT unnest(enum_range(NULL::market.candle_source))::text AS label`,
  );
  if (!rows.some((row) => row.label === source)) {
    throw new Error(`unknown candle source "${source}"`);
  }
}

function parseAdd(argv: string[]): Extract<StrategyCommand, { kind: "add" }> {
  const positionals: string[] = [];
  let candleSource: string | undefined;
  let depositUsdc: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--candle-source") {
      candleSource = requireOnce(candleSource, "candle-source", readFlag(argv, i));
      i += 1;
      continue;
    }
    if (token === "--deposit") {
      depositUsdc = requireOnce(depositUsdc, "deposit", parseDeposit(readFlag(argv, i)));
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(strategyUsage());
    }
    positionals.push(token);
  }
  const registryId = positionals[0]?.trim() ?? "";
  const pair = positionals[1]?.trim() ?? "";
  if (
    positionals.length !== 2 ||
    registryId === "" ||
    pair === "" ||
    candleSource === undefined ||
    depositUsdc === undefined
  ) {
    throw new Error(strategyUsage());
  }
  return { kind: "add", registryId, pair, candleSource, depositUsdc };
}

function parseSet(argv: string[]): Extract<StrategyCommand, { kind: "set" }> {
  const id = parseInstanceId(argv[0] ?? "");
  let candleSource: string | undefined;
  let pair: string | undefined;
  let depositUsdc: number | undefined;
  let riskPercent: number | undefined;
  const params: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--candle-source") {
      candleSource = requireOnce(candleSource, "candle-source", readFlag(argv, i));
      i += 1;
      continue;
    }
    if (token === "--pair") {
      pair = requireOnce(pair, "pair", readFlag(argv, i).trim());
      if (pair === "") throw new Error(strategyUsage());
      i += 1;
      continue;
    }
    if (token === "--deposit") {
      depositUsdc = requireOnce(depositUsdc, "deposit", parseDeposit(readFlag(argv, i)));
      i += 1;
      continue;
    }
    if (token === "--risk-percent") {
      riskPercent = requireOnce(riskPercent, "risk-percent", parseRiskPercent(readFlag(argv, i)));
      i += 1;
      continue;
    }
    const eq = token.indexOf("=");
    if (eq <= 0 || token.startsWith("--")) {
      throw new Error(strategyUsage());
    }
    const key = token.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(strategyUsage());
    }
    if (key in params) {
      throw new Error(`duplicate strategy param "${key}"`);
    }
    params[key] = token.slice(eq + 1);
  }
  if (
    candleSource === undefined &&
    pair === undefined &&
    depositUsdc === undefined &&
    riskPercent === undefined &&
    Object.keys(params).length === 0
  ) {
    throw new Error(strategyUsage());
  }
  return {
    kind: "set",
    id,
    ...(candleSource !== undefined ? { candleSource } : {}),
    ...(pair !== undefined ? { pair } : {}),
    ...(depositUsdc !== undefined ? { depositUsdc } : {}),
    ...(riskPercent !== undefined ? { riskPercent } : {}),
    params,
  };
}

function requireOnce<T>(current: T | undefined, name: string, value: T): T {
  if (current !== undefined) {
    throw new Error(`duplicate --${name}`);
  }
  return value;
}

function readFlag(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(strategyUsage());
  }
  return value;
}

function parseDeposit(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`strategy deposit expects a USDC amount >= 0, got "${raw}"`);
  }
  return value;
}

function parseRiskPercent(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(
      `strategy risk-percent expects a percent greater than 0 and at most 100, got "${raw}"`,
    );
  }
  return value;
}

function parseInstanceId(raw: string): string {
  const id = raw.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`expected a strategy instance UUID, got "${raw}"`);
  }
  return id;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw new Error(`expected text, got ${typeof value}`);
}
