import { renderConsoleChart } from "../chart/render-console.js";
import type { AppConfig } from "../config.js";
import { EmulatedExchange } from "../exchange/emulated-exchange.js";
import { candleIntervalSeconds } from "../market/gecko-terminal.js";
import { loadCachedCandles } from "../market/ohlcv-cache.js";
import { logMarket } from "../notify/console.js";
import { PaperPortfolio } from "../paper/portfolio.js";
import type {
  Candle,
  MarketState,
  Order,
  PairConfig,
  Strategy,
  StrategyManager,
  Trade,
} from "../types.js";

export interface BacktestCliOptions {
  /** Lookback window in calendar days (0 = 90-day default, ignored when from/to set). */
  days: number;
  /** Inclusive range start (Unix seconds). Mutually exclusive with `--days`. */
  fromTime?: number;
  /** Exclusive range end (Unix seconds). Defaults to now when only `--from` is set. */
  toTime?: number;
  forceRefresh: boolean;
  /** Skip HTF market state (no applyMarketState, no MARKET logs). */
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
  /** Override data directory (tests). */
  dataDir?: string;
  /** Inject signal-timeframe candles (skips network/cache; tests). */
  candles?: Candle[];
  /** Inject HTF candles for {@link StrategyManager}; skips HTF fetch when set. */
  htfCandles?: Candle[];
}

/**
 * Replay OHLCV through the active strategy/risk from {@link StrategyManager}.
 * HTF candles are loaded once per pair; market state is evaluated as those bars close.
 */
export async function runBacktest(options: RunBacktestOptions): Promise<BacktestResult[]> {
  const { strategyManager } = options;
  const strategy = strategyManager.getActiveStrategy();
  const { fromTime, toTime } = resolveBacktestWindow(options);
  const timeframe = strategy.getRequiredCandles().timeframe;
  const cacheOpts = {
    forceRefresh: options.forceRefresh ?? false,
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
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
    const htfCandles = ignoreTrend
      ? []
      : await loadHtfCandles({
          pair,
          strategyManager,
          fromTime,
          toTime,
          injected: options.htfCandles,
          skipFetch: options.candles !== undefined && options.htfCandles === undefined,
          cacheOpts,
        });

    results.push(
      await replayPair({
        pair,
        strategyManager,
        candles,
        htfCandles,
        ignoreTrend,
        startingCashUsdc: options.config.paperCashUsdc,
        fromTime: candles[0]!.time,
        toTime: candles[candles.length - 1]!.time + 1,
      }),
    );
  }

  return results;
}

async function loadHtfCandles(args: {
  pair: PairConfig;
  strategyManager: StrategyManager;
  fromTime: number;
  toTime: number;
  injected: Candle[] | undefined;
  skipFetch: boolean;
  cacheOpts: { forceRefresh: boolean; dataDir?: string };
}): Promise<Candle[]> {
  if (args.injected !== undefined) {
    return args.injected;
  }
  if (args.skipFetch) {
    return [];
  }

  const required = args.strategyManager.getRequiredCandles();
  const interval = candleIntervalSeconds(required.timeframe);
  const candles = await loadCachedCandles({
    symbol: args.pair.symbol,
    poolAddress: args.pair.geckoPoolAddress,
    timeframe: required.timeframe,
    fromTime: args.fromTime - required.count * interval,
    toTime: args.toTime,
    ...args.cacheOpts,
  });
  if (candles.length === 0) {
    console.log(`[${args.pair.symbol}] no HTF ${required.timeframe} candles; market state skipped`);
  }
  return candles;
}

async function replayPair(args: {
  pair: PairConfig;
  strategyManager: StrategyManager;
  candles: Candle[];
  htfCandles: Candle[];
  ignoreTrend: boolean;
  startingCashUsdc: number;
  fromTime: number;
  toTime: number;
}): Promise<BacktestResult> {
  const { pair, strategyManager, candles, htfCandles, ignoreTrend, startingCashUsdc } = args;
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
  let lastMarket: MarketState | undefined;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const window = candles.slice(0, i + 1);
    const close = candle.close;
    exchange.setMidPrice(close);

    if (!ignoreTrend) {
      const synced = syncMarketState({
        pair: pair.symbol,
        strategyManager,
        htfCandles,
        atTime: candle.time,
        price: close,
        htfEnd,
        lastMarket,
      });
      htfEnd = synced.htfEnd;
      lastMarket = synced.lastMarket;
    }

    const strategy = strategyManager.getActiveStrategy();
    const riskManager = strategyManager.getActiveRiskManager();

    const signal = strategy.evaluateSignal(
      pair.symbol,
      window,
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
      strategy: strategyManager.getActiveStrategy(),
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
    candles,
  };
}

