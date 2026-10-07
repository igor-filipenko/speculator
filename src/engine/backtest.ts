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

    results.push(
      await replayPair({
        pair,
        strategyManager,
        candles,
        htfCandles,
        mtfCandles,
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
  startingCashUsdc: number;
  fromTime: number;
  toTime: number;
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
    const ticks = intraBarTicks(candle, barIntervalSec, positionSide);

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

/** Parse CLI flags for `backtest`. */
export function parseBacktestArgs(argv: string[]): BacktestCliOptions {
  let forceRefresh = false;
  let verbose = false;
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
  console.log(`Max drawdown: ${metrics.maxDrawdownPct.toFixed(2)}%`);
  console.log(
    `Simulated costs — slippage: ${costs.slippageUsdc.toFixed(4)} | ` +
      `pool fees: ${costs.poolFeeUsdc.toFixed(4)} | priority: ${costs.priorityFeeUsdc.toFixed(4)} | ` +
      `perps: ${costs.perpsFeeUsdc.toFixed(4)} USDC`,
  );

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
