import { renderConsoleChart } from "../chart/render-console.js";
import type { AppConfig } from "../config.js";
import { EmulatedExchange } from "../exchange/emulated-exchange.js";
import { emulateFillPrice, liquidityTierForPair } from "../exchange/emulated-quote.js";
import { loadCachedCandles } from "../market/ohlcv-cache.js";
import { PaperPortfolio } from "../paper/portfolio.js";
import type {
  Candle,
  MarketIndicators,
  Order,
  PairConfig,
  Strategy,
  StrategyManager,
  Trade,
} from "../types.js";
import { loadHtfCandles, loadMtfCandles, syncMarketIndicators } from "./market-replay.js";
import { parseReplayDate, readFlagValue, resolveReplayWindow } from "./replay-window.js";

export { parseReplayDate as parseBacktestDate, resolveReplayWindow as resolveBacktestWindow };

export interface BacktestCliOptions {
  /** Lookback window in calendar days (0 = 90-day default, ignored when from/to set). */
  days: number;
  /** Inclusive range start (Unix seconds). Mutually exclusive with `--days`. */
  fromTime?: number;
  /** Exclusive range end (Unix seconds). Defaults to now when only `--from` is set. */
  toTime?: number;
  forceRefresh: boolean;
  /** Skip HTF market indicators (no applyMarketIndicators, no MARKET logs). */
  ignoreTrend: boolean;
  /** CLI override for strategy (takes precedence over env STRATEGY). */
  strategy?: string;
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
  /** OHLCV series used for the replay (for console chart). */
  candles: Candle[];
}

export interface RunBacktestOptions {
  config: AppConfig;
  strategyManager: StrategyManager;
  days?: number;
  /** Inclusive range start (Unix seconds). Takes precedence over `--days`. */
  fromTime?: number;
  /** Exclusive range end (Unix seconds). Defaults to now. */
  toTime?: number;
  forceRefresh?: boolean;
  /** Skip HTF evaluate/apply/log (strategy risk params stay as constructed). */
  ignoreTrend?: boolean;
  /** Inject signal-timeframe candles (skips network/cache; tests). */
  candles?: Candle[];
  /** Inject HTF candles for {@link StrategyManager}; skips HTF fetch when set. */
  htfCandles?: Candle[];
  /** Inject 1h candles for volatility; skips 1h fetch when set. */
  mtfCandles?: Candle[];
}

