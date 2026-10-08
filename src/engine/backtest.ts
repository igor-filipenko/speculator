import { assert } from "console";
import { renderConsoleChart } from "../chart/render-console.js";
import type { AppConfig } from "../config.js";
import { EmulatedExchange } from "../exchange/emulated/emulated-exchange.js";
import { emulateFillPrice, liquidityTierForPair } from "../exchange/emulated/emulated-quote.js";
import { candleIntervalSeconds } from "../market/gecko-terminal.js";
import { loadCachedCandles } from "../market/ohlcv-cache.js";
import { PaperPortfolio } from "../portfolio/paper/portfolio.js";
import {
  isOrder,
  type Candle,
  type MarketIndicators,
  type Order,
  type PairConfig,
  type Strategy,
  type StrategyManager,
  type Trade,
} from "../types.js";
import { intraBarTicks } from "../backtest/intra-bar.js";
import { loadHtfCandles, loadMtfCandles, syncMarketIndicators } from "../backtest/market-replay.js";
import { parseReplayDate, readFlagValue, resolveReplayWindow } from "../backtest/replay-window.js";

export { parseReplayDate as parseBacktestDate, resolveReplayWindow as resolveBacktestWindow };

export interface BacktestCliOptions {
  /** Inclusive range start (Unix seconds). When unset, default 90-day lookback. */
  fromTime?: number;
  /** Exclusive range end (Unix seconds). Defaults to now when only `--from` is set. */
  toTime?: number;
  forceRefresh: boolean;
  /** Print simulated trades and chart; when false, metrics only. */
  verbose: boolean;
  /** CLI override for strategy (takes precedence over env STRATEGY). */
  strategy?: string;
  /**
   * Number of Monte Carlo runs with randomized intra-bar paths.
   * When set, `BacktestResult.monteCarlo` is printed after the main report.
   */
  monteCarloRuns?: number;
}

export interface BacktestCostTotals {
  /** Sum of (fillSize * mid * slippage) across fills. */
  slippageUsdc: number;
  /** Sum of (fillSize * mid * poolFee) across fills. */
  poolFeeUsdc: number;
  /** Sum of priority fees in USDC. */
  priorityFeeUsdc: number;
  /** Jupiter perps open + close + borrow on short round-trips. */
  perpsFeeUsdc: number;
}

export interface BacktestMetrics {
  pair: string;
  strategy: Strategy;
  startingCashUsdc: number;
  endingEquity: number;
  totalReturnPct: number;
  /** Buy at first bar close, sell at last — same emulated round-trip costs as strategy fills. */
  holdEquity: number;
  holdReturnPct: number;
  /** endingEquity − holdEquity */
  vsHoldUsdc: number;
  /** totalReturnPct − holdReturnPct (percentage points) */
  vsHoldReturnPct: number;
  realizedPnl: number;
  tradeCount: number;
  roundTrips: number;
  /** Completed BUY→SELL round-trips. */
  longs: number;
  /** Completed SELL→BUY round-trips. */
  shorts: number;
  wins: number;
  winRate: number;
  /** Shortest completed round-trip (close − open), milliseconds. 0 when none closed. */
  roundTripMinMs: number;
  /** Longest completed round-trip (close − open), milliseconds. 0 when none closed. */
  roundTripMaxMs: number;
  /** Mean completed round-trip (close − open), milliseconds. 0 when none closed. */
  roundTripAvgMs: number;
  maxDrawdownPct: number;
  /**
   * Longest continuous period below the equity peak, in milliseconds.
   * 0 when there was no drawdown.
   */
  maxDrawdownDurationMs: number;
  costs: BacktestCostTotals;
  candleCount: number;
  fromTime: number;
  toTime: number;
  /**
   * Annualized Sharpe ratio (risk-free rate = 0), computed from per-bar equity returns.
   * 0 when fewer than 2 bars or zero standard deviation.
   */
  sharpeRatio: number;
  /**
   * Annualized Sortino ratio (target return = 0, downside deviation only).
   * 0 when no negative return bars.
   */
  sortinoRatio: number;
  /**
   * Sum of winning round-trip P&L divided by absolute sum of losing P&L.
   * 0 when no completed round-trips exist. Infinity when all round-trips are wins.
   */
  profitFactor: number;
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  trades: Trade[];
  equityCurve: number[];
  /** OHLCV series used for the replay (for console chart). */
  candles: Candle[];
  /**
   * Distribution of key metrics across Monte Carlo intra-bar path samples.
   * Present only when `RunBacktestOptions.monteCarloRuns > 0`.
   */
  monteCarlo?: MonteCarloStats;
}

