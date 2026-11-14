import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PaperPortfolio } from "./portfolio.js";
import { loadPaperState, savePaperState, type PersistedPortfolio } from "./store.js";
import { assignedDepositUsdc, riskPercentFor } from "../../db/bot.js";
import { getBotId, query, resetSpeculatorDbCache, setBotId } from "../../db/db.js";
import { randomUUID } from "node:crypto";
import { useTestDb } from "../../db/test-db.js";
import type { PairConfig } from "../../types.js";

function book(portfolios: Record<string, PersistedPortfolio>, pair: string): PersistedPortfolio {
  const found = Object.values(portfolios).filter((item) => item.position.pair === pair);
  assert.equal(found.length, 1, pair);
  const row = found[0];
  assert.ok(row);
  return row;
}

describe("paper store", () => {
  before(async () => {
    await useTestDb();
  });

  after(async () => {
    await resetSpeculatorDbCache();
  });

  it("saves and loads a portfolio round-trip", async () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const trade = portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "test buy",
      price: 100,
      size: 10,
      at: new Date("2026-07-31T10:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
      strategyId: "bollinger",
      slPrice: 90,
    });
    assert.ok(trade);

    const portfolios = new Map([["SOL/USDC", portfolio]]);
    await savePaperState(portfolios);

    const loaded = await loadPaperState();
    assert.ok(loaded);
    assert.equal(loaded.version, 1);
    assert.ok(loaded.updatedAt.length > 0);

    const persisted = book(loaded.portfolios, "SOL/USDC");
    assert.ok(persisted);

    const restored = PaperPortfolio.fromPersisted(persisted);
    assert.deepEqual(restored.toPersisted(), portfolio.toPersisted());
  });

  it("keeps the open position strategy id and hard stop", async () => {
    const portfolio = new PaperPortfolio("JUP/USDC", 1000);
    const trade = portfolio.applyOrderSync({
      pair: "JUP/USDC",
      type: "market",
      intent: "open-long",
      reason: "test buy",
      price: 1,
      size: 10,
      at: new Date("2026-07-31T12:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
      strategyId: "bollinger",
      slPrice: 0.9,
    });
    assert.ok(trade);
    await savePaperState(new Map([["JUP/USDC", portfolio]]));

    const loaded = await loadPaperState();
    const position = book(loaded?.portfolios ?? {}, "JUP/USDC").position;
    assert.ok(position);
    assert.equal(position.side, "long");
    assert.equal(position.strategyId, "bollinger");
    assert.equal(position.slPrice, 0.9);
    const stored = await query<{ registry_id: string; linked: boolean }>(
      `
      SELECT i.registry_id, p.exchange_position_id IS NOT NULL AS linked
      FROM bot.positions p
      JOIN strategy.instances i ON i.id = p.strategy_id
      WHERE p.pair = $1
      `,
      ["JUP/USDC"],
    );
    assert.equal(stored[0]?.registry_id, "bollinger");
    assert.equal(stored[0]?.linked, true);
    assert.equal(position.entryPrice, 1);

    portfolio.applyOrderSync({
      pair: "JUP/USDC",
      type: "market",
      intent: "close-long",
      reason: "test sell",
      price: 1.1,
      size: 10,
      at: new Date("2026-07-31T13:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
    });
    await savePaperState(new Map([["JUP/USDC", portfolio]]));
    const closed = await loadPaperState();
    const closedBook = book(closed?.portfolios ?? {}, "JUP/USDC");
    assert.equal(closedBook.position.side, "flat");
    assert.equal(closedBook.position.strategyId, undefined);
  });

  it("upserting one pair does not erase another", async () => {
    const sol = new PaperPortfolio("SOL/USDC", 1000);
    sol.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "sol buy",
      price: 100,
      size: 10,
      at: new Date("2026-07-31T10:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
      strategyId: "bollinger",
      slPrice: 90,
    });
    await savePaperState(new Map([["SOL/USDC", sol]]));

    const other = new PaperPortfolio("BONK/USDC", 500);
    other.applyOrderSync({
      pair: "BONK/USDC",
      type: "market",
      intent: "open-long",
      reason: "bonk buy",
      price: 0.00001,
      size: 50_000_000,
      at: new Date("2026-07-31T11:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
      strategyId: "bollinger",
      slPrice: 0.000009,
    });
    await savePaperState(new Map([["BONK/USDC", other]]));

    const loaded = await loadPaperState();
    assert.ok(loaded);
    assert.equal(book(loaded.portfolios, "SOL/USDC").cashUsdc, 0);
    assert.equal(book(loaded.portfolios, "BONK/USDC").cashUsdc, 0);
  });

  it("reloads the long open priority fee and charges it on close", async () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const opened = portfolio.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "test buy",
      price: 100,
      size: 2,
      at: new Date("2026-07-31T10:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 1.5,
      strategyId: "bollinger",
      slPrice: 90,
    });
    assert.ok(opened);
    await savePaperState(new Map([["SOL/USDC", portfolio]]));

    const loaded = await loadPaperState();
    const persisted = book(loaded?.portfolios ?? {}, "SOL/USDC");
    assert.ok(persisted);
    const restored = PaperPortfolio.fromPersisted(persisted);
    assert.equal(restored.toPersisted().position.paidFee, 1.5);

    const closed = restored.applyOrderSync({
      pair: "SOL/USDC",
      type: "market",
      intent: "close-long",
      reason: "test sell",
      price: 110,
      size: 2,
      at: new Date("2026-07-31T11:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0.25,
    });
    assert.ok(closed);
    assert.equal(closed.realizedPnl, 2 * 110 - 0.25 - 2 * 100 - 1.5);
  });

  it("keeps a second instance on the same pair on its own cash", async () => {
    const pair = "WIF/USDC";
    const bollingerId = await insertInstance("bollinger", pair, 2);
    const donchianId = await insertInstance("donchian", pair, 4);
    await query(
      `
      INSERT INTO bot.strategies (bot_id, strategy_id, deposit_usdc)
      VALUES ($1, $2::uuid, 1000), ($1, $3::uuid, 400)
      `,
      [getBotId(), bollingerId, donchianId],
    );
    assert.equal(await riskPercentFor(pair, "donchian"), 4);
    assert.equal(await assignedDepositUsdc(pair, "bollinger"), 1000);

    const bollinger = new PaperPortfolio(pair, 1000);
    bollinger.noteInstance(bollingerId);
    bollinger.applyOrderSync({
      pair,
      type: "market",
      intent: "open-long",
      reason: "bollinger buy",
      price: 1,
      size: 1000,
      at: new Date("2026-08-01T10:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
      strategyId: "bollinger",
      slPrice: 0.9,
    });
    const donchian = new PaperPortfolio(pair, 400);
    donchian.noteInstance(donchianId);
    donchian.applyOrderSync({
      pair,
      type: "market",
      intent: "open-long",
      reason: "donchian buy",
      price: 1,
      size: 100,
      at: new Date("2026-08-01T10:05:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
      strategyId: "donchian",
      slPrice: 0.8,
    });
    await savePaperState(
      new Map([
        [bollingerId, bollinger],
        [donchianId, donchian],
      ]),
    );

    const loaded = await loadPaperState();
    assert.ok(loaded);
    const books = Object.values(loaded.portfolios).filter((item) => item.position.pair === pair);
    assert.equal(books.length, 2);
    const savedBollinger = books.find((item) => item.registryId === "bollinger");
    const savedDonchian = books.find((item) => item.registryId === "donchian");
    assert.equal(savedBollinger?.cashUsdc, 0);
    assert.equal(savedBollinger?.position.size, 1000);
    assert.equal(savedDonchian?.cashUsdc, 300);
    assert.equal(savedDonchian?.position.size, 100);

    const venue = await query<{ size: string | number }>(
      `SELECT size FROM exchange.positions WHERE pair = $1 AND mode = 'paper'`,
      [pair],
    );
    assert.equal(Number(venue[0]?.size), 1000);

    bollinger.applyOrderSync({
      pair,
      type: "market",
      intent: "close-long",
      reason: "bollinger sell",
      price: 1.1,
      size: 1000,
      at: new Date("2026-08-01T11:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 0,
    });
    await savePaperState(new Map([[bollingerId, bollinger]]));

    const after = await loadPaperState();
    assert.ok(after);
    const still = Object.values(after.portfolios).filter((item) => item.position.pair === pair);
    assert.equal(still.find((item) => item.registryId === "bollinger")?.position.side, "flat");
    assert.equal(still.find((item) => item.registryId === "donchian")?.cashUsdc, 300);
    assert.equal(still.find((item) => item.registryId === "donchian")?.position.size, 100);
    const venueAfter = await query<{ size: string | number }>(
      `SELECT size FROM exchange.positions WHERE pair = $1 AND mode = 'paper'`,
      [pair],
    );
    assert.equal(Number(venueAfter[0]?.size), 1000);

    const config: PairConfig = {
      symbol: pair,
      baseMint: "base",
      quoteMint: "quote",
      baseDecimals: 6,
      quoteDecimals: 6,
      poolAddress: "pool",
    };
    const restored = await PaperPortfolio.load([config], 5, "bollinger");
    assert.equal(restored.get(pair)?.getSnapshot(1).cashUsdc, bollinger.getSnapshot(1).cashUsdc);
  });

  it("starts an assigned instance at its deposit", async () => {
    const pair = "JTO/USDC";
    const id = await insertInstance("bollinger", pair, 1);
    await query(
      `INSERT INTO bot.strategies (bot_id, strategy_id, deposit_usdc) VALUES ($1, $2::uuid, 40)`,
      [getBotId(), id],
    );
    const config: PairConfig = {
      symbol: pair,
      baseMint: "base",
      quoteMint: "quote",
      baseDecimals: 6,
      quoteDecimals: 6,
      poolAddress: "pool",
    };
    const loaded = await PaperPortfolio.load([config], 1000, "bollinger");
    assert.equal(loaded.get(pair)?.getSnapshot(1).cashUsdc, 40);
    assert.equal(await riskPercentFor(pair, "bollinger"), 1);
  });

  it("returns null when there are no paper rows for this bot", async () => {
    const otherBot = `empty-${randomUUID()}`;
    setBotId(otherBot);
    process.env["BOT_ID"] = otherBot;
    const loaded = await loadPaperState();
    assert.equal(loaded, null);
  });
});

async function insertInstance(
  registryId: string,
  pair: string,
  riskPercent: number,
): Promise<string> {
  const rows = await query<{ id: string }>(
    `
    INSERT INTO strategy.instances (registry_id, pair, candle_source, exchange_id, risk_percent, params)
    VALUES ($1, $2, 'gecko-terminal', 'jupiter', $3, '{}'::jsonb)
    RETURNING id::text AS id
    `,
    [registryId, pair, riskPercent],
  );
  const id = rows[0]?.id;
  assert.ok(id);
  return id;
}