/**
 * Replay OHLCV through the active strategy/risk from {@link StrategyManager}.
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

    const ignoreTrend = options.ignoreTrend ?? false;
    const skipNetwork = options.candles !== undefined;
    const htfCandles = ignoreTrend
      ? []
      : await loadHtfCandles({
          pair,
          strategyManager,
          fromTime,
          toTime,
          injected: options.htfCandles,
          skipFetch: skipNetwork && options.htfCandles === undefined,
          cacheOpts,
        });
    const mtfCandles = ignoreTrend
      ? []
      : await loadMtfCandles({
          pair,
          strategyManager,
          fromTime,
          toTime,
          injected: options.mtfCandles,
          skipFetch: skipNetwork && options.mtfCandles === undefined,
          cacheOpts,
        });

    results.push(
      await replayPair({
        pair,
        strategyManager,
        candles,
        htfCandles,
        mtfCandles,
        ignoreTrend,
        startingCashUsdc: options.config.paperCashUsdc,
        fromTime: candles[0]!.time,
        toTime: candles[candles.length - 1]!.time + 1,
      }),
    );
  }

  return results;
}

async function replayPair(args: {
  pair: PairConfig;
  strategyManager: StrategyManager;
  candles: Candle[];
  htfCandles: Candle[];
  mtfCandles: Candle[];
  ignoreTrend: boolean;
  startingCashUsdc: number;
  fromTime: number;
  toTime: number;
}): Promise<BacktestResult> {
  const { pair, strategyManager, candles, htfCandles, mtfCandles, ignoreTrend, startingCashUsdc } =
    args;
  const portfolio = new PaperPortfolio(pair.symbol, startingCashUsdc);
  const exchange = new EmulatedExchange();
  const costs: BacktestCostTotals = {
    slippageUsdc: 0,
    poolFeeUsdc: 0,
    priorityFeeUsdc: 0,
  };

  const equityCurve: number[] = [];
  let peakEquity = startingCashUsdc;
  let maxDrawdownPct = 0;
  let htfEnd = 0;
  let mtfEnd = 0;
  let lastMarket: MarketIndicators | undefined;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const window = candles.slice(0, i + 1);
    const close = candle.close;
    exchange.setMidPrice(close);

    if (!ignoreTrend) {
      const synced = syncMarketIndicators({
        pair: pair.symbol,
        strategyManager,
        htfCandles,
        mtfCandles,
        atTime: candle.time,
        price: close,
        htfEnd,
        mtfEnd,
        lastMarket,
      });
      htfEnd = synced.htfEnd;
      mtfEnd = synced.mtfEnd;
      lastMarket = synced.lastMarket;
    }

    const strategy = strategyManager.getActiveStrategy();
    const riskManager = strategyManager.getActiveRiskManager();

    const market = lastMarket ?? {
      pair: pair.symbol,
      price: close,
      trend: "unknown" as const,
      volatility: "unknown" as const,
    };
    const signal = strategy.evaluateSignal(
      pair.symbol,
      window,
      market,
      close,
      new Date(candle.time * 1000),
      portfolio.getSnapshot(close),
    );

    const result = riskManager.check(signal, portfolio.getSnapshot(close), window);
    if (result.kind === "command") {
      const command = result.command;
      // Protective exits fill at the stop/trail level; cross signals use candle close.
      exchange.setMidPrice(command.priceHint > 0 ? command.priceHint : close);
      const order = await exchange.execute(command, pair);
      const trade = portfolio.applyOrderSync(order);
      if (trade) {
        accumulateCosts(costs, trade, order);
      }
      exchange.setMidPrice(close);
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

  const firstClose = candles[0]!.close;
  const lastClose = candles[candles.length - 1]!.close;
  const snap = portfolio.getSnapshot(lastClose);
  const sells = snap.trades.filter((t) => t.side === "SELL");
  const wins = sells.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const roundTrips = sells.length;
  const totalReturnPct =
    startingCashUsdc > 0 ? ((snap.equity - startingCashUsdc) / startingCashUsdc) * 100 : 0;
  const holdEquity = computeBuyHoldEquity(startingCashUsdc, firstClose, lastClose, pair.symbol);
  const holdReturnPct =
    startingCashUsdc > 0 ? ((holdEquity - startingCashUsdc) / startingCashUsdc) * 100 : 0;

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

function accumulateCosts(totals: BacktestCostTotals, trade: Trade, order: Order): void {
  const fillCosts = order.fillCosts;
  if (!fillCosts) {
    totals.priorityFeeUsdc += order.priorityFeeUsdc;
    return;
  }
  totals.slippageUsdc += trade.size * fillCosts.slippageUsdcPerBase;
  totals.poolFeeUsdc += trade.size * fillCosts.poolFeeUsdcPerBase;
  totals.priorityFeeUsdc += order.priorityFeeUsdc;
}

/** Parse CLI flags for `backtest`. */
export function parseBacktestArgs(argv: string[]): BacktestCliOptions {
  let days = 0;
  let forceRefresh = false;
  let ignoreTrend = false;
  let daysExplicit = false;
  let fromTime: number | undefined;
  let toTime: number | undefined;
  let strategy: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--force-refresh") {
      forceRefresh = true;
      continue;
    }
    if (arg === "--ignore-trend") {
      ignoreTrend = true;
      continue;
    }
    if (arg === "--strategy" || arg?.startsWith("--strategy=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--strategy");
      strategy = value;
      i = nextIndex;
      continue;
    }
    if (arg === "--days" || arg?.startsWith("--days=")) {
      const { value, nextIndex } = readFlagValue(argv, i, "--days");
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --days value: ${value}`);
      }
      days = n;
      daysExplicit = true;
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
    if (arg?.startsWith("-")) {
      throw new Error(`Unknown backtest option: ${arg}`);
    }
  }

  if (fromTime !== undefined && daysExplicit) {
    throw new Error("Use either --days or --from/--to, not both");
  }
  if (toTime !== undefined && fromTime === undefined) {
    throw new Error("--to requires --from");
  }
  if (fromTime !== undefined && toTime !== undefined && !(fromTime < toTime)) {
    throw new Error("--from must be before --to");
  }

  const result: BacktestCliOptions = {
    days: daysExplicit ? days : 0,
    forceRefresh,
    ignoreTrend,
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
  return result;
}

export async function printBacktestReport(result: BacktestResult): Promise<void> {
  const { metrics, trades, candles } = result;
  const { strategy, costs } = metrics;

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
      `(${metrics.roundTrips} round-trips, win rate ${fmtPct(metrics.winRate * 100)})`,
  );
  console.log(`Max drawdown: ${metrics.maxDrawdownPct.toFixed(2)}%`);
  console.log(
    `Simulated costs — slippage: ${costs.slippageUsdc.toFixed(4)} | ` +
      `pool fees: ${costs.poolFeeUsdc.toFixed(4)} | priority: ${costs.priorityFeeUsdc.toFixed(4)} USDC`,
  );
  console.log("(Fills use emulated exchange costs on candle close; not live quotes.)");

  if (trades.length === 0) {
    console.log("No simulated fills.");
  } else {
    console.log("Trades (simulated):");
    for (const t of trades) {
      const pnl = t.realizedPnl !== undefined ? ` pnl=${t.realizedPnl.toFixed(4)}` : "";
      const reason = t.reason ? ` — ${t.reason}` : "";
      const endOfTrip = t.side === "SELL" ? "\n" : "";
      console.log(
        `  ${t.at.toISOString()} ${t.side} size=${t.size.toFixed(6)} @ ${t.price.toFixed(6)}${pnl}${reason}${endOfTrip}`,
      );
    }
  }

  if (candles.length > 0) {
    console.log("");
    console.log(await renderConsoleChart({ pair: metrics.pair, candles, trades }));
  }
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