/** p5 / p50 / p95 / mean distribution of a single scalar metric across MC runs. */
export interface MonteCarloDistribution {
  p5: number;
  p50: number;
  p95: number;
  mean: number;
}

/**
 * Aggregate of per-run metrics from Monte Carlo intra-bar path sampling.
 * Each run replays the same candle series with a different random OHLC ordering,
 * providing a distribution of outcomes that accounts for intra-bar path uncertainty.
 */
export interface MonteCarloStats {
  runs: number;
  totalReturnPct: MonteCarloDistribution;
  sharpeRatio: MonteCarloDistribution;
  maxDrawdownPct: MonteCarloDistribution;
  profitFactor: MonteCarloDistribution;
}

export interface RunBacktestOptions {
  config: AppConfig;
  strategyManager: StrategyManager;
  /** Inclusive range start (Unix seconds). When unset, default 90-day lookback. */
  fromTime?: number;
  /** Exclusive range end (Unix seconds). Defaults to now. */
  toTime?: number;
  forceRefresh?: boolean;
  /** Inject signal-timeframe candles (skips network/cache; tests). */
  candles?: Candle[];
  /** Inject HTF candles for {@link StrategyManager}; skips HTF fetch when set. */
  htfCandles?: Candle[];
  /** Inject 1h candles for volatility; skips 1h fetch when set. */
  mtfCandles?: Candle[];
  /**
   * Number of additional Monte Carlo runs with randomized intra-bar paths.
   * When > 0, `BacktestResult.monteCarlo` is populated with p5/p50/p95 distributions.
   * Each run uses a deterministic seed so results are reproducible.
   */
  monteCarloRuns?: number;
}

/**
 * Replay OHLCV through the active strategy/risk from {@link StrategyManager}.
 * Each signal-timeframe bar is walked as a forming candle so `evaluateSignal`
 * sees the same incomplete last bar as live. The path is fixed from the position at the
 * bar open: long visits the high last, short visits the low last, flat follows candle color.
 * HTF and 1h candles are loaded once per pair; market state is evaluated as those bars close.
 */
export async function runBacktest(options: RunBacktestOptions): Promise<BacktestResult[]> {
  const { strategyManager } = options;
  const strategy = strategyManager.getActiveStrategy();
  const { fromTime, toTime } = resolveReplayWindow(options);
  const timeframe = strategy.getRequiredCandles().timeframe;
  const cacheOpts = {
    forceRefresh: options.forceRefresh ?? false,
  };

  const results: BacktestResult[] = [];
  for (const pair of options.config.pairs) {
    const candles =
      options.candles ??
      (await loadCachedCandles({
        symbol: pair.symbol,
        poolAddress: pair.geckoPoolAddress,
        timeframe,
        fromTime,
        toTime,
        ...cacheOpts,
      }));

    if (candles.length === 0) {
      throw new Error(
        `No candles for ${pair.symbol} (${timeframe}) in ` +
          `${new Date(fromTime * 1000).toISOString()} → ${new Date(toTime * 1000).toISOString()}`,
      );
    }

    const skipNetwork = options.candles !== undefined;
    const htfCandles = await loadHtfCandles({
      pair,
      strategyManager,
      fromTime,
      toTime,
      injected: options.htfCandles,
      skipFetch: skipNetwork && options.htfCandles === undefined,
      cacheOpts,
    });
    const mtfCandles = await loadMtfCandles({
      pair,
      strategyManager,
      fromTime,
      toTime,
      injected: options.mtfCandles,
      skipFetch: skipNetwork && options.mtfCandles === undefined,
      cacheOpts,
    });

    const pairArgs = {
      pair,
      strategyManager,
      candles,
      htfCandles,
      mtfCandles,
      startingCashUsdc: options.config.paperCashUsdc,
      fromTime: candles[0]!.time,
      toTime: candles[candles.length - 1]!.time + 1,
    };
    const result = await replayPair(pairArgs);

    if (options.monteCarloRuns != null && options.monteCarloRuns > 0) {
      const monteCarlo = await runMonteCarloForPair({
        ...pairArgs,
        runs: options.monteCarloRuns,
      });
      results.push({ ...result, monteCarlo });
    } else {
      results.push(result);
    }
  }

  return results;
}

