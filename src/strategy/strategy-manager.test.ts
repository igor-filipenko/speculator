import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { resetSpeculatorDbCache } from "../db/db.js";
import { listStrategies } from "../db/strategies.js";
import { useTestDb } from "../db/test-db.js";
import {
  listImplementedStrategyIds,
  loadStrategy,
  SimpleStrategyManager,
} from "./strategy-manager.js";

before(async () => {
  await useTestDb();
});

after(async () => {
  await resetSpeculatorDbCache();
});

describe("loadStrategy", () => {
  it("builds every implemented strategy that is in strategy.registry", async () => {
    const ids = await listImplementedStrategyIds();
    assert.ok(ids.length > 0);
    const known = new Set((await listStrategies()).map((row) => row.id));
    for (const id of ids) {
      assert.equal(known.has(id), true, id);
      assert.equal((await loadStrategy(id)).getId(), id);
    }
  });

  it("rejects an id that is not in strategy.registry", async () => {
    await assert.rejects(() => loadStrategy("missing"), /Unknown strategy "missing"/);
  });
});

describe("SimpleStrategyManager", () => {
  it("applies a search patch", async () => {
    const [strategyId] = await listImplementedStrategyIds();
    assert.ok(strategyId);
    const probe = await loadStrategy(strategyId);
    const axis = probe.axes.find((item) => item.key !== "timeframe" && item.levels.length > 1);
    assert.ok(axis);
    const current = probe.getSearchDefaults()[axis.key];
    const next = axis.levels.find((level) => level !== current);
    assert.ok(next !== undefined);
    const manager = await SimpleStrategyManager.create({
      strategyId,
      paramPatch: { values: { [axis.key]: next } },
    });
    assert.equal(manager.getActiveStrategy().getSearchDefaults()[axis.key], next);
    assert.equal(manager.getActiveStrategy().getId(), strategyId);
  });
});
