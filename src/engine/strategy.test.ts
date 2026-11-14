import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { getBotId, query, resetSpeculatorDbCache } from "../db/db.js";
import { truncateBotAndMarket, useTestDb } from "../db/test-db.js";
import { applyStrategyCommand, parseStrategyArgs } from "./strategy.js";

const UNUSED = "00000000-0000-4000-8000-000000000000";

describe("parseStrategyArgs", () => {
  it("parses list, add, use, set, and remove", () => {
    assert.deepEqual(parseStrategyArgs(["list"]), { kind: "list" });
    assert.deepEqual(
      parseStrategyArgs([
        "add",
        "bollinger",
        "SOL/USDC",
        "--candle-source",
        "gecko-terminal",
        "--deposit",
        "1000",
      ]),
      {
        kind: "add",
        registryId: "bollinger",
        pair: "SOL/USDC",
        candleSource: "gecko-terminal",
        depositUsdc: 1000,
      },
    );
    assert.deepEqual(parseStrategyArgs(["use", UNUSED]), { kind: "use", id: UNUSED });
    assert.deepEqual(parseStrategyArgs(["remove", UNUSED]), { kind: "remove", id: UNUSED });
    assert.deepEqual(
      parseStrategyArgs([
        "set",
        UNUSED,
        "period=14",
        "--pair",
        "JUP/USDC",
        "--deposit",
        "0",
        "--risk-percent",
        "1.5",
        "--candle-source",
        "binance",
      ]),
      {
        kind: "set",
        id: UNUSED,
        pair: "JUP/USDC",
        depositUsdc: 0,
        riskPercent: 1.5,
        candleSource: "binance",
        params: { period: "14" },
      },
    );
  });

  it("rejects a missing flag, a bad uuid, and an unknown param shape", () => {
    assert.throws(() => parseStrategyArgs([]), /Usage/);
    assert.throws(() => parseStrategyArgs(["add", "bollinger", "SOL/USDC"]), /Usage/);
    assert.throws(() => parseStrategyArgs(["use", "bollinger"]), /UUID/);
    assert.throws(() => parseStrategyArgs(["set", UNUSED]), /Usage/);
    assert.throws(() => parseStrategyArgs(["set", UNUSED, "--risk-percent", "0"]), /risk-percent/);
    assert.throws(
      () =>
        parseStrategyArgs([
          "add",
          "bollinger",
          "SOL/USDC",
          "--deposit",
          "-1",
          "--candle-source",
          "gecko-terminal",
        ]),
      /deposit/,
    );
  });
});

