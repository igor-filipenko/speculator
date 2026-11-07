import os from "node:os";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import type { AppConfig } from "../config.js";
import { createMarket } from "../market/manager.js";
import { createCandle, timeframeFromMinutes } from "../market/candle.js";
import { loadHtfCandles, loadMtfCandles } from "../backtest/market-replay.js";
import { readFlagValue, resolveReplayWindow } from "../backtest/replay-window.js";
import { SimpleStrategyManager, type StrategyParamPatch } from "../strategy/strategy-manager.js";
import type {
  Candle,
  CandleSource,
  PairConfig,
  SearchSpace,
  Strategy,
  Timeframe,
} from "../types.js";
import {
  mulberry32,
  parseBacktestDate,
  runBacktest,
  splitCandlesIntoFolds,
  type BacktestMetrics,
} from "./backtest.js";

export const TUNE_DEFAULT_DAYS = 365;
export const TUNE_DEFAULT_FOLDS = 4;
export const TUNE_DEFAULT_MAX_TRIALS = 96;
export const TUNE_DEFAULT_SEED = 1;
export const TUNE_DEFAULT_MIN_TRADES = 8;
export const TUNE_DEFAULT_MAX_DRAWDOWN_PCT = 40;
/** A train trial must return more than this percent to be eligible. */
export const TUNE_DEFAULT_MIN_RETURN_PCT = 0;
/** A train trial needs at least this profit factor to be eligible. */
export const TUNE_DEFAULT_MIN_PROFIT_FACTOR = 1.1;
const NEIGHBOR_FILL_LEADERS = 3;
const PROFIT_FACTOR_CAP = 999;

export interface SampledVariant {
  indexes: readonly number[];
  values: Readonly<Record<string, number>>;
}

export interface SearchSample {
  variants: SampledVariant[];
  /** True when every valid combination is in `variants`. */
  exhaustive: boolean;
}

export interface ScoredVariant {
  variant: SampledVariant;
  sharpeRatio: number;
  vsHoldReturnPct: number;
  totalReturnPct: number;
  profitFactor: number;
  roundTrips: number;
  maxDrawdownPct: number;
  feasible: boolean;
  distanceFromDefaults: number;
}

export interface TuneCliOptions {
  fromTime?: number;
  toTime?: number;
  /** Set only when `--days` is passed. */
  days?: number;
  strategy?: string;
  folds: number;
  maxTrials: number;
  seed: number;
  minTrades: number;
  maxDrawdownPct: number;
  minReturnPct: number;
  minProfitFactor: number;
  /** Worker count. `1` replays on this thread. */
  jobs: number;
  /** When `1m`, each signal bar is stepped on real minute closes. */
  quotes?: "1m";
}

export interface WalkForwardWindow {
  /** 1-indexed test fold. Fold 1 is train-only. */
  fold: number;
  train: Candle[];
  test: Candle[];
}

export interface TuneFoldResult {
  fold: number;
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
  trials: number;
  exhaustive: boolean;
  /** Train winner. Absent when no feasible set has an evaluated neighbor. */
  selected?: Readonly<Record<string, number>>;
  trainMetrics?: BacktestMetrics;
  oosMetrics: BacktestMetrics;
  baselineMetrics: BacktestMetrics;
}

export interface TuneResult {
  pair: string;
  strategyId: string;
  folds: TuneFoldResult[];
  /** Compounded return across test folds, percent. */
  oosReturnPct: number;
  /** Arithmetic mean of per-fold out-of-sample Sharpe ratios. */
  oosSharpe: number;
  baselineReturnPct: number;
  baselineSharpe: number;
  /** Test folds whose out-of-sample return is above zero. */
  positiveFolds: number;
  /**
   * True unless the search beats today's defaults on mean OOS Sharpe, compounds
   * a positive OOS return, and is positive in at least two thirds of the folds.
   */
  keepDefaults: boolean;
  /** Why `keepDefaults` is true. Empty when the search passes. */
  keepReasons: string[];
  /** Winner of the last train window (everything before the last fold). */
  nextParams?: Readonly<Record<string, number>>;
}

export interface RunTuneOptions {
  config: AppConfig;
  strategyId: string;
  folds: number;
  maxTrials: number;
  seed: number;
  minTrades: number;
  maxDrawdownPct: number;
  /** Train trials at or below this return are ineligible. Omitted disables the gate. */
  minReturnPct?: number;
  /** Train trials below this profit factor are ineligible. Omitted disables the gate. */
  minProfitFactor?: number;
  /**
   * Replay workers. Omitted or `1` keeps the serial loop (tests).
   * The CLI defaults this to `os.availableParallelism()`.
   */
  jobs?: number;
  /** When `1m`, replays step each signal bar on real minute closes. */
  quotes?: "1m";
  /** Injected 1m candles used when `quotes` is `1m`. Fetched when omitted. */
  minuteCandles?: Candle[];
  fromTime?: number;
  toTime?: number;
  days?: number;
  /** Defaults to the active strategy's search space. Tests pass a tiny space. */
  space?: SearchSpace;
  /** Signal candles. When set, skips the network and reuses this series for every pair. */
  candles?: Candle[];
  htfCandles?: Candle[];
  mtfCandles?: Candle[];
}

/** Axis values taken from `source`. Each axis key must be present. */
export function defaultLevels(
  space: SearchSpace,
  source: Readonly<Record<string, number>>,
): Record<string, number> {
  const defaults: Record<string, number> = {};
  for (const axis of space.axes) {
    const value = source[axis.key];
    if (value === undefined) {
      throw new Error(`No numeric default for ${axis.key}`);
    }
    defaults[axis.key] = value;
  }
  return defaults;
}

/**
 * Full factorial when it fits in `maxTrials`. Otherwise a seeded discrete Latin
 * hypercube: each level appears floor(n/k) or ceil(n/k) times, axes are shuffled
 * independently, and today's defaults occupy slot 0.
 */
export function sampleSearchSpace(
  space: SearchSpace,
  maxTrials: number,
  seed: number,
  defaults: Readonly<Record<string, number>>,
): SearchSample {
  assertSpace(space);
  if (!Number.isInteger(maxTrials) || maxTrials < 1) {
    throw new Error("--max-trials requires a positive integer");
  }
  const all = enumerateValid(space);
  if (all.length === 0) {
    throw new Error("Search space has no valid parameter combinations");
  }
  const defaultsVariant = variantFromDefaults(space, defaults);
  if (all.length <= maxTrials) {
    return { variants: placeDefaults(all, defaultsVariant), exhaustive: true };
  }
  const sampled = latinHypercube(space, maxTrials, seed);
  return { variants: placeDefaults(sampled, defaultsVariant), exhaustive: false };
}

/**
 * Median Sharpe of a feasible set and its evaluated one-step neighbors.
 * A set with no evaluated neighbor cannot win. Ties break on vs-hold, profit
 * factor, then fewer differences from the defaults.
 */
