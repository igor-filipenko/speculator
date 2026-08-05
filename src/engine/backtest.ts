import type { AppConfig } from "../config.js";
import { strategyParams } from "../config.js";
import {
  emulateFillPrice,
  liquidityTierForPair,
  type EmulatedFillBreakdown,
} from "../jupiter/emulated-quote.js";
import { loadCachedCandles } from "../market/ohlcv-cache.js";
import { PaperPortfolio } from "../paper/portfolio.js";
import { evaluateEmaRsi } from "../strategy/ema-rsi.js";
import type { Candle, PairConfig, StrategyParams, Trade } from "../types.js";

export interface BacktestCliOptions {
  /** Lookback window in calendar days. */
  days: number;
  forceRefresh: boolean;
}

export interface BacktestCostTotals {
  /** Sum of (fillSize * mid * slippage) across fills. */
  slippageUsdc: number;
  /** Sum of (fillSize * mid * poolFee) across fills. */
  poolFeeUsdc: number;
  /** Sum of priority fees in USDC. */
  priorityFeeUsdc: number;
}

export interface BacktestMetrics {
  pair: string;
  strategy: StrategyParams;
  startingCashUsdc: number;
  endingEquity: number;
  totalReturnPct: number;
  realizedPnl: number;
  tradeCount: number;
  roundTrips: number;
  wins: number;
  winRate: number;
  maxDrawdownPct: number;
  costs: BacktestCostTotals;
  candleCount: number;
  fromTime: number;
  toTime: number;
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  trades: Trade[];
  equityCurve: number[];
}

export interface RunBacktestOptions {
  config: AppConfig;
  days?: number;
  forceRefresh?: boolean;
  /** Override cache directory (tests). */
  cacheDir?: string;
  /** Inject candles (skips network/cache; tests). */
  candles?: Candle[];
}

/**
 * Replay OHLCV through EMA/RSI with Jupiter-like simulated fills.
 */
export async function runBacktest(options: RunBacktestOptions): Promise<BacktestResult[]> {
  const strategy = strategyParams(options.config.strategy);
  const days =
    options.days !== undefined && options.days > 0
      ? options.days
      : strategy.mode === "swing"
        ? 90
        : 30;
  const toTime = Math.floor(Date.now() / 1000);
  const fromTime = toTime - days * 24 * 60 * 60;

  const results: BacktestResult[] = [];
  for (const pair of options.config.pairs) {
    const candles =
      options.candles ??
      (await loadCachedCandles({
        poolAddress: pair.geckoPoolAddress,
        timeframe: strategy.timeframe,
        fromTime,
        toTime,
        forceRefresh: options.forceRefresh ?? false,
        ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
      }));

    if (candles.length === 0) {
      throw new Error(
        `No candles for ${pair.symbol} (${strategy.timeframe}) in the last ${days} days`,
      );
    }

    results.push(
      replayPair({
        pair,
        strategy,
        candles,
        startingCashUsdc: options.config.paperCashUsdc,
        fromTime: candles[0]!.time,
        toTime: candles[candles.length - 1]!.time + 1,
      }),
    );
  }

  return results;
}

function replayPair(args: {
  pair: PairConfig;
  strategy: StrategyParams;
  candles: Candle[];
  startingCashUsdc: number;
  fromTime: number;
  toTime: number;
}): BacktestResult {
  const { pair, strategy, candles, startingCashUsdc } = args;
  const portfolio = new PaperPortfolio(pair.symbol, startingCashUsdc);
  const tier = liquidityTierForPair(pair.symbol);
  const costs: BacktestCostTotals = {
    slippageUsdc: 0,
    poolFeeUsdc: 0,
    priorityFeeUsdc: 0,
  };

  const equityCurve: number[] = [];
  let peakEquity = startingCashUsdc;
  let maxDrawdownPct = 0;

  const warmBars = strategy.emaSlow + strategy.rsiPeriod + 2;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const window = candles.slice(0, i + 1);
    const close = candle.close;

    const signal = evaluateEmaRsi({
      pair: pair.symbol,
      candles: window,
      strategy,
      price: close,
      at: new Date(candle.time * 1000),
    });

    if (i >= warmBars && (signal.side === "BUY" || signal.side === "SELL")) {
      const emulated = emulateFillPrice({ side: signal.side, close, tier });
      const fillSignal = { ...signal, price: emulated.fillPrice };
      const trade = portfolio.applySignalSync(fillSignal, {
        priorityFeeUsdc: emulated.priorityFeeUsdc,
      });

      if (trade) {
        accumulateCosts(costs, trade, emulated.breakdown);
      }
    }

    const equity = portfolio.getSnapshot(close).equity;
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

  const lastClose = candles[candles.length - 1]!.close;
  const snap = portfolio.getSnapshot(lastClose);
  const sells = snap.trades.filter((t) => t.side === "SELL");
  const wins = sells.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const roundTrips = sells.length;
  const totalReturnPct =
    startingCashUsdc > 0 ? ((snap.equity - startingCashUsdc) / startingCashUsdc) * 100 : 0;

  return {
    metrics: {
      pair: pair.symbol,
      strategy,
      startingCashUsdc,
      endingEquity: snap.equity,
      totalReturnPct,
      realizedPnl: snap.realizedPnl,
      tradeCount: snap.trades.length,
      roundTrips,
      wins,
      winRate: roundTrips > 0 ? wins / roundTrips : 0,
      maxDrawdownPct,
      costs,
      candleCount: candles.length,
      fromTime: args.fromTime,
      toTime: args.toTime,
    },
    trades: snap.trades,
    equityCurve,
  };
}