async function replayPair(args: {
  pair: PairConfig;
  strategyManager: StrategyManager;
  candles: Candle[];
  htfCandles: Candle[];
  mtfCandles: Candle[];
  startingCashUsdc: number;
  fromTime: number;
  toTime: number;
  /** When set, intra-bar prices use random OHLC orderings (Monte Carlo mode). */
  rng?: () => number;
}): Promise<BacktestResult> {
  const { pair, strategyManager, candles, htfCandles, mtfCandles, startingCashUsdc } = args;
  const portfolio = new PaperPortfolio(pair.symbol, startingCashUsdc);
  const exchange = new EmulatedExchange();
  const costs: BacktestCostTotals = {
    slippageUsdc: 0,
    poolFeeUsdc: 0,
    priorityFeeUsdc: 0,
    perpsFeeUsdc: 0,
  };
  const barIntervalSec = candleIntervalSeconds(
    strategyManager.getActiveStrategy().getRequiredCandles().timeframe,
  );

  const perpsFees = await exchange.perpsFeeSchedule(pair);
  const equityCurve: number[] = [];
  let peakEquity = startingCashUsdc;
  let maxDrawdownPct = 0;
  let htfEnd = 0;
  let mtfEnd = 0;
  let lastMarket: MarketIndicators | undefined;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const closed = candles.slice(0, i);
    const positionSide = portfolio.getSnapshot(candle.open).position.side;
    const ticks = intraBarTicks(candle, barIntervalSec, positionSide, args.rng);

    // Volume-weighted slippage: set bar USDC volume once per candle.
    // GeckoTerminal volume field is in base token units; multiply by close for USDC equivalent.
    exchange.setCandleVolumeUsdc(candle.volume * candle.close);

    for (const tick of ticks) {
      const window = closed.concat(tick.forming);
      const price = tick.price;
      exchange.setMidPrice(price);

      const synced = await syncMarketIndicators({
        pair: pair.symbol,
        strategyManager,
        htfCandles,
        mtfCandles,
        atTime: tick.atSec,
        price,
        htfEnd,
        mtfEnd,
        lastMarket,
      });
      htfEnd = synced.htfEnd;
      mtfEnd = synced.mtfEnd;
      lastMarket = synced.lastMarket;

      const strategy = strategyManager.getActiveStrategy();
      const riskManager = strategyManager.getActiveRiskManager();

      const market = lastMarket ?? {
        pair: pair.symbol,
        price,
        trend: "unknown" as const,
        volatility: "unknown" as const,
      };
      const signal = strategy.evaluateSignal(
        pair.symbol,
        window,
        market,
        price,
        new Date(tick.atSec * 1000),
        portfolio.getSnapshot(price),
        perpsFees,
      );

      const result = riskManager.check(signal, portfolio.getSnapshot(price), window);
      if (result.kind === "command" || result.kind === "protective-command") {
        const command = result.command;
        // Protective exits fill at the stop/trail level; cross signals use the tick price.
        exchange.setMidPrice(command.priceHint > 0 ? command.priceHint : price);
        const order = await exchange.execute(command, pair);
        assert(isOrder(order), "Expected order, got error");
        if (!isOrder(order)) {
          continue;
        }
        const trade = portfolio.applyOrderSync(order);
        if (trade) {
          accumulateCosts(costs, trade, order);
        }
      }
    }

    const equity = portfolio.getSnapshot(candle.close).equity;
    equityCurve.push(equity);
    if (equity > peakEquity) {
      peakEquity = equity;
    }
    if (peakEquity > 0) {
      const dd = ((peakEquity - equity) / peakEquity) * 100;
      if (dd > maxDrawdownPct) {
        maxDrawdownPct = dd;
      }
    }
  }

  const firstClose = candles[0]!.close;
  const lastClose = candles[candles.length - 1]!.close;
  const snap = portfolio.getSnapshot(lastClose);
  const { longs, shorts } = countRoundTripsBySide(snap.trades);
  const roundTrips = longs + shorts;
  const wins = snap.trades.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const holdMs = roundTripHoldMs(snap.trades);
  const holdStats = summarizeHoldMs(holdMs);
  const totalReturnPct =
    startingCashUsdc > 0 ? ((snap.equity - startingCashUsdc) / startingCashUsdc) * 100 : 0;
  const holdEquity = computeBuyHoldEquity(startingCashUsdc, firstClose, lastClose, pair.symbol);
  const holdReturnPct =
    startingCashUsdc > 0 ? ((holdEquity - startingCashUsdc) / startingCashUsdc) * 100 : 0;

  const riskMetrics = computeRiskMetrics(equityCurve, snap.trades, barIntervalSec);

  return {
    metrics: {
      pair: pair.symbol,
      strategy: strategyManager.getActiveStrategy(),
      startingCashUsdc,
      endingEquity: snap.equity,
      totalReturnPct,
      holdEquity,
      holdReturnPct,
      vsHoldUsdc: snap.equity - holdEquity,
      vsHoldReturnPct: totalReturnPct - holdReturnPct,
      realizedPnl: snap.realizedPnl,
      tradeCount: snap.trades.length,
      roundTrips,
      longs,
      shorts,
      wins,
      winRate: roundTrips > 0 ? wins / roundTrips : 0,
      roundTripMinMs: holdStats.minMs,
      roundTripMaxMs: holdStats.maxMs,
      roundTripAvgMs: holdStats.avgMs,
      maxDrawdownPct,
      maxDrawdownDurationMs: riskMetrics.maxDrawdownDurationMs,
      costs,
      candleCount: candles.length,
      fromTime: args.fromTime,
      toTime: args.toTime,
      sharpeRatio: riskMetrics.sharpeRatio,
      sortinoRatio: riskMetrics.sortinoRatio,
      profitFactor: riskMetrics.profitFactor,
    },
    trades: snap.trades,
    equityCurve,
    candles,
  };
}

