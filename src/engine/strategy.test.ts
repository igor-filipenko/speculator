import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { getBotId, query, resetSpeculatorDbCache } from "../db/db.js";
import { truncateBotAndMarket, useTestDb } from "../db/test-db.js";
import { applyStrategyCommand, parseStrategyArgs } from "./strategy.js";
import {
  exchangeDrifted,
  keepNetIntents,
  quoteToSpend,
  settlePair,
  loadAssignedInstances,
  loadSelectedInstance,
} from "./tick.js";
import type {
  Command,
  Exchange,
  Order,
  PairConfig,
  Portfolio,
  PortfolioSnapshot,
} from "../types.js";

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

  it("loads the assignment and the selection", async () => {
    await assert.rejects(() => loadSelectedInstance(), /no strategy selected/);
    await applyStrategyCommand({
      kind: "add",
      registryId: "bollinger",
      pair: "SOL/USDC",
      candleSource: "gecko-terminal",
      depositUsdc: 1000,
    });
    const instances = await loadAssignedInstances();
    assert.equal(instances.length, 1);
    assert.equal(instances[0]?.registryId, "bollinger");
    assert.equal(instances[0]?.pair.symbol, "SOL/USDC");
    assert.equal(instances[0]?.depositUsdc, 1000);
    assert.equal(instances[0]?.riskPercent, 2);
    const selected = await loadSelectedInstance();
    assert.equal(selected.id, instances[0]?.id);
  });

  it("rejects two exchanges on one pair", async () => {
    const botId = getBotId();
    const inserted = await query<{ id: string }>(
      `
      INSERT INTO strategy.instances (registry_id, pair, candle_source, exchange_id, risk_percent, params)
      VALUES
        ('bollinger', 'SOL/USDC', 'gecko-terminal', 'jupiter', 2, '{}'::jsonb),
        ('donchian', 'SOL/USDC', 'gecko-terminal', 'emulated', 2, '{}'::jsonb)
      RETURNING id::text AS id
      `,
    );
    assert.equal(inserted.length, 2);
    await query(
      `
      INSERT INTO bot.strategies (bot_id, strategy_id, deposit_usdc)
      SELECT $1, id::uuid, 10 FROM strategy.instances WHERE pair = 'SOL/USDC'
      `,
      [botId],
    );
    await assert.rejects(() => loadAssignedInstances(), /same exchange/);
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

const NET_PAIR: PairConfig = {
  symbol: "SOL/USDC",
  baseMint: "base",
  quoteMint: "quote",
  baseDecimals: 9,
  quoteDecimals: 6,
  poolAddress: "pool",
};

describe("pair net", () => {
  it("spends quote only when the net adds exposure", () => {
    assert.equal(quoteToSpend(0, 2, 10), 20);
    assert.equal(quoteToSpend(2, 1, 10), 0);
    assert.equal(quoteToSpend(0, -1, 10), 10);
    assert.equal(quoteToSpend(1, -1, 10), 10);
  });

  it("drops opens when the wallet cannot pay or the chain has drifted", () => {
    const open = { intent: "open-long" as const, signedBase: 1 };
    const close = { intent: "close-long" as const, signedBase: -0.2 };
    assert.equal(keepNetIntents([open, close], 0, 10, 0, false).length, 1);
    assert.equal(keepNetIntents([open], 0, 10, 0, false).length, 0);
    assert.equal(keepNetIntents([open], 0, 10, undefined, true).length, 0);
    assert.equal(keepNetIntents([open, close], 0, 10, undefined, false).length, 2);
    assert.equal(exchangeDrifted(1, 1.00001), false);
    assert.equal(exchangeDrifted(1, 1.2), true);
  });

  it("sends one venue order for two opens and books both", async () => {
    const calls: Command[] = [];
    const first = fakePortfolio();
    const second = fakePortfolio();
    const books = await settlePair({
      pair: NET_PAIR,
      exchange: fakeExchange(calls),
      price: 10,
      pending: [
        { command: netCommand("open-long", 50), portfolio: first, protective: false },
        { command: netCommand("open-long", 50), portfolio: second, protective: false },
      ],
      currentExchange: 0,
      simulated: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.intent, "open-long");
    assert.equal(calls[0]?.quoteBudgetUsdc, 100);
    assert.equal(books[0]?.kind, "filled");
    assert.equal(books[1]?.kind, "filled");
    assert.equal(first.orders.length, 1);
    assert.equal(second.orders.length, 1);
  });

  it("keeps a close when the wallet cannot pay a new open", async () => {
    const calls: Command[] = [];
    const books = await settlePair({
      pair: NET_PAIR,
      exchange: fakeExchange(calls),
      price: 10,
      pending: [
        { command: netCommand("open-long", 50), portfolio: fakePortfolio(), protective: false },
        { command: netCommand("close-long", 1), portfolio: fakePortfolio(), protective: false },
      ],
      currentExchange: 1,
      freeQuoteUsdc: 0,
      simulated: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.intent, "close-long");
    assert.equal(books[0]?.kind, "risk");
    assert.equal(books[1]?.kind, "filled");
  });
});

function netCommand(intent: Command["intent"], amount: number): Command {
  const opens = intent === "open-long" || intent === "open-short";
  return {
    pair: NET_PAIR.symbol,
    intent,
    orderType: "market",
    reason: intent,
    at: new Date("2026-08-01T00:00:00.000Z"),
    priceHint: 10,
    ...(opens ? { quoteBudgetUsdc: amount } : { baseSize: amount }),
  };
}

function fakePortfolio(): Portfolio & { orders: Order[] } {
  const orders: Order[] = [];
  const snapshot = (): PortfolioSnapshot => ({
    cashUsdc: 1000,
    position: {
      pair: "SOL/USDC",
      side: "flat",
      size: 0,
      entryPrice: 0,
      strategyId: "",
      slPrice: 0,
    },
    realizedPnl: 0,
    equity: 1000,
    trades: [],
    nativeSol: 1,
    insufficientSol: 0,
    simulated: true,
  });
  return {
    orders,
    getSnapshot: snapshot,
    syncFromChain: () => Promise.resolve(),
    applyPositionData: () => Promise.resolve(),
    applyOrder: (order) => {
      orders.push(order);
      return Promise.resolve({
        pair: order.pair,
        side: order.intent === "open-long" || order.intent === "close-short" ? "BUY" : "SELL",
        price: order.price,
        size: order.size,
        at: order.at,
        simulated: order.simulated,
      });
    },
  };
}

function fakeExchange(calls: Command[]): Exchange {
  return {
    spotPrice: () => Promise.resolve(10),
    perpsFeeSchedule: () => Promise.resolve(undefined),
    execute: (command) => {
      calls.push(command);
      const opens = command.intent === "open-long" || command.intent === "open-short";
      const size = opens ? (command.quoteBudgetUsdc ?? 0) / 10 : (command.baseSize ?? 0);
      return Promise.resolve({
        pair: command.pair,
        type: "market" as const,
        intent: command.intent,
        price: 10,
        size,
        at: command.at,
        simulated: true,
        reason: command.reason,
        priorityFeeUsdc: 0,
      });
    },
  };
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
