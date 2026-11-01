import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../config.js";
import { useTestDb } from "../db/test-db.js";
import { createCandle } from "../market/candle.js";
import type { Candle } from "../types.js";
import {
  parseTuneArgs,
  pickNeighborhoodWinner,
  runTune,
  sampleSearchSpace,
  walkForwardWindows,
  type SampledVariant,
  type ScoredVariant,
  type SearchSpace,
} from "./tune.js";

const SOL_USDC_POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";

function makeConfig(): AppConfig {
  return {
    strategy: "bollinger",
    htf: "4h",
    jupiterApiKey: "",
    birdeyeApiKey: "",
    watchlist: ["SOL/USDC"],
    pollIntervalMs: 60_000,
    paperCashUsdc: 1000,
    candleSource: "gecko-terminal",
    botId: "test",
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    slippageBps: 50,
    solReserveMin: 0.03,
    solReserveMax: 0.05,
    pairs: [
      {
        symbol: "SOL/USDC",
        baseMint: "So11111111111111111111111111111111111111112",
        quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        baseDecimals: 9,
        quoteDecimals: 6,
        poolAddress: SOL_USDC_POOL,
      },
    ],
  };
}

function flatCandles(count: number): Candle[] {
  const start = 1_700_000_000;
  const interval = 15 * 60;
  return Array.from({ length: count }, (_, i) =>
    createCandle({
      time: start + i * interval,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
    }),
  );
}

function scored(
  indexes: readonly number[],
  values: Record<string, number>,
  sharpeRatio: number,
  extra: Partial<ScoredVariant> = {},
): ScoredVariant {
  const variant: SampledVariant = { indexes, values };
  return {
    variant,
    sharpeRatio,
    vsHoldReturnPct: 0,
    profitFactor: 1,
    roundTrips: 10,
    maxDrawdownPct: 5,
    feasible: true,
    distanceFromDefaults: 0,
    ...extra,
  };
}

const twoAxisSpace: SearchSpace = {
  strategyId: "bollinger",
  axes: [
    { key: "a", levels: [0, 1, 2] },
    { key: "b", levels: [0, 1, 2] },
  ],
};