function accumulateCosts(
  totals: BacktestCostTotals,
  trade: Trade,
  breakdown: EmulatedFillBreakdown,
): void {
  totals.slippageUsdc += trade.size * breakdown.slippageUsdcPerBase;
  totals.poolFeeUsdc += trade.size * breakdown.poolFeeUsdcPerBase;
  totals.priorityFeeUsdc += breakdown.priorityFeeUsdc;
}

/** Parse CLI flags for `backtest`. */
export function parseBacktestArgs(argv: string[]): BacktestCliOptions {
  let days = 0;
  let forceRefresh = false;
  let daysExplicit = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--force-refresh") {
      forceRefresh = true;
      continue;
    }
    if (arg === "--days") {
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith("-")) {
        throw new Error("--days requires a positive integer");
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --days value: ${raw}`);
      }
      days = n;
      daysExplicit = true;
      i++;
      continue;
    }
    if (arg?.startsWith("--days=")) {
      const raw = arg.slice("--days=".length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --days value: ${raw}`);
      }
      days = n;
      daysExplicit = true;
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new Error(`Unknown backtest option: ${arg}`);
    }
  }

  return {
    // 0 means "use strategy default" — resolved in runBacktest / print.
    days: daysExplicit ? days : 0,
    forceRefresh,
  };
}

export function printBacktestReport(result: BacktestResult): void {
  const { metrics, trades } = result;
  const { strategy, costs } = metrics;

  console.log("");
  console.log(`=== Backtest ${metrics.pair} | ${strategy.mode} (${strategy.timeframe}) ===`);
  console.log(
    `Candles: ${metrics.candleCount} | ` +
      `${new Date(metrics.fromTime * 1000).toISOString()} → ${new Date(metrics.toTime * 1000).toISOString()}`,
  );
  console.log(
    `Start: ${metrics.startingCashUsdc.toFixed(2)} USDC → End equity: ${metrics.endingEquity.toFixed(2)} USDC ` +
      `(${fmtPct(metrics.totalReturnPct)})`,
  );
  console.log(
    `Realized P&L: ${metrics.realizedPnl.toFixed(4)} USDC | Trades: ${metrics.tradeCount} ` +
      `(${metrics.roundTrips} round-trips, win rate ${fmtPct(metrics.winRate * 100)})`,
  );
  console.log(`Max drawdown: ${metrics.maxDrawdownPct.toFixed(2)}%`);
  console.log(
    `Simulated costs — slippage: ${costs.slippageUsdc.toFixed(4)} | ` +
      `pool fees: ${costs.poolFeeUsdc.toFixed(4)} | priority: ${costs.priorityFeeUsdc.toFixed(4)} USDC`,
  );
  console.log("(Fills use emulated Jupiter costs on candle close; not live quotes.)");

  if (trades.length === 0) {
    console.log("No simulated fills.");
    return;
  }

  console.log("Trades (simulated):");
  for (const t of trades) {
    const pnl = t.realizedPnl !== undefined ? ` pnl=${t.realizedPnl.toFixed(4)}` : "";
    console.log(
      `  ${t.at.toISOString()} ${t.side} size=${t.size.toFixed(6)} @ ${t.price.toFixed(6)}${pnl}`,
    );
  }
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