/**
 * Benchmark: deploy full starting cash at the first bar close, exit at the last.
 * Uses the same emulated slippage/pool/priority costs as strategy fills.
 */
export function computeBuyHoldEquity(
  startingCashUsdc: number,
  firstClose: number,
  lastClose: number,
  symbol: string,
): number {
  if (!(startingCashUsdc > 0) || !(firstClose > 0) || !(lastClose > 0)) {
    return startingCashUsdc;
  }

  const tier = liquidityTierForPair(symbol);
  const buy = emulateFillPrice({ side: "BUY", close: firstClose, tier });
  const spendable = startingCashUsdc - buy.priorityFeeUsdc;
  if (spendable <= 0) {
    return startingCashUsdc;
  }

  const size = spendable / buy.fillPrice;
  const sell = emulateFillPrice({ side: "SELL", close: lastClose, tier });
  return size * sell.fillPrice - sell.priorityFeeUsdc;
}

/**
 * Hold time of each completed round-trip, in milliseconds.
 * A close is a fill with `realizedPnl`; it pairs with the previous open.
 */
export function roundTripHoldMs(trades: readonly Trade[]): number[] {
  const holds: number[] = [];
  let openedAt: Date | undefined;
  for (const trade of trades) {
    if (trade.realizedPnl === undefined) {
      openedAt = trade.at;
      continue;
    }
    if (openedAt !== undefined) {
      holds.push(trade.at.getTime() - openedAt.getTime());
      openedAt = undefined;
    }
  }
  return holds;
}

/**
 * Count completed round-trips by direction: long = BUY→SELL, short = SELL→BUY.
 * A close is a fill with `realizedPnl`; it pairs with the previous open.
 */
export function countRoundTripsBySide(trades: readonly Trade[]): {
  longs: number;
  shorts: number;
} {
  let longs = 0;
  let shorts = 0;
  let openSide: Trade["side"] | undefined;
  for (const trade of trades) {
    if (trade.realizedPnl === undefined) {
      openSide = trade.side;
      continue;
    }
    if (openSide === "BUY") {
      longs += 1;
    } else if (openSide === "SELL") {
      shorts += 1;
    }
    openSide = undefined;
  }
  return { longs, shorts };
}