describe("sampleSearchSpace", () => {
  it("balances each Latin-hypercube axis and pins defaults at slot 0", () => {
    const space: SearchSpace = {
      strategyId: "bollinger",
      axes: [
        { key: "period", levels: [14, 20, 30] },
        { key: "stdDev", levels: [1.5, 2, 2.5] },
        { key: "stopAtr", levels: [1.5, 2.5, 3.5] },
      ],
    };
    const defaults = { period: 20, stdDev: 2, stopAtr: 2.5 };
    const sample = sampleSearchSpace(space, 12, 1, defaults);
    assert.equal(sample.exhaustive, false);
    assert.equal(sample.variants.length, 12);
    assert.deepEqual(sample.variants[0]?.values, defaults);
    const keys = new Set(sample.variants.map((variant) => variant.indexes.join(",")));
    assert.equal(keys.size, sample.variants.length);
    for (const axis of space.axes) {
      const counts = new Map<number, number>();
      for (const variant of sample.variants) {
        const value = variant.values[axis.key];
        assert.ok(value !== undefined);
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      const freqs = [...counts.values()];
      assert.equal(freqs.length, axis.levels.length);
      const min = Math.min(...freqs);
      const max = Math.max(...freqs);
      assert.ok(max - min <= 2, `${axis.key} counts ${freqs.join(",")}`);
    }
  });

  it("returns the full factorial when it fits, with defaults first", () => {
    const space: SearchSpace = {
      strategyId: "bollinger",
      axes: [
        { key: "period", levels: [14, 20] },
        { key: "stdDev", levels: [2, 2.5] },
      ],
    };
    const sample = sampleSearchSpace(space, 96, 1, { period: 20, stdDev: 2 });
    assert.equal(sample.exhaustive, true);
    assert.equal(sample.variants.length, 4);
    assert.deepEqual(sample.variants[0]?.values, { period: 20, stdDev: 2 });
    assert.deepEqual(
      sample.variants.map((variant) => variant.values["period"]),
      [20, 14, 14, 20],
    );
  });

  it("drops Donchian combinations whose exit is not shorter than the entry", () => {
    const space: SearchSpace = {
      strategyId: "donchian",
      axes: [
        { key: "entryPeriod", levels: [20, 40] },
        { key: "exitPeriod", levels: [10, 20, 30] },
      ],
      accept: (values) => (values["exitPeriod"] ?? 0) < (values["entryPeriod"] ?? 0),
    };
    const sample = sampleSearchSpace(space, 96, 1, { entryPeriod: 40, exitPeriod: 20 });
    assert.equal(sample.exhaustive, true);
    assert.equal(sample.variants.length, 4);
    for (const variant of sample.variants) {
      assert.ok((variant.values["exitPeriod"] ?? 0) < (variant.values["entryPeriod"] ?? 0));
    }
  });
});

describe("pickNeighborhoodWinner", () => {
  it("prefers the plateau median over a raw peak", () => {
    const winner = pickNeighborhoodWinner(
      [
        scored([2, 2], { a: 2, b: 2 }, 5, { distanceFromDefaults: 2 }),
        scored([1, 2], { a: 1, b: 2 }, -1, { feasible: false }),
        scored([2, 1], { a: 2, b: 1 }, -1, { feasible: false }),
        scored([0, 0], { a: 0, b: 0 }, 1.2, { distanceFromDefaults: 0 }),
        scored([1, 0], { a: 1, b: 0 }, 1.2, { distanceFromDefaults: 1 }),
        scored([0, 1], { a: 0, b: 1 }, 1.2, { distanceFromDefaults: 1 }),
      ],
      twoAxisSpace,
    );
    assert.deepEqual(winner?.variant.values, { a: 0, b: 0 });
  });

  it("ignores a high Sharpe that has no evaluated neighbor", () => {
    const winner = pickNeighborhoodWinner(
      [
        scored([2, 2], { a: 2, b: 2 }, 9),
        scored([0, 0], { a: 0, b: 0 }, 1),
        scored([1, 0], { a: 1, b: 0 }, 1),
      ],
      twoAxisSpace,
    );
    assert.deepEqual(winner?.variant.values, { a: 0, b: 0 });
  });

  it("breaks an equal median toward the defaults", () => {
    const defaults = scored([1, 1], { a: 1, b: 1 }, 1, { distanceFromDefaults: 0 });
    const other = scored([0, 1], { a: 0, b: 1 }, 1, { distanceFromDefaults: 1 });
    const winner = pickNeighborhoodWinner([other, defaults], twoAxisSpace);
    assert.deepEqual(winner?.variant.values, { a: 1, b: 1 });
  });
});

describe("walkForwardWindows", () => {
  it("keeps each train strictly before its test fold and grows the train", () => {
    const candles = flatCandles(8);
    const windows = walkForwardWindows(candles, 4);
    assert.equal(windows.length, 3);
    assert.deepEqual(
      windows.map((window) => window.fold),
      [2, 3, 4],
    );
    let previousTrain = 0;
    for (const window of windows) {
      const trainEnd = window.train[window.train.length - 1]?.time;
      const testStart = window.test[0]?.time;
      assert.ok(trainEnd !== undefined && testStart !== undefined && trainEnd < testStart);
      assert.ok(window.train.length > previousTrain);
      previousTrain = window.train.length;
    }
    const last = windows[windows.length - 1];
    assert.ok(last);
    assert.equal(last.train.length + last.test.length, candles.length);
  });

  it("rejects a single fold", () => {
    assert.throws(() => walkForwardWindows(flatCandles(4), 1), /--folds/);
  });
});

describe("parseTuneArgs", () => {
  it("defaults to a 365-day-ready 4-fold search", () => {
    const flags = parseTuneArgs([]);
    assert.equal(flags.folds, 4);
    assert.equal(flags.maxTrials, 96);
    assert.equal(flags.seed, 1);
    assert.equal(flags.minTrades, 8);
    assert.equal(flags.maxDrawdownPct, 40);
    assert.equal(flags.days, undefined);
    assert.equal(flags.fromTime, undefined);
  });

  it("rejects combining --days with --from", () => {
    assert.throws(() => parseTuneArgs(["--days", "30", "--from", "2026-01-01"]), /not both/);
  });
});

describe("runTune", () => {
  it("replays a two-point grid on injected candles and keeps the defaults", async () => {
    await useTestDb();
    const space: SearchSpace = {
      strategyId: "bollinger",
      axes: [{ key: "period", levels: [14, 20] }],
    };
    const [result] = await runTune({
      config: makeConfig(),
      strategyId: "bollinger",
      folds: 2,
      maxTrials: 2,
      seed: 1,
      minTrades: 0,
      maxDrawdownPct: 40,
      space,
      candles: flatCandles(40),
    });
    assert.ok(result);
    assert.equal(result.pair, "SOL/USDC");
    assert.equal(result.folds.length, 1);
    const fold = result.folds[0];
    assert.ok(fold);
    assert.equal(fold.fold, 2);
    assert.equal(fold.exhaustive, true);
    assert.equal(fold.trials, 2);
    assert.ok(fold.trainTo <= fold.testFrom);
    assert.deepEqual(fold.selected, { period: 20 });
    assert.equal(result.keepDefaults, true);
    assert.deepEqual(result.nextParams, { period: 20 });
    assert.equal(fold.oosMetrics.tradeCount, 0);
    assert.equal(fold.baselineMetrics.endingEquity, 1000);
  });
});
