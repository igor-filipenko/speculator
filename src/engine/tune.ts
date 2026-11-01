import type { AppConfig } from "../config.js";
import { createMarket } from "../market/manager.js";
import { loadHtfCandles, loadMtfCandles } from "../backtest/market-replay.js";
import { readFlagValue, resolveReplayWindow } from "../backtest/replay-window.js";
import { bollingerParamsFor, type BollingerParams } from "../strategy/mode/bollinger.js";
import { donchianParamsFor, type DonchianParams } from "../strategy/mode/donchian.js";
import { SimpleStrategyManager, type StrategyParamPatch } from "../strategy/strategy-manager.js";
import type { Candle, PairConfig } from "../types.js";
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
const NEIGHBOR_FILL_LEADERS = 3;
const PROFIT_FACTOR_CAP = 999;

export interface SearchAxis {
  key: string;
  levels: readonly number[];
}

export interface SearchSpace {
  strategyId: "bollinger" | "donchian";
  axes: readonly SearchAxis[];
  /** Drop a combination. Absent means every combination is valid. */
  accept?: (values: Readonly<Record<string, number>>) => boolean;
}

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
  /** True when the procedure's mean OOS Sharpe does not beat today's defaults. */
  keepDefaults: boolean;
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
  fromTime?: number;
  toTime?: number;
  days?: number;
  /** Defaults to the built-in space for `strategyId`. Tests pass a tiny space. */
  space?: SearchSpace;
  /** Signal candles. When set, skips the network and reuses this series for every pair. */
  candles?: Candle[];
  htfCandles?: Candle[];
  mtfCandles?: Candle[];
}

/** Bollinger decision knobs. `timeframe` and `adxPeriod` stay on the defaults. */
export const BOLLINGER_SEARCH_SPACE: SearchSpace = {
  strategyId: "bollinger",
  axes: [
    { key: "period", levels: [14, 20, 30] },
    { key: "stdDev", levels: [1.5, 2, 2.5] },
    { key: "diRatio", levels: [1, 1.2, 1.5] },
    { key: "minReclaimDepth", levels: [0.05, 0.1, 0.2] },
    { key: "maxBreakAtr", levels: [2, 2.5, 4] },
    { key: "minRewardRisk", levels: [0.2, 0.3, 0.5] },
    { key: "stopAtr", levels: [1.5, 2.5, 3.5] },
  ],
};

/**
 * Donchian knobs that are not the trend × volatility tables.
 * `volumeSmaMult` and `minBreakAtrMult` stay on `donchianParamsFor`.
 */
export const DONCHIAN_SEARCH_SPACE: SearchSpace = {
  strategyId: "donchian",
  axes: [
    { key: "entryPeriod", levels: [20, 40, 55] },
    { key: "exitPeriod", levels: [10, 20, 30] },
    { key: "atrStopMult", levels: [2, 3, 4] },
    { key: "givebackAtrMult", levels: [3, 4, 5] },
    { key: "timeStopBars", levels: [0, 3, 6] },
  ],
  accept: (values) => {
    const exitPeriod = values["exitPeriod"];
    const entryPeriod = values["entryPeriod"];
    return exitPeriod !== undefined && entryPeriod !== undefined && exitPeriod < entryPeriod;
  },
};

export function searchSpaceFor(strategyId: string): SearchSpace {
  if (strategyId === "bollinger") return BOLLINGER_SEARCH_SPACE;
  if (strategyId === "donchian") return DONCHIAN_SEARCH_SPACE;
  throw new Error(
    `No parameter search space for strategy "${strategyId}". Known: bollinger, donchian`,
  );
}