function summarizeHoldMs(holds: readonly number[]): {
  minMs: number;
  maxMs: number;
  avgMs: number;
} {
  const first = holds[0];
  if (first === undefined) {
    return { minMs: 0, maxMs: 0, avgMs: 0 };
  }
  let minMs = first;
  let maxMs = first;
  let sum = 0;
  for (const ms of holds) {
    if (ms < minMs) {
      minMs = ms;
    }
    if (ms > maxMs) {
      maxMs = ms;
    }
    sum += ms;
  }
  return { minMs, maxMs, avgMs: sum / holds.length };
}

function accumulateCosts(totals: BacktestCostTotals, trade: Trade, order: Order): void {
  const fillCosts = order.fillCosts;
  if (!fillCosts) {
    totals.priorityFeeUsdc += order.priorityFeeUsdc;
    return;
  }
  totals.slippageUsdc += trade.size * fillCosts.slippageUsdcPerBase;
  totals.poolFeeUsdc += trade.size * fillCosts.poolFeeUsdcPerBase;
  totals.priorityFeeUsdc += order.priorityFeeUsdc;
  totals.perpsFeeUsdc += trade.perpsFeeUsdc ?? 0;
}

// ---------------------------------------------------------------------------
// Monte Carlo replay
// ---------------------------------------------------------------------------

/**
 * Mulberry32 — a fast, seedable 32-bit PRNG.
 * Returns a closure that produces values in [0, 1) from the given seed.
 * Using a deterministic seed per run makes Monte Carlo results reproducible.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function (): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run `args.runs` additional replays of the same pair with randomised intra-bar
 * paths (one seeded PRNG per run) and aggregate metrics into a distribution.
 */
async function runMonteCarloForPair(args: {
  pair: PairConfig;
  strategyManager: StrategyManager;
  candles: Candle[];
  htfCandles: Candle[];
  mtfCandles: Candle[];
  startingCashUsdc: number;
  fromTime: number;
  toTime: number;
  runs: number;
}): Promise<MonteCarloStats> {
  const { runs, ...replayArgs } = args;
  const allMetrics: BacktestMetrics[] = [];
  for (let run = 0; run < runs; run++) {
    const rng = mulberry32(run); // seed 0..runs−1 → reproducible across calls
    const result = await replayPair({ ...replayArgs, rng });
    allMetrics.push(result.metrics);
  }
  return buildMonteCarloStats(allMetrics);
}

function buildMonteCarloStats(allMetrics: BacktestMetrics[]): MonteCarloStats {
  const dist = (values: number[]): MonteCarloDistribution => {
    const sorted = [...values].sort((a, b) => a - b);
    const mean = sorted.reduce((s, v) => s + v, 0) / Math.max(sorted.length, 1);
    return {
      p5: mcPercentile(sorted, 0.05),
      p50: mcPercentile(sorted, 0.5),
      p95: mcPercentile(sorted, 0.95),
      mean,
    };
  };
  return {
    runs: allMetrics.length,
    totalReturnPct: dist(allMetrics.map((m) => m.totalReturnPct)),
    sharpeRatio: dist(allMetrics.map((m) => m.sharpeRatio)),
    maxDrawdownPct: dist(allMetrics.map((m) => m.maxDrawdownPct)),
    // Cap Infinity (all-winning runs) at 999 so the distribution is always finite.
    profitFactor: dist(
      allMetrics.map((m) => (Number.isFinite(m.profitFactor) ? m.profitFactor : 999)),
    ),
  };
}

/** Linear-interpolated percentile on a pre-sorted array. `p` is in [0, 1].
 *
 * Uses the numerically stable form `loVal + frac * (hiVal − loVal)` so that
 * when all values are identical, every percentile equals that value exactly.
 */
function mcPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo]!;
  if (lo === hi) return loVal;
  const frac = idx - lo;
  return loVal + frac * (sorted[hi]! - loVal);
}

// ---------------------------------------------------------------------------
// Risk-adjusted performance metrics
// ---------------------------------------------------------------------------

const SECONDS_PER_YEAR = 365 * 24 * 3600;

interface RiskMetrics {
  sharpeRatio: number;
  sortinoRatio: number;
  profitFactor: number;
  maxDrawdownDurationMs: number;
}