export function pickNeighborhoodWinner(
  scored: readonly ScoredVariant[],
  space: SearchSpace,
): ScoredVariant | undefined {
  const byKey = new Map(scored.map((row) => [variantKey(row.variant), row]));
  let best: ScoredVariant | undefined;
  let bestMedian = 0;
  for (const candidate of scored) {
    if (!candidate.feasible) continue;
    const neighborSharpes: number[] = [];
    for (const neighbor of neighborVariants(space, candidate.variant)) {
      const scoredNeighbor = byKey.get(variantKey(neighbor));
      if (scoredNeighbor !== undefined) {
        neighborSharpes.push(scoredNeighbor.sharpeRatio);
      }
    }
    if (neighborSharpes.length === 0) continue;
    const score = median([candidate.sharpeRatio, ...neighborSharpes]);
    if (
      best === undefined ||
      score > bestMedian ||
      (score === bestMedian && preferOnTie(candidate, best))
    ) {
      best = candidate;
      bestMedian = score;
    }
  }
  return best;
}

/** Anchored walk-forward windows. Fold 1 is train-only; later folds test one slice. */
export function walkForwardWindows(candles: Candle[], nFolds: number): WalkForwardWindow[] {
  if (!Number.isInteger(nFolds) || nFolds < 2) {
    throw new Error("--folds requires an integer ≥ 2");
  }
  const folds = splitCandlesIntoFolds(candles, nFolds);
  if (folds.length < 2) {
    throw new Error(
      `Tune requires at least 2 non-empty folds but got ${folds.length} ` +
        `(only ${candles.length} candles for ${nFolds} folds)`,
    );
  }
  const windows: WalkForwardWindow[] = [];
  for (let index = 1; index < folds.length; index++) {
    const train = folds.slice(0, index).flat();
    const test = folds[index];
    if (test === undefined || train.length === 0) {
      throw new Error(`Fold ${index + 1} is empty`);
    }
    const trainEnd = train[train.length - 1]?.time;
    const testStart = test[0]?.time;
    if (trainEnd === undefined || testStart === undefined || !(trainEnd < testStart)) {
      throw new Error("Train window overlaps the test fold");
    }
    windows.push({ fold: index + 1, train, test });
  }
  return windows;
}