export function defaultLevels(space: SearchSpace): Record<string, number> {
  const source = numericFields(
    space.strategyId === "bollinger" ? bollingerParamsFor() : donchianParamsFor(),
  );
  const defaults: Record<string, number> = {};
  for (const axis of space.axes) {
    const value = source[axis.key];
    if (value === undefined) {
      throw new Error(`Strategy ${space.strategyId} has no numeric default for ${axis.key}`);
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
  };
  if (fromTime !== undefined) result.fromTime = fromTime;
  if (toTime !== undefined) result.toTime = toTime;
  if (days !== undefined) result.days = days;
  if (strategy !== undefined) result.strategy = strategy;
  return result;
}

/**
 * Pick parameters on each anchored train window and score that single set on
 * the next fold. Candles load once per pair. The synthetic OHLC path is the
 * same one a default backtest uses.
 */
export async function runTune(options: RunTuneOptions): Promise<TuneResult[]> {
  const space = options.space ?? searchSpaceFor(options.strategyId);
  if (space.strategyId !== options.strategyId) {
    throw new Error(
      `Search space ${space.strategyId} does not match strategy ${options.strategyId}`,
    );
  }
  const defaults = defaultLevels(space);
  const window = replayWindow(options);
  const probe = await SimpleStrategyManager.create({
    strategyId: options.strategyId,
    htf: options.config.htf,
  });
  const timeframe = probe.getActiveStrategy().getRequiredCandles().timeframe;
  const market = createMarket(options.config.candleSource, options.config.birdeyeApiKey);
  const skipNetwork = options.candles !== undefined;

  const results: TuneResult[] = [];
  for (const pair of options.config.pairs) {
    const candles =
      options.candles ??
      (await market.fetchCandles({
        pair,
        timeframe,
        fromTime: window.fromTime,
        toTime: window.toTime,
      }));
    if (candles.length === 0) {
      throw new Error(
        `No candles for ${pair.symbol} (${timeframe}) in ` +
          `${new Date(window.fromTime * 1000).toISOString()} → ${new Date(window.toTime * 1000).toISOString()}`,
      );
    }
    const pairConfig = { ...options.config, pairs: [pair] };
    const htfCandles = await loadHtfCandles({
      pair,
      market,
      strategyManager: probe,
      fromTime: candles[0]!.time,
      toTime: candles[candles.length - 1]!.time + 1,
      injected: options.htfCandles,
      skipFetch: skipNetwork && options.htfCandles === undefined,
    });
    const mtfCandles = await loadMtfCandles({
      pair,
      market,
      strategyManager: probe,
      fromTime: candles[0]!.time,
      toTime: candles[candles.length - 1]!.time + 1,
      injected: options.mtfCandles,
      skipFetch: skipNetwork && options.mtfCandles === undefined,
    });

    const windows = walkForwardWindows(candles, options.folds);
    const foldResults: TuneFoldResult[] = [];
    for (const fold of windows) {
      const trained = await scoreTrain({
        config: pairConfig,
        strategyId: options.strategyId,
        space,
        defaults,
        train: fold.train,
        htfCandles,
        mtfCandles,
        maxTrials: options.maxTrials,
        seed: options.seed,
        minTrades: options.minTrades,
        maxDrawdownPct: options.maxDrawdownPct,
        pair,
        fold: fold.fold,
      });
      const baselineMetrics = await replayMetrics({
        config: pairConfig,
        strategyId: options.strategyId,
        candles: fold.test,
        htfCandles,
        mtfCandles,
      });
      const oosMetrics =
        trained.winner === undefined
          ? baselineMetrics
          : await replayMetrics({
              config: pairConfig,
              strategyId: options.strategyId,
              patch: patchFromValues(options.strategyId, trained.winner.variant.values),
              candles: fold.test,
              htfCandles,
              mtfCandles,
            });
      const trainRange = candleRange(fold.train);
      const testRange = candleRange(fold.test);
      const foldResult: TuneFoldResult = {
        fold: fold.fold,
        trainFrom: trainRange.from,
        trainTo: trainRange.to,
        testFrom: testRange.from,
        testTo: testRange.to,
        trials: trained.trials,
        exhaustive: trained.exhaustive,
        oosMetrics,
        baselineMetrics,
      };
      if (trained.winner !== undefined && trained.winnerMetrics !== undefined) {
        foldResult.selected = trained.winner.variant.values;
        foldResult.trainMetrics = trained.winnerMetrics;
      }
      foldResults.push(foldResult);
    }

    const oosReturnPct = compoundReturn(foldResults.map((fold) => fold.oosMetrics.totalReturnPct));
    const baselineReturnPct = compoundReturn(
      foldResults.map((fold) => fold.baselineMetrics.totalReturnPct),
    );
    const oosSharpe = mean(foldResults.map((fold) => fold.oosMetrics.sharpeRatio));
    const baselineSharpe = mean(foldResults.map((fold) => fold.baselineMetrics.sharpeRatio));
    const last = foldResults[foldResults.length - 1];
    const result: TuneResult = {
      pair: pair.symbol,
      strategyId: options.strategyId,
      folds: foldResults,
      oosReturnPct,
      oosSharpe,
      baselineReturnPct,
      baselineSharpe,
      keepDefaults: !(oosSharpe > baselineSharpe),
    };
    if (last?.selected !== undefined) {
      result.nextParams = last.selected;
    }
    results.push(result);
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
  console.log(result.keepDefaults ? "Keep defaults." : "Use the next params.");
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

async function scoreTrain(args: {
  config: AppConfig;
  strategyId: string;
  space: SearchSpace;
  defaults: Readonly<Record<string, number>>;
  train: Candle[];
  htfCandles: Candle[];
  mtfCandles: Candle[];
  maxTrials: number;
  seed: number;
  minTrades: number;
  maxDrawdownPct: number;
  pair: PairConfig;
  fold: number;
}): Promise<{
  winner: ScoredVariant | undefined;
  winnerMetrics: BacktestMetrics | undefined;
  trials: number;
  exhaustive: boolean;
}> {
  const sample = sampleSearchSpace(args.space, args.maxTrials, args.seed, args.defaults);
  console.log(
    `[${args.pair.symbol}] fold ${args.fold}: scoring ${sample.variants.length} train trials` +
      (sample.exhaustive ? " (full grid)" : " (latin hypercube)"),
  );
  const scored: ScoredVariant[] = [];
  const metricsByKey = new Map<string, BacktestMetrics>();
  for (const variant of sample.variants) {
    const metrics = await replayMetrics({
      config: args.config,
      strategyId: args.strategyId,
      patch: patchFromValues(args.strategyId, variant.values),
      candles: args.train,
      htfCandles: args.htfCandles,
      mtfCandles: args.mtfCandles,
    });
    metricsByKey.set(variantKey(variant), metrics);
    scored.push(toScored(variant, metrics, args.minTrades, args.maxDrawdownPct, args.defaults));
  }

  if (!sample.exhaustive) {
    const extra = missingNeighborVariants(
      args.space,
      topFeasible(scored, NEIGHBOR_FILL_LEADERS),
      scored,
    );
    if (extra.length > 0) {
      console.log(
        `[${args.pair.symbol}] fold ${args.fold}: scoring ${extra.length} neighbor trials`,
      );
    }
    for (const variant of extra) {
      const metrics = await replayMetrics({
        config: args.config,
        strategyId: args.strategyId,
        patch: patchFromValues(args.strategyId, variant.values),
        candles: args.train,
        htfCandles: args.htfCandles,
        mtfCandles: args.mtfCandles,
      });
      metricsByKey.set(variantKey(variant), metrics);
      scored.push(toScored(variant, metrics, args.minTrades, args.maxDrawdownPct, args.defaults));
    }
  }

  const winner = pickNeighborhoodWinner(scored, args.space);
  if (winner === undefined) {
    return {
      winner,
      winnerMetrics: undefined,
      trials: scored.length,
      exhaustive: sample.exhaustive,
    };
  }
  const winnerMetrics = metricsByKey.get(variantKey(winner.variant));
  if (winnerMetrics === undefined) {
    throw new Error("Train winner is missing its replay metrics");
  }
  return { winner, winnerMetrics, trials: scored.length, exhaustive: sample.exhaustive };
}

async function replayMetrics(args: {
  config: AppConfig;
  strategyId: string;
  candles: Candle[];
  htfCandles: Candle[];
  mtfCandles: Candle[];
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
  });
  if (result === undefined) {
    throw new Error("Backtest returned no results");
  }
  return result.metrics;
}

function patchFromValues(
  strategyId: string,
  values: Readonly<Record<string, number>>,
): StrategyParamPatch {
  if (strategyId === "bollinger") {
    return { bollinger: bollingerPatch(values) };
  }
  if (strategyId === "donchian") {
    return { donchian: donchianPatch(values) };
  }
  throw new Error(`No parameter search space for strategy "${strategyId}"`);
}

function bollingerPatch(values: Readonly<Record<string, number>>): Partial<BollingerParams> {
  const patch: Partial<BollingerParams> = {};
  const period = values["period"];
  const stdDev = values["stdDev"];
  const atrPeriod = values["atrPeriod"];
  const adxPeriod = values["adxPeriod"];
  const diRatio = values["diRatio"];
  const minReclaimDepth = values["minReclaimDepth"];
  const maxBreakAtr = values["maxBreakAtr"];
  const minRewardRisk = values["minRewardRisk"];
  const stopAtr = values["stopAtr"];
  if (period !== undefined) patch.period = period;
  if (stdDev !== undefined) patch.stdDev = stdDev;
  if (atrPeriod !== undefined) patch.atrPeriod = atrPeriod;
  if (adxPeriod !== undefined) patch.adxPeriod = adxPeriod;
  if (diRatio !== undefined) patch.diRatio = diRatio;
  if (minReclaimDepth !== undefined) patch.minReclaimDepth = minReclaimDepth;
  if (maxBreakAtr !== undefined) patch.maxBreakAtr = maxBreakAtr;
  if (minRewardRisk !== undefined) patch.minRewardRisk = minRewardRisk;
  if (stopAtr !== undefined) patch.stopAtr = stopAtr;
  return patch;
}

function donchianPatch(values: Readonly<Record<string, number>>): Partial<DonchianParams> {
  const patch: Partial<DonchianParams> = {};
  const entryPeriod = values["entryPeriod"];
  const exitPeriod = values["exitPeriod"];
  const volumeSmaPeriod = values["volumeSmaPeriod"];
  const volumeSmaMult = values["volumeSmaMult"];
  const trendEmaPeriod = values["trendEmaPeriod"];
  const atrPeriod = values["atrPeriod"];
  const minBreakAtrMult = values["minBreakAtrMult"];
  const shortMaxExtendAtrMult = values["shortMaxExtendAtrMult"];
  const shortVolumeSmaScale = values["shortVolumeSmaScale"];
  const shortMinBreakScale = values["shortMinBreakScale"];
  const givebackAtrMult = values["givebackAtrMult"];
  const givebackArmAtrMult = values["givebackArmAtrMult"];
  const maxEntryAgeBars = values["maxEntryAgeBars"];
  const timeStopBars = values["timeStopBars"];
  const atrStopMult = values["atrStopMult"];
  if (entryPeriod !== undefined) patch.entryPeriod = entryPeriod;
  if (exitPeriod !== undefined) patch.exitPeriod = exitPeriod;
  if (volumeSmaPeriod !== undefined) patch.volumeSmaPeriod = volumeSmaPeriod;
  if (volumeSmaMult !== undefined) patch.volumeSmaMult = volumeSmaMult;
  if (trendEmaPeriod !== undefined) patch.trendEmaPeriod = trendEmaPeriod;
  if (atrPeriod !== undefined) patch.atrPeriod = atrPeriod;
  if (minBreakAtrMult !== undefined) patch.minBreakAtrMult = minBreakAtrMult;
  if (shortMaxExtendAtrMult !== undefined) patch.shortMaxExtendAtrMult = shortMaxExtendAtrMult;
  if (shortVolumeSmaScale !== undefined) patch.shortVolumeSmaScale = shortVolumeSmaScale;
  if (shortMinBreakScale !== undefined) patch.shortMinBreakScale = shortMinBreakScale;
  if (givebackAtrMult !== undefined) patch.givebackAtrMult = givebackAtrMult;
  if (givebackArmAtrMult !== undefined) patch.givebackArmAtrMult = givebackArmAtrMult;
  if (maxEntryAgeBars !== undefined) patch.maxEntryAgeBars = maxEntryAgeBars;
  if (timeStopBars !== undefined) patch.timeStopBars = timeStopBars;
  if (atrStopMult !== undefined) patch.atrStopMult = atrStopMult;
  return patch;
}

function toScored(
  variant: SampledVariant,
  metrics: BacktestMetrics,
  minTrades: number,
  maxDrawdownPct: number,
  defaults: Readonly<Record<string, number>>,
): ScoredVariant {
  return {
    variant,
    sharpeRatio: metrics.sharpeRatio,
    vsHoldReturnPct: metrics.vsHoldReturnPct,
    profitFactor: metrics.profitFactor,
    roundTrips: metrics.roundTrips,
    maxDrawdownPct: metrics.maxDrawdownPct,
    feasible: metrics.roundTrips >= minTrades && metrics.maxDrawdownPct <= maxDrawdownPct,
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

function numericFields(params: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
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
    .map(([key, value]) => `${key}=${String(value)}`)
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