function advanceHtfEnd(htfCandles: Candle[], atTime: number, htfEnd: number): number {
  let end = htfEnd;
  while (end < htfCandles.length && htfCandles[end]!.time <= atTime) {
    end += 1;
  }
  return end;
}

function syncMarketState(args: {
  pair: string;
  strategyManager: StrategyManager;
  htfCandles: Candle[];
  atTime: number;
  price: number;
  htfEnd: number;
  lastMarket: MarketState | undefined;
}): { htfEnd: number; lastMarket: MarketState | undefined } {
  const htfEnd = advanceHtfEnd(args.htfCandles, args.atTime, args.htfEnd);
  if (htfEnd === 0 || htfEnd === args.htfEnd) {
    return { htfEnd, lastMarket: args.lastMarket };
  }

  const htfWindow = args.htfCandles.slice(0, htfEnd);
  const lastHtf = htfWindow[htfWindow.length - 1]!;
  const market = args.strategyManager.evaluate(
    args.pair,
    htfWindow,
    args.price,
    new Date(lastHtf.time * 1000),
  );
  const first = args.lastMarket === undefined;
  const trendChanged = args.lastMarket !== undefined && args.lastMarket.trend !== market.trend;
  if (first || trendChanged) {
    logMarket(market);
  }
  args.strategyManager.applyMarketState(market, args.lastMarket);
  return { htfEnd, lastMarket: market };
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
function resolveBacktestWindow(options: Pick<RunBacktestOptions, "days" | "fromTime" | "toTime">): {
  fromTime: number;
  toTime: number;
} {
  const now = Math.floor(Date.now() / 1000);

  if (options.fromTime !== undefined) {
    const fromTime = options.fromTime;
    const toTime = options.toTime ?? now;
    if (!(fromTime < toTime)) {
      throw new Error(`Invalid backtest window: from (${fromTime}) must be before to (${toTime})`);
    }
    return { fromTime, toTime };
  }

  if (options.toTime !== undefined) {
    throw new Error("--to requires --from (or use --days for a lookback from now)");
  }

  const days = options.days !== undefined && options.days > 0 ? options.days : 90;
  return { fromTime: now - days * 24 * 60 * 60, toTime: now };
}

/**
 * Parse a calendar date or ISO datetime into Unix seconds.
 * Date-only forms are UTC. Supported:
 * - `YYYY-MM-DD` / `YYYY-MM-DDTHH:mm:ssZ`
 * - `DD-MM-YYYY` (e.g. 01-01-2026)
 */
export function parseBacktestDate(raw: string, bound: "from" | "to"): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Empty --${bound} date`);
  }

  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(trimmed);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    return calendarDayBoundUtc(year, month, day, bound);
  }

  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    return calendarDayBoundUtc(year, month, day, bound);
  }

  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(
      `Invalid --${bound} date "${raw}". Use YYYY-MM-DD, DD-MM-YYYY, or an ISO datetime.`,
    );
  }
  return Math.floor(ms / 1000);
}

function calendarDayBoundUtc(
  year: number,
  month: number,
  day: number,
  bound: "from" | "to",
): number {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid calendar date ${year}-${month}-${day}`);
  }
  // --from = start of that UTC day; --to = start of the next UTC day (exclusive end).
  const startMs = Date.UTC(year, month - 1, day);
  const check = new Date(startMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(
      `Invalid calendar date ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    );
  }
  if (bound === "from") {
    return Math.floor(startMs / 1000);
  }
  return Math.floor(Date.UTC(year, month - 1, day + 1) / 1000);
}

function readFlagValue(
  argv: string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } {
  const eq = argv[index];
  if (eq?.startsWith(`${flag}=`)) {
    const value = eq.slice(flag.length + 1);
    if (!value) {
      throw new Error(`${flag} requires a value`);
    }
    return { value, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return { value, nextIndex: index + 1 };
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
      console.log(
        `  ${t.at.toISOString()} ${t.side} size=${t.size.toFixed(6)} @ ${t.price.toFixed(6)}${pnl}${reason}`,
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