export function parseTuneArgs(argv: string[]): TuneCliOptions {
  let fromTime: number | undefined;
  let toTime: number | undefined;
  let days: number | undefined;
  let strategy: string | undefined;
  let folds = TUNE_DEFAULT_FOLDS;
  let maxTrials = TUNE_DEFAULT_MAX_TRIALS;
  let seed = TUNE_DEFAULT_SEED;
  let minTrades = TUNE_DEFAULT_MIN_TRADES;
  let maxDrawdownPct = TUNE_DEFAULT_MAX_DRAWDOWN_PCT;
  let minReturnPct = TUNE_DEFAULT_MIN_RETURN_PCT;
  let minProfitFactor = TUNE_DEFAULT_MIN_PROFIT_FACTOR;
  let jobs = os.availableParallelism();
  let quotes: "1m" | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--from" || arg?.startsWith("--from=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--from");
      fromTime = parseBacktestDate(value, "from");
      i = nextIndex;
      continue;
    }
    if (arg === "--to" || arg?.startsWith("--to=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--to");
      toTime = parseBacktestDate(value, "to");
      i = nextIndex;
      continue;
    }
    if (arg === "--days" || arg?.startsWith("--days=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--days");
      days = positiveInt(value, "--days");
      i = nextIndex;
      continue;
    }
    if (arg === "--strategy" || arg?.startsWith("--strategy=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--strategy");
      strategy = value;
      i = nextIndex;
      continue;
    }
    if (arg === "--folds" || arg?.startsWith("--folds=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--folds");
      folds = positiveInt(value, "--folds");
      if (folds < 2) throw new Error("--folds requires an integer ≥ 2");
      i = nextIndex;
      continue;
    }
    if (arg === "--max-trials" || arg?.startsWith("--max-trials=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--max-trials");
      maxTrials = positiveInt(value, "--max-trials");
      i = nextIndex;
      continue;
    }
    if (arg === "--seed" || arg?.startsWith("--seed=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--seed");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid --seed value: ${value}`);
      }
      seed = parsed;
      i = nextIndex;
      continue;
    }
    if (arg === "--min-trades" || arg?.startsWith("--min-trades=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--min-trades");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid --min-trades value: ${value}`);
      }
      minTrades = parsed;
      i = nextIndex;
      continue;
    }
    if (arg === "--quotes" || arg?.startsWith("--quotes=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--quotes");
      if (value !== "1m") {
        throw new Error("--quotes only accepts 1m");
      }
      quotes = "1m";
      i = nextIndex;
      continue;
    }
    if (arg === "--jobs" || arg?.startsWith("--jobs=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--jobs");
      jobs = positiveInt(value, "--jobs");
      i = nextIndex;
      continue;
    }
    if (arg === "--max-dd" || arg?.startsWith("--max-dd=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--max-dd");
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --max-dd value: ${value}`);
      }
      maxDrawdownPct = parsed;
      i = nextIndex;
      continue;
    }
    if (arg === "--min-return" || arg?.startsWith("--min-return=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--min-return");
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid --min-return value: ${value}`);
      }
      minReturnPct = parsed;
      i = nextIndex;
      continue;
    }
    if (arg === "--min-pf" || arg?.startsWith("--min-pf=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--min-pf");
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --min-pf value: ${value}`);
      }
      minProfitFactor = parsed;
      i = nextIndex;
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new Error(`Unknown tune option: ${arg}`);
    }
  }

  if (fromTime !== undefined && days !== undefined) {
    throw new Error("Use either --days or --from/--to, not both");
  }
  if (toTime !== undefined && fromTime === undefined) {
    throw new Error("--to requires --from");
  }
  if (fromTime !== undefined && toTime !== undefined && !(fromTime < toTime)) {
    throw new Error("--from must be before --to");
  }

  const result: TuneCliOptions = {
    folds,
    maxTrials,
    seed,
    minTrades,
    maxDrawdownPct,
    minReturnPct,
    minProfitFactor,
    jobs,
  };
  if (fromTime !== undefined) result.fromTime = fromTime;
  if (toTime !== undefined) result.toTime = toTime;
  if (days !== undefined) result.days = days;
  if (strategy !== undefined) result.strategy = strategy;
  if (quotes !== undefined) result.quotes = quotes;
  return result;
}

/**
 * Pick parameters on each anchored train window and score that single set on
 * the next fold. Candles load once per pair. The default path is the synthetic
 * OHLC walk. `quotes: "1m"` steps each signal bar on real minute closes.
 */
export async function runTune(options: RunTuneOptions): Promise<TuneResult[]> {
  const window = replayWindow(options);
  const probe = await SimpleStrategyManager.create({
    strategyId: options.strategyId,
    htf: options.config.htf,
  });
  const strategy = probe.getActiveStrategy();
  const space = options.space ?? strategy;
  const defaults = defaultLevels(space, strategy.getSearchDefaults());
  const timeframe = strategy.getRequiredCandles().timeframe;
  const market = createMarket(options.config.candleSource, options.config.birdeyeApiKey);
  const skipNetwork = options.candles !== undefined;
  // Other signal timeframes named by a `timeframe` axis. Injected candles skip them.
  const altTimeframes: Timeframe[] = skipNetwork
    ? []
    : (space.axes.find((axis) => axis.key === "timeframe")?.levels ?? [])
        .map((minutes) => timeframeFromMinutes(minutes))
        .filter((label): label is Timeframe => label !== undefined && label !== timeframe);

  const results: TuneResult[] = [];
  for (const pair of options.config.pairs) {
    const [candles, htfCandles, mtfCandles] = await Promise.all([
      options.candles ??
        market.fetchCandles({
          pair,
          timeframe,
          fromTime: window.fromTime,
          toTime: window.toTime,
        }),
      loadHtfCandles({
        pair,
        market,
        strategyManager: probe,
        fromTime: window.fromTime,
        toTime: window.toTime,
        injected: options.htfCandles,
        skipFetch: skipNetwork && options.htfCandles === undefined,
      }),
      loadMtfCandles({
        pair,
        market,
        strategyManager: probe,
        fromTime: window.fromTime,
        toTime: window.toTime,
        injected: options.mtfCandles,
        skipFetch: skipNetwork && options.mtfCandles === undefined,
      }),
    ]);
    const altCandles: Record<string, Candle[]> = {};
    for (const label of altTimeframes) {
      altCandles[label] = await market.fetchCandles({
        pair,
        timeframe: label,
        fromTime: window.fromTime,
        toTime: window.toTime,
      });
      if (altCandles[label]?.length === 0) {
        throw new Error(`No candles for ${pair.symbol} (${label}) in the replay window`);
      }
    }
    if (candles.length === 0) {
      throw new Error(
        `No candles for ${pair.symbol} (${timeframe}) in ` +
          `${new Date(window.fromTime * 1000).toISOString()} → ${new Date(window.toTime * 1000).toISOString()}`,
      );
    }
    const minuteCandles = await loadTuneMinutes({
      quotes: options.quotes,
      injected: options.minuteCandles,
      skipNetwork,
      market,
      pair,
      candles,
    });
    results.push(
      await tunePair({
        pair,
        config: { ...options.config, pairs: [pair] },
        strategy,
        strategyId: options.strategyId,
        space,
        defaults,
        candles,
        altCandles,
        htfCandles,
        mtfCandles,
        ...(minuteCandles !== undefined ? { minuteCandles } : {}),
        folds: options.folds,
        maxTrials: options.maxTrials,
        seed: options.seed,
        minTrades: options.minTrades,
        maxDrawdownPct: options.maxDrawdownPct,
        gates: {
          minTrades: options.minTrades,
          maxDrawdownPct: options.maxDrawdownPct,
          ...(options.minReturnPct !== undefined ? { minReturnPct: options.minReturnPct } : {}),
          ...(options.minProfitFactor !== undefined
            ? { minProfitFactor: options.minProfitFactor }
            : {}),
        },
        jobs: options.jobs ?? 1,
      }),
    );
  }
  return results;
}

export function printTuneReport(result: TuneResult): void {
  const trials = result.folds[0]?.trials ?? 0;
  console.log(
    `=== Tune ${result.pair} | ${result.strategyId} | folds ${result.folds.length + 1} | ` +
      `trials ${trials} ===`,
  );
  for (const fold of result.folds) {
    console.log(
      `Fold ${fold.fold} train ${fmtDay(fold.trainFrom)} → ${fmtDay(fold.trainTo)} | ` +
        `test ${fmtDay(fold.testFrom)} → ${fmtDay(fold.testTo)} ` +
        `(${fold.trials} trials${fold.exhaustive ? ", full grid" : ""})`,
    );
    console.log(
      fold.selected === undefined
        ? "  selected: none (no stable neighborhood; out-of-sample uses defaults)"
        : `  selected: ${fmtValues(fold.selected)}`,
    );
    if (fold.trainMetrics !== undefined) {
      console.log(fmtMetrics("  IS ", fold.trainMetrics));
    }
    console.log(fmtMetrics("  OOS", fold.oosMetrics));
    console.log(fmtMetrics("  baseline OOS", fold.baselineMetrics));
  }
  console.log(
    `OOS compounded return: search ${result.oosReturnPct.toFixed(2)}% ` +
      `(mean sharpe ${result.oosSharpe.toFixed(2)}) | ` +
      `defaults ${result.baselineReturnPct.toFixed(2)}% ` +
      `(mean sharpe ${result.baselineSharpe.toFixed(2)})`,
  );
  console.log(
    result.nextParams === undefined
      ? "Next params: none"
      : `Next params: ${fmtValues(result.nextParams)}`,
  );
  console.log(
    `Positive test folds: ${result.positiveFolds}/${result.folds.length} ` +
      `(search) | defaults: ${result.folds.filter((fold) => fold.baselineMetrics.totalReturnPct > 0).length}/${result.folds.length}`,
  );
  if (result.keepDefaults) {
    console.log(`Keep defaults: ${result.keepReasons.join("; ")}.`);
  } else {
    console.log("Use the next params.");
  }
}

function replayWindow(options: RunTuneOptions): { fromTime: number; toTime: number } {
  if (options.fromTime !== undefined) {
    return resolveReplayWindow({
      fromTime: options.fromTime,
      ...(options.toTime !== undefined ? { toTime: options.toTime } : {}),
    });
  }
  return resolveReplayWindow({ days: options.days ?? TUNE_DEFAULT_DAYS });
}

interface ReplayRequest {
  patch?: StrategyParamPatch;
  start: number;
  /** Exclusive index into the pair's signal candles. */
  end: number;
}

interface FoldBound {
  fold: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

interface Wave1Item {
  kind: "trial" | "baseline";
  foldIndex: number;
  variantIndex?: number;
  request: ReplayRequest;
}

interface ReplayContext {
  config: AppConfig;
  strategyId: string;
  candles: Candle[];
  /** Signal candles for the other timeframes on the search axis, by label. */
  altCandles: Record<string, Candle[]>;
  htfCandles: Candle[];
  mtfCandles: Candle[];
  /** Time-sorted 1m candles. Present only for a `--quotes 1m` tune. */
  minuteCandles?: Candle[];
  pool?: ReplayPool;
}

/** Write values at their sample indexes, ignoring completion order. */
export function placeByIndex<T>(
  count: number,
  entries: readonly { index: number; value: T }[],
): T[] {
  const slots: (T | undefined)[] = Array.from({ length: count }, () => undefined);
  for (const entry of entries) {
    if (entry.index < 0 || entry.index >= count || slots[entry.index] !== undefined) {
      throw new Error(`Duplicate or invalid replay index ${entry.index}`);
    }
    slots[entry.index] = entry.value;
  }
  const out: T[] = [];
  for (const slot of slots) {
    if (slot === undefined) {
      throw new Error("Missing replay result");
    }
    out.push(slot);
  }
  return out;
}

function foldBounds(candles: Candle[], nFolds: number): FoldBound[] {
  const folds = splitCandlesIntoFolds(candles, nFolds);
  const windows = walkForwardWindows(candles, nFolds);
  let offset = 0;
  const ranges = folds.map((fold) => {
    const start = offset;
    offset += fold.length;
    return { start, end: offset };
  });
  return windows.map((window, index) => {
    const train = ranges[index];
    const test = ranges[index + 1];
    if (train === undefined || test === undefined) {
      throw new Error(`Fold ${window.fold} is missing its candle range`);
    }
    return {
      fold: window.fold,
      trainStart: 0,
      trainEnd: train.end,
      testStart: test.start,
      testEnd: test.end,
    };
  });
}

async function tunePair(args: {
  pair: PairConfig;
  config: AppConfig;
  strategy: Strategy;
  strategyId: string;
  space: SearchSpace;
  defaults: Readonly<Record<string, number>>;
  candles: Candle[];
  altCandles: Record<string, Candle[]>;
  htfCandles: Candle[];
  mtfCandles: Candle[];
  folds: number;
  maxTrials: number;
  seed: number;
  minTrades: number;
  maxDrawdownPct: number;
  gates: TrialGates;
  jobs: number;
  /** Time-sorted 1m candles covering the signal series. */
  minuteCandles?: Candle[];
}): Promise<TuneResult> {
  const bounds = foldBounds(args.candles, args.folds);
  const sample = sampleSearchSpace(args.space, args.maxTrials, args.seed, args.defaults);
  const wave1 = wave1Requests(bounds, sample, args.strategy);
  const workerCount = Math.min(Math.max(1, args.jobs), wave1.length);
  const pool =
    workerCount > 1
      ? await ReplayPool.open(workerCount, {
          config: args.config,
          strategyId: args.strategyId,
          candles: args.candles,
          altCandles: args.altCandles,
          htfCandles: args.htfCandles,
          mtfCandles: args.mtfCandles,
          ...(args.minuteCandles !== undefined ? { minuteCandles: args.minuteCandles } : {}),
        })
      : undefined;
  try {
    if (pool !== undefined) {
      console.log(`[${args.pair.symbol}] ${workerCount} workers`);
    }
    for (const bound of bounds) {
      console.log(
        `[${args.pair.symbol}] fold ${bound.fold}: scoring ${sample.variants.length} train trials` +
          (sample.exhaustive ? " (full grid)" : " (latin hypercube)"),
      );
    }
    const ctx: ReplayContext = {
      config: args.config,
      strategyId: args.strategyId,
      candles: args.candles,
      altCandles: args.altCandles,
      htfCandles: args.htfCandles,
      mtfCandles: args.mtfCandles,
      ...(args.minuteCandles !== undefined ? { minuteCandles: args.minuteCandles } : {}),
      ...(pool !== undefined ? { pool } : {}),
    };
    const first = await runRequests(
      wave1.map((item) => item.request),
      ctx,
    );
    const trials = bounds.map(() => [] as BacktestMetrics[]);
    const baselines: BacktestMetrics[] = [];
    const metricsByFold = bounds.map(() => new Map<string, BacktestMetrics>());
    for (let i = 0; i < wave1.length; i++) {
      const item = wave1[i]!;
      const metrics = first[i];
      if (metrics === undefined) {
        throw new Error(`Fold ${bounds[item.foldIndex]?.fold ?? item.foldIndex} missed a replay`);
      }
      if (item.kind === "baseline") {
        baselines[item.foldIndex] = metrics;
        continue;
      }
      const variant = sample.variants[item.variantIndex ?? -1];
      if (variant === undefined) {
        throw new Error(`Fold ${bounds[item.foldIndex]?.fold} missed a train variant`);
      }
      trials[item.foldIndex]![item.variantIndex ?? 0] = metrics;
      metricsByFold[item.foldIndex]!.set(variantKey(variant), metrics);
    }

    const scoredByFold = bounds.map((_, foldIndex) =>
      sample.variants.map((variant, variantIndex) => {
        const metrics = trials[foldIndex]?.[variantIndex];
        if (metrics === undefined) {
          throw new Error(`Fold ${bounds[foldIndex]?.fold} missed train metrics`);
        }
        return toScored(variant, metrics, args.gates, args.defaults);
      }),
    );

    const neighborWave: { foldIndex: number; variant: SampledVariant; request: ReplayRequest }[] =
      [];
    if (!sample.exhaustive) {
      for (let foldIndex = 0; foldIndex < bounds.length; foldIndex++) {
        const scored = scoredByFold[foldIndex]!;
        const extra = missingNeighborVariants(
          args.space,
          topFeasible(scored, NEIGHBOR_FILL_LEADERS),
          scored,
        );
        const bound = bounds[foldIndex]!;
        if (extra.length > 0) {
          console.log(
            `[${args.pair.symbol}] fold ${bound.fold}: scoring ${extra.length} neighbor trials`,
          );
        }
        for (const variant of extra) {
          neighborWave.push({
            foldIndex,
            variant,
            request: {
              patch: args.strategy.paramPatch(variant.values),
              start: bound.trainStart,
              end: bound.trainEnd,
            },
          });
        }
      }
    }
    const neighborMetrics = await runRequests(
      neighborWave.map((item) => item.request),
      ctx,
    );
    for (let i = 0; i < neighborWave.length; i++) {
      const item = neighborWave[i]!;
      const metrics = neighborMetrics[i];
      if (metrics === undefined) {
        throw new Error(`Fold ${bounds[item.foldIndex]?.fold} missed a neighbor replay`);
      }
      metricsByFold[item.foldIndex]!.set(variantKey(item.variant), metrics);
      scoredByFold[item.foldIndex]!.push(
        toScored(item.variant, metrics, args.gates, args.defaults),
      );
    }

    const winners = scoredByFold.map((scored) => pickNeighborhoodWinner(scored, args.space));
    const oosWave: { foldIndex: number; request: ReplayRequest }[] = [];
    for (let foldIndex = 0; foldIndex < bounds.length; foldIndex++) {
      const winner = winners[foldIndex];
      if (winner === undefined) continue;
      const bound = bounds[foldIndex]!;
      oosWave.push({
        foldIndex,
        request: {
          patch: args.strategy.paramPatch(winner.variant.values),
          start: bound.testStart,
          end: bound.testEnd,
        },
      });
    }
    const oosMetricsList = await runRequests(
      oosWave.map((item) => item.request),
      ctx,
    );
    const oosByFold = new Map<number, BacktestMetrics>();
    for (let i = 0; i < oosWave.length; i++) {
      const metrics = oosMetricsList[i];
      if (metrics === undefined) {
        throw new Error("Missing out-of-sample replay");
      }
      oosByFold.set(oosWave[i]!.foldIndex, metrics);
    }

    const foldResults: TuneFoldResult[] = bounds.map((bound, foldIndex) => {
      const baseline = baselines[foldIndex];
      if (baseline === undefined) {
        throw new Error(`Fold ${bound.fold} is missing its baseline`);
      }
      const winner = winners[foldIndex];
      const oos = winner === undefined ? baseline : oosByFold.get(foldIndex);
      if (oos === undefined) {
        throw new Error(`Fold ${bound.fold} is missing its out-of-sample replay`);
      }
      const train = candleRange(args.candles.slice(bound.trainStart, bound.trainEnd));
      const test = candleRange(args.candles.slice(bound.testStart, bound.testEnd));
      const foldResult: TuneFoldResult = {
        fold: bound.fold,
        trainFrom: train.from,
        trainTo: train.to,
        testFrom: test.from,
        testTo: test.to,
        trials: scoredByFold[foldIndex]!.length,
        exhaustive: sample.exhaustive,
        oosMetrics: oos,
        baselineMetrics: baseline,
      };
      if (winner !== undefined) {
        const trainMetrics = metricsByFold[foldIndex]!.get(variantKey(winner.variant));
        if (trainMetrics === undefined) {
          throw new Error(`Fold ${bound.fold} winner is missing its train metrics`);
        }
        foldResult.selected = winner.variant.values;
        foldResult.trainMetrics = trainMetrics;
      }
      return foldResult;
    });

    const oosReturnPct = compoundReturn(foldResults.map((fold) => fold.oosMetrics.totalReturnPct));
    const baselineReturnPct = compoundReturn(
      foldResults.map((fold) => fold.baselineMetrics.totalReturnPct),
    );
    const result: TuneResult = {
      pair: args.pair.symbol,
      strategyId: args.strategyId,
      folds: foldResults,
      oosReturnPct,
      oosSharpe: mean(foldResults.map((fold) => fold.oosMetrics.sharpeRatio)),
      baselineReturnPct,
      baselineSharpe: mean(foldResults.map((fold) => fold.baselineMetrics.sharpeRatio)),
      ...verdict(foldResults, oosReturnPct),
    };
    const last = foldResults[foldResults.length - 1];
    if (last?.selected !== undefined) {
      result.nextParams = last.selected;
    }
    return result;
  } finally {
    await pool?.close();
  }
}

/** Keep the defaults unless the stitched out-of-sample track is better and profitable. */
export function verdict(
  folds: readonly {
    oosMetrics: Pick<BacktestMetrics, "totalReturnPct" | "sharpeRatio">;
    baselineMetrics: Pick<BacktestMetrics, "sharpeRatio">;
  }[],
  oosReturnPct: number,
): { positiveFolds: number; keepDefaults: boolean; keepReasons: string[] } {
  const positiveFolds = folds.filter((fold) => fold.oosMetrics.totalReturnPct > 0).length;
  const searchSharpe = mean(folds.map((fold) => fold.oosMetrics.sharpeRatio));
  const baselineSharpe = mean(folds.map((fold) => fold.baselineMetrics.sharpeRatio));
  const keepReasons: string[] = [];
  if (!(searchSharpe > baselineSharpe)) {
    keepReasons.push(
      `mean OOS sharpe ${searchSharpe.toFixed(2)} does not beat defaults ${baselineSharpe.toFixed(2)}`,
    );
  }
  if (!(oosReturnPct > 0)) {
    keepReasons.push(`OOS compounded return ${oosReturnPct.toFixed(2)}% is not positive`);
  }
  if (positiveFolds * 3 < folds.length * 2) {
    keepReasons.push(`only ${positiveFolds}/${folds.length} test folds are positive (need 2/3)`);
  }
  return { positiveFolds, keepDefaults: keepReasons.length > 0, keepReasons };
}

function wave1Requests(
  bounds: readonly FoldBound[],
  sample: SearchSample,
  strategy: Strategy,
): Wave1Item[] {
  const items: Wave1Item[] = [];
  for (let foldIndex = 0; foldIndex < bounds.length; foldIndex++) {
    const bound = bounds[foldIndex]!;
    for (let variantIndex = 0; variantIndex < sample.variants.length; variantIndex++) {
      const variant = sample.variants[variantIndex]!;
      items.push({
        kind: "trial",
        foldIndex,
        variantIndex,
        request: {
          patch: strategy.paramPatch(variant.values),
          start: bound.trainStart,
          end: bound.trainEnd,
        },
      });
    }
    items.push({
      kind: "baseline",
      foldIndex,
      request: { start: bound.testStart, end: bound.testEnd },
    });
  }
  return items;
}

async function runRequests(
  requests: readonly ReplayRequest[],
  ctx: ReplayContext,
): Promise<BacktestMetrics[]> {
  if (requests.length === 0) return [];
  if (ctx.pool === undefined) {
    const out: BacktestMetrics[] = [];
    for (const request of requests) {
      out.push(await replaySlice(ctx, request));
    }
    return out;
  }
  return ctx.pool.run(requests);
}

/**
 * Signal candles for one replay. The request indexes the primary series. A patch
 * that names another timeframe replays the same time span on that series.
 */
export function replayCandles(
  primary: readonly Candle[],
  alt: Readonly<Record<string, readonly Candle[]>>,
  request: { patch?: StrategyParamPatch; start: number; end: number },
): Candle[] {
  const timeframe = request.patch?.timeframe;
  if (timeframe === undefined || timeframe === primary[0]?.timeframe) {
    return primary.slice(request.start, request.end);
  }
  const series = alt[timeframe];
  const first = primary[request.start];
  const last = primary[request.end - 1];
  if (series === undefined || first === undefined || last === undefined) {
    throw new Error(`No ${timeframe} candles loaded for this replay`);
  }
  const until = last.time + last.intervalSeconds;
  return series.filter((candle) => candle.time >= first.time && candle.time < until);
}

async function replaySlice(ctx: ReplayContext, request: ReplayRequest): Promise<BacktestMetrics> {
  return replayMetrics({
    config: ctx.config,
    strategyId: ctx.strategyId,
    candles: replayCandles(ctx.candles, ctx.altCandles, request),
    htfCandles: ctx.htfCandles,
    mtfCandles: ctx.mtfCandles,
    ...(ctx.minuteCandles !== undefined ? { minuteCandles: ctx.minuteCandles } : {}),
    ...(request.patch !== undefined ? { patch: request.patch } : {}),
  });
}

async function loadTuneMinutes(args: {
  quotes: "1m" | undefined;
  injected: Candle[] | undefined;
  skipNetwork: boolean;
  market: ReturnType<typeof createMarket>;
  pair: PairConfig;
  candles: Candle[];
}): Promise<Candle[] | undefined> {
  if (args.quotes !== "1m") return undefined;
  if (args.injected !== undefined) return args.injected;
  if (args.skipNetwork) {
    throw new Error("quotes 1m requires minute candles when signal candles are injected");
  }
  const first = args.candles[0];
  const last = args.candles[args.candles.length - 1];
  if (first === undefined || last === undefined) return [];
  return args.market.fetchCandles({
    pair: args.pair,
    timeframe: "1m",
    fromTime: first.time,
    toTime: last.time + last.intervalSeconds,
  });
}

async function replayMetrics(args: {
  config: AppConfig;
  strategyId: string;
  candles: Candle[];
  htfCandles: Candle[];
  mtfCandles: Candle[];
  minuteCandles?: Candle[];
  patch?: StrategyParamPatch;
}): Promise<BacktestMetrics> {
  const strategyManager = await SimpleStrategyManager.create({
    strategyId: args.strategyId,
    htf: args.config.htf,
    ...(args.patch !== undefined ? { paramPatch: args.patch } : {}),
  });
  const [result] = await runBacktest({
    config: args.config,
    strategyManager,
    candles: args.candles,
    htfCandles: args.htfCandles,
    mtfCandles: args.mtfCandles,
    ...(args.minuteCandles !== undefined
      ? { quotes: "1m" as const, minuteCandles: args.minuteCandles }
      : {}),
  });
  if (result === undefined) {
    throw new Error("Backtest returned no results");
  }
  return result.metrics;
}

/** Eligibility gates for a train trial. Absent return/PF gates are off. */
export interface TrialGates {
  minTrades: number;
  maxDrawdownPct: number;
  minReturnPct?: number;
  minProfitFactor?: number;
}

/** True when a trial's metrics clear every gate. */
export function passesGates(
  metrics: Pick<
    BacktestMetrics,
    "roundTrips" | "maxDrawdownPct" | "totalReturnPct" | "profitFactor"
  >,
  gates: TrialGates,
): boolean {
  if (metrics.roundTrips < gates.minTrades) return false;
  if (metrics.maxDrawdownPct > gates.maxDrawdownPct) return false;
  if (gates.minReturnPct !== undefined && !(metrics.totalReturnPct > gates.minReturnPct)) {
    return false;
  }
  if (gates.minProfitFactor !== undefined && !(metrics.profitFactor >= gates.minProfitFactor)) {
    return false;
  }
  return true;
}

function toScored(
  variant: SampledVariant,
  metrics: BacktestMetrics,
  gates: TrialGates,
  defaults: Readonly<Record<string, number>>,
): ScoredVariant {
  return {
    variant,
    sharpeRatio: metrics.sharpeRatio,
    vsHoldReturnPct: metrics.vsHoldReturnPct,
    totalReturnPct: metrics.totalReturnPct,
    profitFactor: metrics.profitFactor,
    roundTrips: metrics.roundTrips,
    maxDrawdownPct: metrics.maxDrawdownPct,
    feasible: passesGates(metrics, gates),
    distanceFromDefaults: distanceFromDefaults(variant.values, defaults),
  };
}

function topFeasible(scored: readonly ScoredVariant[], limit: number): ScoredVariant[] {
  return scored
    .filter((row) => row.feasible)
    .sort(compareRaw)
    .slice(0, limit);
}

function missingNeighborVariants(
  space: SearchSpace,
  leaders: readonly ScoredVariant[],
  scored: readonly ScoredVariant[],
): SampledVariant[] {
  const seen = new Set(scored.map((row) => variantKey(row.variant)));
  const extra: SampledVariant[] = [];
  for (const leader of leaders) {
    for (const neighbor of neighborVariants(space, leader.variant)) {
      const key = variantKey(neighbor);
      if (seen.has(key)) continue;
      seen.add(key);
      extra.push(neighbor);
    }
  }
  return extra;
}

function compareRaw(a: ScoredVariant, b: ScoredVariant): number {
  if (a.sharpeRatio !== b.sharpeRatio) return b.sharpeRatio - a.sharpeRatio;
  if (a.vsHoldReturnPct !== b.vsHoldReturnPct) return b.vsHoldReturnPct - a.vsHoldReturnPct;
  const profit = cappedProfitFactor(b.profitFactor) - cappedProfitFactor(a.profitFactor);
  if (profit !== 0) return profit;
  return a.distanceFromDefaults - b.distanceFromDefaults;
}

function preferOnTie(candidate: ScoredVariant, best: ScoredVariant): boolean {
  if (candidate.vsHoldReturnPct !== best.vsHoldReturnPct) {
    return candidate.vsHoldReturnPct > best.vsHoldReturnPct;
  }
  const profit = cappedProfitFactor(candidate.profitFactor) - cappedProfitFactor(best.profitFactor);
  if (profit !== 0) return profit > 0;
  return candidate.distanceFromDefaults < best.distanceFromDefaults;
}

function cappedProfitFactor(value: number): number {
  return Number.isFinite(value) ? value : PROFIT_FACTOR_CAP;
}

function neighborVariants(space: SearchSpace, variant: SampledVariant): SampledVariant[] {
  const neighbors: SampledVariant[] = [];
  for (let axisIndex = 0; axisIndex < space.axes.length; axisIndex++) {
    const axis = space.axes[axisIndex];
    const current = variant.indexes[axisIndex];
    if (axis === undefined || current === undefined) continue;
    for (const next of [current - 1, current + 1]) {
      if (next < 0 || next >= axis.levels.length) continue;
      const indexes = [...variant.indexes];
      indexes[axisIndex] = next;
      const values: Record<string, number> = { ...variant.values, [axis.key]: axis.levels[next]! };
      if (space.accept !== undefined && !space.accept(values)) continue;
      neighbors.push({ indexes, values });
    }
  }
  return neighbors;
}

function enumerateValid(space: SearchSpace): SampledVariant[] {
  const out: SampledVariant[] = [];
  const indexes = space.axes.map(() => 0);
  const walk = (axisIndex: number): void => {
    if (axisIndex === space.axes.length) {
      const values: Record<string, number> = {};
      for (let i = 0; i < space.axes.length; i++) {
        const axis = space.axes[i]!;
        values[axis.key] = axis.levels[indexes[i]!]!;
      }
      if (space.accept !== undefined && !space.accept(values)) return;
      out.push({ indexes: [...indexes], values });
      return;
    }
    const axis = space.axes[axisIndex];
    if (axis === undefined) return;
    for (let level = 0; level < axis.levels.length; level++) {
      indexes[axisIndex] = level;
      walk(axisIndex + 1);
    }
  };
  walk(0);
  return out;
}

/**
 * Discrete Latin hypercube. Unconstrained spaces retry until the zipped rows
 * are unique so each level keeps its floor/ceil count. Constrained spaces
 * keep valid unique rows and top up from later shuffles.
 */
function latinHypercube(space: SearchSpace, count: number, seed: number): SampledVariant[] {
  const rngs = space.axes.map((_, axisIndex) => mulberry32((seed + axisIndex) >>> 0));
  if (space.accept === undefined) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const rows = zipBalanced(space, count, rngs);
      if (rows !== undefined) return rows;
    }
  }
  const seen = new Set<string>();
  const out: SampledVariant[] = [];
  for (let round = 0; round < 64 && out.length < count; round++) {
    const width = Math.max(count, ...space.axes.map((axis) => axis.levels.length));
    const columns = space.axes.map((axis, axisIndex) =>
      balancedLevels(axis.levels, width, rngs[axisIndex]!),
    );
    for (let index = 0; index < width && out.length < count; index++) {
      const row = rowAt(space, columns, index);
      if (row === undefined) continue;
      const key = variantKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  if (out.length < count) {
    throw new Error(`Search space produced ${out.length} variants, fewer than ${count} trials`);
  }
  return out;
}

function zipBalanced(
  space: SearchSpace,
  count: number,
  rngs: readonly (() => number)[],
): SampledVariant[] | undefined {
  const columns = space.axes.map((axis, axisIndex) =>
    balancedLevels(axis.levels, count, rngs[axisIndex]!),
  );
  const rows: SampledVariant[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index++) {
    const row = rowAt(space, columns, index);
    if (row === undefined) return undefined;
    const key = variantKey(row);
    if (seen.has(key)) return undefined;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

function balancedLevels(levels: readonly number[], count: number, rng: () => number): number[] {
  const column: number[] = [];
  for (let i = 0; i < count; i++) {
    column.push(levels[i % levels.length]!);
  }
  for (let i = column.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = column[i]!;
    column[i] = column[j]!;
    column[j] = swap;
  }
  return column;
}

function rowAt(
  space: SearchSpace,
  columns: readonly (readonly number[])[],
  index: number,
): SampledVariant | undefined {
  const indexes: number[] = [];
  const values: Record<string, number> = {};
  for (let axisIndex = 0; axisIndex < space.axes.length; axisIndex++) {
    const axis = space.axes[axisIndex];
    const level = columns[axisIndex]?.[index];
    if (axis === undefined || level === undefined) return undefined;
    const levelIndex = axis.levels.indexOf(level);
    if (levelIndex < 0) return undefined;
    indexes.push(levelIndex);
    values[axis.key] = level;
  }
  if (space.accept !== undefined && !space.accept(values)) return undefined;
  return { indexes, values };
}

function placeDefaults(
  rows: readonly SampledVariant[],
  defaults: SampledVariant,
): SampledVariant[] {
  const key = variantKey(defaults);
  const rest = rows.filter((row) => variantKey(row) !== key);
  const placed = [defaults, ...rest];
  return placed.length === rows.length ? placed : placed.slice(0, rows.length);
}

function variantFromDefaults(
  space: SearchSpace,
  defaults: Readonly<Record<string, number>>,
): SampledVariant {
  const indexes: number[] = [];
  const values: Record<string, number> = {};
  for (const axis of space.axes) {
    const value = defaults[axis.key];
    if (value === undefined) {
      throw new Error(`Missing default for ${axis.key}`);
    }
    const index = axis.levels.indexOf(value);
    if (index < 0) {
      throw new Error(`Default ${axis.key}=${value} is not a search level`);
    }
    indexes.push(index);
    values[axis.key] = value;
  }
  if (space.accept !== undefined && !space.accept(values)) {
    throw new Error("Default parameters are outside the search constraint");
  }
  return { indexes, values };
}

function variantKey(variant: SampledVariant): string {
  return variant.indexes.join(",");
}

function assertSpace(space: SearchSpace): void {
  if (space.axes.length === 0) {
    throw new Error("Search space has no axes");
  }
  for (const axis of space.axes) {
    if (axis.levels.length === 0) {
      throw new Error(`Search axis ${axis.key} has no levels`);
    }
    if (new Set(axis.levels).size !== axis.levels.length) {
      throw new Error(`Search axis ${axis.key} has duplicate levels`);
    }
  }
}

function distanceFromDefaults(
  values: Readonly<Record<string, number>>,
  defaults: Readonly<Record<string, number>>,
): number {
  let distance = 0;
  for (const [key, value] of Object.entries(values)) {
    if (defaults[key] !== value) distance += 1;
  }
  return distance;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compoundReturn(returnsPct: readonly number[]): number {
  let multiplier = 1;
  for (const value of returnsPct) {
    multiplier *= 1 + value / 100;
  }
  return (multiplier - 1) * 100;
}

function candleRange(candles: Candle[]): { from: number; to: number } {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("Candle range is empty");
  }
  return { from: first.time, to: last.time + last.intervalSeconds };
}

function positiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${raw}`);
  }
  return parsed;
}

