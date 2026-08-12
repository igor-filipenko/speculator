import { renderConsoleChart } from "../chart/render-console.js";
import type { AppConfig } from "../config.js";
import { EmulatedExchange } from "../exchange/emulated-exchange.js";
import { loadCachedCandles } from "../market/ohlcv-cache.js";
import { PaperPortfolio } from "../paper/portfolio.js";
import type { Candle, Order, PairConfig, RiskManager, Strategy, Trade } from "../types.js";

export interface BacktestCliOptions {
  /** Lookback window in calendar days (0 = strategy default, ignored when from/to set). */
  days: number;
  /** Inclusive range start (Unix seconds). Mutually exclusive with `--days`. */
  fromTime?: number;
  /** Exclusive range end (Unix seconds). Defaults to now when only `--from` is set. */
  toTime?: number;
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
  strategy: Strategy;
  risk: RiskManager;
  days?: number;
  /** Inclusive range start (Unix seconds). Takes precedence over `--days`. */
  fromTime?: number;
  /** Exclusive range end (Unix seconds). Defaults to now. */
  toTime?: number;
  forceRefresh?: boolean;
  /** Override data directory (tests). */
  dataDir?: string;
  /** Inject candles (skips network/cache; tests). */
  candles?: Candle[];
}

/**
 * Replay OHLCV through EMA/RSI with emulated exchange fills.
 */
export async function runBacktest(options: RunBacktestOptions): Promise<BacktestResult[]> {
  const strategy = options.strategy;
  const { fromTime, toTime } = resolveBacktestWindow(options, strategy);
  const timeframe = strategy.getRequiredCandles().timeframe;

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
        forceRefresh: options.forceRefresh ?? false,
        ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
      }));

    if (candles.length === 0) {
      throw new Error(
        `No candles for ${pair.symbol} (${timeframe}) in ` +
          `${new Date(fromTime * 1000).toISOString()} → ${new Date(toTime * 1000).toISOString()}`,
      );
    }

    results.push(
      await replayPair({
        pair,
        strategy,
        risk: options.risk,
        candles,
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
  strategy: Strategy;
  risk: RiskManager;
  candles: Candle[];
  startingCashUsdc: number;
  fromTime: number;
  toTime: number;
}): Promise<BacktestResult> {
  const { pair, strategy, risk, candles, startingCashUsdc } = args;
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

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const window = candles.slice(0, i + 1);
    const close = candle.close;
    exchange.setMidPrice(close);

    const signal = strategy.evaluateSignal(
      pair.symbol,
      window,
      close,
      new Date(candle.time * 1000),
    );

    const command = risk.check(signal, portfolio.getSnapshot(close));
    if (command) {
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
    candles,
  };
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
function resolveBacktestWindow(
  options: Pick<RunBacktestOptions, "days" | "fromTime" | "toTime">,
  strategy: Strategy,
): { fromTime: number; toTime: number } {
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

  const days =
    options.days !== undefined && options.days > 0
      ? options.days
      : strategy.getMode() === "swing"
        ? 90
        : 30;
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
  let daysExplicit = false;
  let fromTime: number | undefined;
  let toTime: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--force-refresh") {
      forceRefresh = true;
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
  };
  if (fromTime !== undefined) {
    result.fromTime = fromTime;
  }
  if (toTime !== undefined) {
    result.toTime = toTime;
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