/**
 * Compute Sharpe ratio, Sortino ratio, profit factor, and max drawdown duration
 * from a bar-level equity curve and completed round-trip trades.
 *
 * Sharpe / Sortino are annualized assuming `barIntervalSec`-spaced equity samples.
 * Risk-free rate is 0.
 */
export function computeRiskMetrics(
  equityCurve: readonly number[],
  trades: readonly Trade[],
  barIntervalSec: number,
): RiskMetrics {
  return {
    sharpeRatio: computeSharpeRatio(equityCurve, barIntervalSec),
    sortinoRatio: computeSortinoRatio(equityCurve, barIntervalSec),
    profitFactor: computeProfitFactor(trades),
    maxDrawdownDurationMs: computeMaxDrawdownDurationMs(equityCurve, barIntervalSec),
  };
}

/**
 * Annualized Sharpe ratio from per-bar equity returns (risk-free rate = 0).
 * Returns 0 when there are fewer than 2 bars or standard deviation is zero.
 */
function computeSharpeRatio(equityCurve: readonly number[], barIntervalSec: number): number {
  const returns = barReturns(equityCurve);
  if (returns.length === 0) return 0;
  const { mean, stdDev } = meanAndStd(returns);
  if (!(stdDev > 0)) return 0;
  const barsPerYear = SECONDS_PER_YEAR / barIntervalSec;
  return (mean / stdDev) * Math.sqrt(barsPerYear);
}

/**
 * Annualized Sortino ratio from per-bar equity returns (target = 0).
 * Downside deviation uses the same denominator as Sharpe (total N of bars),
 * matching the standard Sortino formula.
 * Returns 0 when there are no negative-return bars.
 */
function computeSortinoRatio(equityCurve: readonly number[], barIntervalSec: number): number {
  const returns = barReturns(equityCurve);
  if (returns.length === 0) return 0;
  const { mean } = meanAndStd(returns);
  // Downside variance: sum(min(r, 0)^2) / N
  const sumDownSq = returns.reduce((s, r) => s + (r < 0 ? r * r : 0), 0);
  const downsideDev = Math.sqrt(sumDownSq / returns.length);
  if (!(downsideDev > 0)) return 0;
  const barsPerYear = SECONDS_PER_YEAR / barIntervalSec;
  return (mean / downsideDev) * Math.sqrt(barsPerYear);
}

/**
 * Profit factor: sum of winning round-trip P&L / |sum of losing round-trip P&L|.
 * Returns 0 when no completed round-trips exist.
 * Returns Infinity when every completed round-trip is a winner.
 */
function computeProfitFactor(trades: readonly Trade[]): number {
  let sumWins = 0;
  let sumLosses = 0;
  for (const t of trades) {
    if (t.realizedPnl == null) continue;
    if (t.realizedPnl > 0) {
      sumWins += t.realizedPnl;
    } else if (t.realizedPnl < 0) {
      sumLosses += Math.abs(t.realizedPnl);
    }
  }
  if (sumWins === 0 && sumLosses === 0) return 0;
  if (sumLosses === 0) return Infinity;
  return sumWins / sumLosses;
}

/**
 * Longest continuous period below the equity peak, in milliseconds.
 * Returns 0 when there was never a drawdown.
 */
function computeMaxDrawdownDurationMs(
  equityCurve: readonly number[],
  barIntervalSec: number,
): number {
  let peak = 0;
  let drawdownStartBar = -1;
  let maxDurationMs = 0;

  for (let i = 0; i < equityCurve.length; i++) {
    const eq = equityCurve[i]!;
    if (eq >= peak) {
      // Recover or new peak: close any open drawdown window.
      if (drawdownStartBar >= 0) {
        const durationMs = (i - drawdownStartBar) * barIntervalSec * 1000;
        if (durationMs > maxDurationMs) maxDurationMs = durationMs;
        drawdownStartBar = -1;
      }
      peak = eq;
    } else {
      // Below peak: start drawdown window if not already started.
      if (drawdownStartBar < 0) drawdownStartBar = i;
    }
  }

  // Handle an ongoing drawdown that reaches the end of the curve.
  if (drawdownStartBar >= 0) {
    const durationMs = (equityCurve.length - drawdownStartBar) * barIntervalSec * 1000;
    if (durationMs > maxDurationMs) maxDurationMs = durationMs;
  }

  return maxDurationMs;
}