function fmtDay(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

function fmtValues(values: Readonly<Record<string, number>>): string {
  return Object.entries(values)
    .map(([key, value]) =>
      key === "timeframe"
        ? `timeframe=${timeframeFromMinutes(value) ?? `${String(value)}m`}`
        : `${key}=${String(value)}`,
    )
    .join(" ");
}

function fmtMetrics(prefix: string, metrics: BacktestMetrics): string {
  return (
    `${prefix} sharpe ${metrics.sharpeRatio.toFixed(2)} | ` +
    `return ${metrics.totalReturnPct.toFixed(2)}% | ` +
    `dd ${metrics.maxDrawdownPct.toFixed(2)}% | ` +
    `trades ${metrics.roundTrips}`
  );
}

interface CandlePayload {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timeframe: Timeframe;
  source: CandleSource;
}

interface PoolInit {
  config: AppConfig;
  strategyId: string;
  candles: Candle[];
  altCandles: Record<string, Candle[]>;
  htfCandles: Candle[];
  mtfCandles: Candle[];
  /** Time-sorted 1m candles. Present only for a `--quotes 1m` tune. */
  minuteCandles?: Candle[];
}

interface WorkerInitMessage {
  kind: "init";
  config: AppConfig;
  strategyId: string;
  candles: CandlePayload[];
  altCandles: Record<string, CandlePayload[]>;
  htfCandles: CandlePayload[];
  mtfCandles: CandlePayload[];
  minuteCandles?: CandlePayload[];
}

interface WorkerJobMessage {
  kind: "job";
  id: number;
  start: number;
  end: number;
  patch?: StrategyParamPatch;
}

type WorkerInbound = WorkerInitMessage | WorkerJobMessage;

interface PortableMetrics extends Omit<BacktestMetrics, "strategy"> {
  strategyId: string;
  strategyName: string;
}

type WorkerOutbound =
  | { kind: "ready" }
  | { kind: "result"; id: number; metrics: PortableMetrics }
  | { kind: "error"; id: number; message: string };

interface PoolTask {
  id: number;
  request: ReplayRequest;
  resolve: (metrics: BacktestMetrics) => void;
  reject: (error: Error) => void;
}

class ReplayPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly inflight = new Map<Worker, PoolTask>();
  private readonly queue: PoolTask[] = [];
  private nextId = 1;
  private closed = false;

  static async open(size: number, init: PoolInit): Promise<ReplayPool> {
    const pool = new ReplayPool();
    try {
      const workers = await Promise.all(Array.from({ length: size }, () => pool.spawn(init)));
      pool.idle.push(...workers);
      return pool;
    } catch (error) {
      await pool.close();
      throw error;
    }
  }

  async run(requests: readonly ReplayRequest[]): Promise<BacktestMetrics[]> {
    const entries: { index: number; value: BacktestMetrics }[] = [];
    await Promise.all(
      requests.map(async (request, index) => {
        const value = await this.enqueue(request);
        entries.push({ index, value });
      }),
    );
    return placeByIndex(requests.length, entries);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closed = new Error("Replay pool closed");
    for (const task of this.queue.splice(0)) task.reject(closed);
    for (const task of this.inflight.values()) task.reject(closed);
    this.inflight.clear();
    this.idle.length = 0;
    await Promise.all(this.workers.splice(0).map((worker) => worker.terminate()));
  }

  private spawn(init: PoolInit): Promise<Worker> {
    const worker = new Worker(new URL(import.meta.url), { execArgv: workerExecArgv() });
    this.workers.push(worker);
    const payload: WorkerInitMessage = {
      kind: "init",
      config: init.config,
      strategyId: init.strategyId,
      candles: candlePayload(init.candles),
      altCandles: Object.fromEntries(
        Object.entries(init.altCandles).map(([label, rows]) => [label, candlePayload(rows)]),
      ),
      htfCandles: candlePayload(init.htfCandles),
      mtfCandles: candlePayload(init.mtfCandles),
      ...(init.minuteCandles !== undefined
        ? { minuteCandles: candlePayload(init.minuteCandles) }
        : {}),
    };
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        worker.off("message", onMessage);
        reject(error);
      };
      const onMessage = (message: WorkerOutbound): void => {
        if (message.kind !== "ready") return;
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.on("message", (next: WorkerOutbound) => this.onMessage(worker, next));
        worker.on("error", (error: Error) => this.onCrash(worker, error));
        resolve(worker);
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.postMessage(payload);
    });
  }

  private enqueue(request: ReplayRequest): Promise<BacktestMetrics> {
    if (this.closed) return Promise.reject(new Error("Replay pool closed"));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.queue.push({ id, request, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (!this.closed && this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const task = this.queue.shift();
      if (worker === undefined || task === undefined) return;
      this.inflight.set(worker, task);
      const message: WorkerJobMessage = {
        kind: "job",
        id: task.id,
        start: task.request.start,
        end: task.request.end,
      };
      if (task.request.patch !== undefined) message.patch = task.request.patch;
      worker.postMessage(message);
    }
  }

  private onMessage(worker: Worker, message: WorkerOutbound): void {
    if (message.kind === "ready") return;
    const task = this.inflight.get(worker);
    this.inflight.delete(worker);
    if (task === undefined || this.closed) return;
    if (message.kind === "error") {
      task.reject(new Error(message.message));
    } else if (message.id === task.id) {
      task.resolve(fromPortable(message.metrics));
    } else {
      task.reject(new Error(`Worker reply did not match job ${task.id}`));
    }
    if (!this.closed) {
      this.idle.push(worker);
      this.dispatch();
    }
  }

  private onCrash(worker: Worker, error: Error): void {
    const task = this.inflight.get(worker);
    this.inflight.delete(worker);
    task?.reject(error);
    this.closed = true;
    for (const queued of this.queue.splice(0)) queued.reject(error);
  }
}

function workerExecArgv(): string[] {
  const argv = process.execArgv;
  const keep: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--import" || arg === "--require" || arg === "-r" || arg === "--loader") {
      const next = argv[i + 1];
      if (next !== undefined) {
        keep.push(arg, next);
        i += 1;
      }
      continue;
    }
    if (
      arg.startsWith("--import=") ||
      arg.startsWith("--require=") ||
      arg.startsWith("--loader=")
    ) {
      keep.push(arg);
    }
  }
  return keep;
}