describe("strategy commands", () => {
  before(async () => {
    await useTestDb();
  });

  beforeEach(async () => {
    await truncateBotAndMarket();
  });

  after(async () => {
    await resetSpeculatorDbCache();
  });

  it("adds an instance, selects the first one, and lists it", async () => {
    await applyStrategyCommand({
      kind: "add",
      registryId: "bollinger",
      pair: "SOL/USDC",
      candleSource: "gecko-terminal",
      depositUsdc: 1000,
    });
    await applyStrategyCommand({
      kind: "add",
      registryId: "donchian",
      pair: "JUP/USDC",
      candleSource: "binance",
      depositUsdc: 250,
    });

    const rows = await assigned();
    assert.equal(rows.length, 2);
    const bollinger = rows.find((row) => row.registry_id === "bollinger");
    const donchian = rows.find((row) => row.registry_id === "donchian");
    assert.ok(bollinger);
    assert.ok(donchian);
    assert.equal(bollinger.exchange_id, "jupiter");
    assert.equal(Number(bollinger.risk_percent), 2);
    assert.equal(Number(bollinger.deposit_usdc), 1000);
    assert.equal(bollinger.params["timeframe"], "1h");
    assert.equal(bollinger.params["period"], 20);

    const selected = await selection();
    assert.equal(selected, bollinger.id);

    const lines = await captureLog(() => applyStrategyCommand({ kind: "list" }));
    assert.match(lines, new RegExp(`\\*  ${bollinger.id}  bollinger`));
    assert.match(lines, new RegExp(` ${donchian.id}  donchian`));
  });

  it("use switches the selection and remove refuses an open position", async () => {
    await applyStrategyCommand({
      kind: "add",
      registryId: "bollinger",
      pair: "SOL/USDC",
      candleSource: "gecko-terminal",
      depositUsdc: 1000,
    });
    await applyStrategyCommand({
      kind: "add",
      registryId: "donchian",
      pair: "JUP/USDC",
      candleSource: "binance",
      depositUsdc: 250,
    });
    const donchian = (await assigned()).find((row) => row.registry_id === "donchian");
    assert.ok(donchian);
    await applyStrategyCommand({ kind: "use", id: donchian.id });
    assert.equal(await selection(), donchian.id);

    await query(
      `
      INSERT INTO exchange.positions (bot_id, mode, integration_id, pair, side, size)
      VALUES ($1, 'paper', 'emulated', 'JUP/USDC', 'long', 1)
      `,
      [getBotId()],
    );
    const exchange = await query<{ id: string }>(
      `SELECT id::text AS id FROM exchange.positions WHERE bot_id = $1`,
      [getBotId()],
    );
    const exchangeId = exchange[0]?.id;
    assert.ok(exchangeId);
    await query(
      `
      INSERT INTO bot.positions (
        bot_id, mode, pair, strategy_id, exchange_position_id, side, size, entry_price, sl_price
      )
      VALUES ($1, 'paper', 'JUP/USDC', $2::uuid, $3::uuid, 'long', 1, 1, 0.9)
      `,
      [getBotId(), donchian.id, exchangeId],
    );
    await assert.rejects(
      () => applyStrategyCommand({ kind: "remove", id: donchian.id }),
      /open position/,
    );
    assert.equal(await selection(), donchian.id);

    await query(`DELETE FROM bot.positions WHERE strategy_id = $1::uuid`, [donchian.id]);
    await applyStrategyCommand({ kind: "remove", id: donchian.id });
    assert.equal(
      (await assigned()).some((row) => row.id === donchian.id),
      false,
    );
    assert.equal(await selection(), null);
  });

  it("set merges a known knob and assigns a deposit", async () => {
    await query(
      `
      INSERT INTO strategy.instances (
        registry_id, pair, candle_source, exchange_id, risk_percent, params
      )
      VALUES ('bollinger', 'SOL/USDC', 'gecko-terminal', 'jupiter', 2, '{}'::jsonb)
      `,
    );
    const created = await query<{ id: string }>(
      `SELECT id::text AS id FROM strategy.instances WHERE registry_id = 'bollinger'`,
    );
    const id = created[0]?.id;
    assert.ok(id);

    await assert.rejects(
      () => applyStrategyCommand({ kind: "set", id, params: { notAKnob: "1" } }),
      /unknown strategy param/,
    );
    await applyStrategyCommand({
      kind: "set",
      id,
      depositUsdc: 40,
      riskPercent: 1,
      params: { period: "14" },
    });

    const rows = await assigned();
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.deposit_usdc), 40);
    assert.equal(Number(rows[0]?.risk_percent), 1);
    assert.equal(rows[0]?.params["period"], 14);
    assert.equal(rows[0]?.params["timeframe"], "1h");
  });

  it("rejects an unknown registry id and an unassigned use", async () => {
    await assert.rejects(
      () =>
        applyStrategyCommand({
          kind: "add",
          registryId: "missing",
          pair: "SOL/USDC",
          candleSource: "gecko-terminal",
          depositUsdc: 1,
        }),
      /Unknown strategy "missing"/,
    );
    await assert.rejects(() => applyStrategyCommand({ kind: "use", id: UNUSED }), /not assigned/);
    await assert.rejects(
      () =>
        applyStrategyCommand({
          kind: "add",
          registryId: "bollinger",
          pair: "SOL/USDC",
          candleSource: "not-a-source",
          depositUsdc: 1,
        }),
      /unknown candle source/,
    );
  });
});

interface AssignedRow {
  id: string;
  registry_id: string;
  exchange_id: string;
  deposit_usdc: number;
  risk_percent: number;
  params: Record<string, string | number | boolean>;
}

async function assigned(): Promise<AssignedRow[]> {
  return query<AssignedRow>(
    `
    SELECT
      i.id::text AS id,
      i.registry_id,
      i.exchange_id,
      s.deposit_usdc,
      i.risk_percent,
      i.params
    FROM bot.strategies s
    JOIN strategy.instances i ON i.id = s.strategy_id
    WHERE s.bot_id = $1
    ORDER BY i.registry_id
    `,
    [getBotId()],
  );
}

async function selection(): Promise<string | null> {
  const rows = await query<{ id: string }>(
    `SELECT strategy_id::text AS id FROM bot.selection WHERE bot_id = $1`,
    [getBotId()],
  );
  return rows[0]?.id ?? null;
}

async function captureLog(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}