/** Per-bar log-like simple returns from an equity curve. */
function barReturns(equityCurve: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!;
    if (prev > 0) {
      out.push((equityCurve[i]! - prev) / prev);
    }
  }
  return out;
}

/** Population mean and standard deviation of an array. */
function meanAndStd(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

/** Parse CLI flags for `backtest`. */
export function parseBacktestArgs(argv: string[]): BacktestCliOptions {
  let forceRefresh = false;
  let verbose = false;
  let fromTime: number | undefined;
  let toTime: number | undefined;
  let strategy: string | undefined;
  let monteCarloRuns: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--force-refresh") {
      forceRefresh = true;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }
    if (arg === "--strategy" || arg?.startsWith("--strategy=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--strategy");
      strategy = value;
      i = nextIndex;
      continue;
    }
    if (arg === "--from" || arg?.startsWith("--from=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--from");
      fromTime = parseReplayDate(value, "from");
      i = nextIndex;
      continue;
    }
    if (arg === "--to" || arg?.startsWith("--to=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--to");
      toTime = parseReplayDate(value, "to");
      i = nextIndex;
      continue;
    }
    if (arg === "--monte-carlo" || arg?.startsWith("--monte-carlo=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--monte-carlo");
      const n = parseInt(value, 10);
      if (!(n >= 1)) throw new Error("--monte-carlo requires a positive integer");
      monteCarloRuns = n;
      i = nextIndex;
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new Error(`Unknown backtest option: ${arg}`);
    }
  }

  if (toTime !== undefined && fromTime === undefined) {
    throw new Error("--to requires --from");
  }
  if (fromTime !== undefined && toTime !== undefined && !(fromTime < toTime)) {
    throw new Error("--from must be before --to");
  }

  const result: BacktestCliOptions = {
    forceRefresh,
    verbose,
  };
  if (fromTime !== undefined) {
    result.fromTime = fromTime;
  }
  if (toTime !== undefined) {
    result.toTime = toTime;
  }
  if (strategy !== undefined) {
    result.strategy = strategy;
  }
  if (monteCarloRuns !== undefined) {
    result.monteCarloRuns = monteCarloRuns;
  }
  return result;
}

export async function printBacktestReport(
  result: BacktestResult,
  options: { verbose?: boolean } = {},
): Promise<void> {
  const { metrics, trades, candles } = result;
  const { strategy, costs } = metrics;
  const verbose = options.verbose ?? false;

  console.log("");
  console.log(`=== Backtest ${metrics.pair} | ${strategy.getDisplayName()} ===`);
  console.log(
    `Candles: ${metrics.candleCount} | ` +
      `${new Date(metrics.fromTime * 1000).toISOString()} → ${new Date(metrics.toTime * 1000).toISOString()}`,
  );
  console.log(
    `Start: ${metrics.startingCashUsdc.toFixed(2)} USDC → End equity: ${metrics.endingEquity.toFixed(2)} USDC ` +
      `(${fmtPct(metrics.totalReturnPct)})`,
  );
  console.log(
    `Buy & hold: ${metrics.holdEquity.toFixed(2)} USDC (${fmtPct(metrics.holdReturnPct)}) | ` +
      `vs hold: ${fmtSignedUsdc(metrics.vsHoldUsdc)} (${fmtSignedPct(metrics.vsHoldReturnPct)} pp)`,
  );
  console.log(
    `Realized P&L: ${metrics.realizedPnl.toFixed(4)} USDC | Trades: ${metrics.tradeCount} ` +
      `(${metrics.roundTrips} round-trips: ${metrics.longs} long, ${metrics.shorts} short; ` +
      `win rate ${fmtPct(metrics.winRate * 100)})`,
  );
  console.log(
    `Round-trip hold: min ${fmtDuration(metrics.roundTripMinMs)} | ` +
      `max ${fmtDuration(metrics.roundTripMaxMs)} | avg ${fmtDuration(metrics.roundTripAvgMs)}`,
  );
  console.log(
    `Max drawdown: ${metrics.maxDrawdownPct.toFixed(2)}% | duration: ${fmtDuration(metrics.maxDrawdownDurationMs)}`,
  );
  console.log(
    `Risk metrics — Sharpe: ${fmtRatio(metrics.sharpeRatio)} | ` +
      `Sortino: ${fmtRatio(metrics.sortinoRatio)} | ` +
      `Profit factor: ${fmtFactor(metrics.profitFactor)}`,
  );
  console.log(
    `Simulated costs — slippage: ${costs.slippageUsdc.toFixed(4)} | ` +
      `pool fees: ${costs.poolFeeUsdc.toFixed(4)} | priority: ${costs.priorityFeeUsdc.toFixed(4)} | ` +
      `perps: ${costs.perpsFeeUsdc.toFixed(4)} USDC`,
  );

  if (result.monteCarlo != null) {
    printMonteCarloStats(result.monteCarlo);
  }

  if (!verbose) {
    return;
  }

  console.log(
    "(Fills use emulated exchange costs on intra-bar OHLC ticks; last bar is forming, like live.)",
  );

  if (trades.length === 0) {
    console.log("No simulated fills.");
  } else {
    console.log("Trades (simulated):");
    const holds = roundTripHoldMs(trades);
    let opened = false;
    let holdIndex = 0;
    for (const t of trades) {
      const pnl = t.realizedPnl !== undefined ? ` pnl=${t.realizedPnl.toFixed(4)}` : "";
      let holdNote = "";
      if (t.realizedPnl === undefined) {
        opened = true;
      } else if (opened) {
        const hold = holds[holdIndex++];
        if (hold !== undefined) {
          holdNote = ` hold=${fmtDuration(hold)}`;
        }
        opened = false;
      }
      const reason = t.reason ? ` — ${t.reason}` : "";
      const endOfTrip = t.realizedPnl !== undefined ? "\n" : "";
      console.log(
        `  ${t.at.toISOString()} ${t.side} size=${t.size.toFixed(6)} @ ${t.price.toFixed(6)}${pnl}${holdNote}${reason}${endOfTrip}`,
      );
    }
  }

  if (candles.length > 0) {
    console.log("");
    console.log(await renderConsoleChart({ pair: metrics.pair, candles, trades }));
  }
}

function fmtDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const sec = Math.round(Math.abs(ms) / 1000);
  if (sec < 60) {
    return `${sign}${sec}s`;
  }
  const minutes = Math.floor(sec / 60);
  if (minutes < 60) {
    return `${sign}${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 48) {
    return remMin === 0 ? `${sign}${hours}h` : `${sign}${hours}h ${remMin}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${sign}${days}d` : `${sign}${days}d ${remHours}h`;
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtSignedPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtSignedUsdc(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)} USDC`;
}

/** Format a ratio like Sharpe/Sortino to 2 decimal places. */
function fmtRatio(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}`;
}

/** Format profit factor; Infinity displays as ">999". */
function fmtFactor(n: number): string {
  if (!Number.isFinite(n)) return ">999";
  return n.toFixed(2);
}

function printMonteCarloStats(mc: MonteCarloStats): void {
  const w = 7; // column width for values
  const pad = (s: string) => s.padStart(w);
  const pctDist = (d: MonteCarloDistribution) =>
    `p5=${pad(fmtPct(d.p5))}  p50=${pad(fmtPct(d.p50))}  p95=${pad(fmtPct(d.p95))}  mean=${pad(fmtPct(d.mean))}`;
  const ratioDist = (d: MonteCarloDistribution) =>
    `p5=${pad(fmtRatio(d.p5))}  p50=${pad(fmtRatio(d.p50))}  p95=${pad(fmtRatio(d.p95))}  mean=${pad(fmtRatio(d.mean))}`;
  const factorDist = (d: MonteCarloDistribution) =>
    `p5=${pad(fmtFactor(d.p5))}  p50=${pad(fmtFactor(d.p50))}  p95=${pad(fmtFactor(d.p95))}  mean=${pad(fmtFactor(d.mean))}`;

  console.log(`Monte Carlo (${mc.runs} runs, randomized intra-bar paths):`);
  console.log(`  Return     ${pctDist(mc.totalReturnPct)}`);
  console.log(`  Sharpe     ${ratioDist(mc.sharpeRatio)}`);
  console.log(`  Max DD     ${pctDist(mc.maxDrawdownPct)}`);
  console.log(`  Profit fac ${factorDist(mc.profitFactor)}`);
}