function candlePayload(candles: readonly Candle[]): CandlePayload[] {
  return candles.map((candle) => ({
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    timeframe: candle.timeframe,
    source: candle.source,
  }));
}

function toPortable(metrics: BacktestMetrics): PortableMetrics {
  const { strategy, ...rest } = metrics;
  return { ...rest, strategyId: strategy.getId(), strategyName: strategy.getDisplayName() };
}

function fromPortable(metrics: PortableMetrics): BacktestMetrics {
  const { strategyId, strategyName, ...rest } = metrics;
  const strategy: Strategy = {
    axes: [],
    getSearchDefaults: () => ({}),
    paramPatch: () => ({}),
    getDisplayName: () => strategyName,
    getId: () => strategyId,
    getRequiredCandles: () => ({ timeframe: "15m", count: 1 }),
    evaluateSignal: () => {
      throw new Error("Replay metrics do not evaluate signals");
    },
    buildChartSvg: () => "",
  };
  return { ...rest, strategy };
}

function startReplayWorker(): void {
  const port = parentPort;
  if (port === null) return;
  let session: PoolInit | undefined;
  port.on("message", (message: WorkerInbound) => {
    if (message.kind === "init") {
      session = {
        config: message.config,
        strategyId: message.strategyId,
        candles: message.candles.map((row) => createCandle(row)),
        altCandles: Object.fromEntries(
          Object.entries(message.altCandles).map(([label, rows]) => [
            label,
            rows.map((row) => createCandle(row)),
          ]),
        ),
        htfCandles: message.htfCandles.map((row) => createCandle(row)),
        mtfCandles: message.mtfCandles.map((row) => createCandle(row)),
        ...(message.minuteCandles !== undefined
          ? { minuteCandles: message.minuteCandles.map((row) => createCandle(row)) }
          : {}),
      };
      port.postMessage({ kind: "ready" } satisfies WorkerOutbound);
      return;
    }
    const current = session;
    if (current === undefined) {
      port.postMessage({
        kind: "error",
        id: message.id,
        message: "Worker is not initialized",
      } satisfies WorkerOutbound);
      return;
    }
    void replayMetrics({
      config: current.config,
      strategyId: current.strategyId,
      candles: replayCandles(current.candles, current.altCandles, {
        start: message.start,
        end: message.end,
        ...(message.patch !== undefined ? { patch: message.patch } : {}),
      }),
      htfCandles: current.htfCandles,
      mtfCandles: current.mtfCandles,
      ...(current.minuteCandles !== undefined ? { minuteCandles: current.minuteCandles } : {}),
      ...(message.patch !== undefined ? { patch: message.patch } : {}),
    }).then(
      (metrics) => {
        port.postMessage({
          kind: "result",
          id: message.id,
          metrics: toPortable(metrics),
        } satisfies WorkerOutbound);
      },
      (error: unknown) => {
        port.postMessage({
          kind: "error",
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
        } satisfies WorkerOutbound);
      },
    );
  });
}

if (!isMainThread) {
  startReplayWorker();
}
