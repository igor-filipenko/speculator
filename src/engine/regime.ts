import {
  renderConsoleChart,
  trendColor,
  trendLabel,
  volColor,
  volLabel,
  type ChartEvent,
  type RegimeBandSample,
} from "../chart/render-console.js";
import type { AppConfig } from "../config.js";
import type {
  Candle,
  MarketIndicators,
  PairConfig,
  StrategyManager,
  Timeframe,
  Trend,
  Volatility,
} from "../types.js";
import { loadHtfCandles, loadMtfCandles, syncMarketIndicators } from "./market-replay.js";
import { parseReplayDate, readFlagValue, resolveReplayWindow } from "./replay-window.js";

export interface RegimeCliOptions {
  /** Lookback window in calendar days (0 = 90-day default, ignored when from/to set). */
  days: number;
  fromTime?: number;
  toTime?: number;
  forceRefresh: boolean;
}

export interface RegimeChange {
  at: Date;
  price: number;
  previous?: { trend: Trend; volatility: Volatility };
  market: MarketIndicators;
  strategyName: string;
  riskName: string;
}

export interface RegimeSegment {
  trend: Trend;
  volatility: Volatility;
  fromTime: number;
  toTime: number;
  samples: number;
}

export interface RegimeResult {
  pair: string;
  htfTimeframe: Timeframe;
  mtfTimeframe: Timeframe;
  fromTime: number;
  toTime: number;
  htfCandleCount: number;
  mtfCandleCount: number;
  sampleCount: number;
  changes: RegimeChange[];
  segments: RegimeSegment[];
  samples: RegimeBandSample[];
  chartCandles: Candle[];
}

export interface RunRegimeOptions {
  config: AppConfig;
  strategyManager: StrategyManager;
  days?: number;
  fromTime?: number;
  toTime?: number;
  forceRefresh?: boolean;
  htfCandles?: Candle[];
  mtfCandles?: Candle[];
}

/**
 * Replay HTF + 1h bars (same close cadence as backtest) and record every
 * trend / volatility switch, including the strategy/risk that would activate.
 */
export async function runRegime(options: RunRegimeOptions): Promise<RegimeResult[]> {
  const { strategyManager } = options;
  const { fromTime, toTime } = resolveReplayWindow(options);
  const cacheOpts = { forceRefresh: options.forceRefresh ?? false };
  const skipNetwork = options.htfCandles !== undefined || options.mtfCandles !== undefined;

  const results: RegimeResult[] = [];
  for (const pair of options.config.pairs) {
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

    if (htfCandles.length === 0 && mtfCandles.length === 0) {
      throw new Error(
        `No HTF/MTF candles for ${pair.symbol} in ` +
          `${new Date(fromTime * 1000).toISOString()} → ${new Date(toTime * 1000).toISOString()}`,
      );
    }

    results.push(
      replayRegime({
        pair,
        strategyManager,
        htfCandles,
        mtfCandles,
        fromTime,
        toTime,
      }),
    );
  }
  return results;
}

function replayRegime(args: {
  pair: PairConfig;
  strategyManager: StrategyManager;
  htfCandles: Candle[];
  mtfCandles: Candle[];
  fromTime: number;
  toTime: number;
}): RegimeResult {
  const { pair, strategyManager, htfCandles, mtfCandles, fromTime, toTime } = args;
  const times = uniqueTimes(htfCandles, mtfCandles);
  const priceAt = priceByTime(htfCandles, mtfCandles);

  const changes: RegimeChange[] = [];
  const samples: RegimeBandSample[] = [];
  let htfEnd = 0;
  let mtfEnd = 0;
  let lastMarket: MarketIndicators | undefined;

  for (const atTime of times) {
    const price = priceAt.get(atTime) ?? lastMarket?.price ?? 0;
    const synced = syncMarketIndicators({
      pair: pair.symbol,
      strategyManager,
      htfCandles,
      mtfCandles,
      atTime,
      price,
      htfEnd,
      mtfEnd,
      lastMarket,
    });
    htfEnd = synced.htfEnd;
    mtfEnd = synced.mtfEnd;
    if (!synced.evaluated || synced.lastMarket === undefined) {
      continue;
    }

    const market = synced.lastMarket;
    lastMarket = market;
    if (atTime < fromTime || atTime >= toTime) {
      continue;
    }

    samples.push({
      at: new Date(atTime * 1000),
      trend: market.trend,
      volatility: market.volatility,
    });

    const previous = changes[changes.length - 1]?.market;
    const switched = previous?.trend !== market.trend || previous?.volatility !== market.volatility;
    if (!switched) {
      continue;
    }

    const change: RegimeChange = {
      at: new Date(atTime * 1000),
      price: market.price,
      market,
      strategyName: strategyManager.getActiveStrategy().getDisplayName(),
      riskName: strategyManager.getActiveRiskManager().getDisplayName(),
    };
    if (previous !== undefined) {
      change.previous = { trend: previous.trend, volatility: previous.volatility };
    }
    changes.push(change);
  }

  const windowEnd = times.length > 0 ? Math.min(toTime, times[times.length - 1]! + 1) : toTime;
  const chartSource = mtfCandles.length > 0 ? mtfCandles : htfCandles;
  const chartCandles = chartSource.filter((c) => c.time >= fromTime && c.time < toTime);

  return {
    pair: pair.symbol,
    htfTimeframe: strategyManager.getRequiredHtfCandles().timeframe,
    mtfTimeframe: strategyManager.getRequiredMtfCandles().timeframe,
    fromTime,
    toTime,
    htfCandleCount: htfCandles.filter((c) => c.time >= fromTime && c.time < toTime).length,
    mtfCandleCount: mtfCandles.filter((c) => c.time >= fromTime && c.time < toTime).length,
    sampleCount: samples.length,
    changes,
    segments: segmentsFromChanges(changes, windowEnd),
    samples,
    chartCandles: chartCandles.length > 0 ? chartCandles : chartSource,
  };
}

function uniqueTimes(htfCandles: Candle[], mtfCandles: Candle[]): number[] {
  const set = new Set<number>();
  for (const c of htfCandles) set.add(c.time);
  for (const c of mtfCandles) set.add(c.time);
  return [...set].sort((a, b) => a - b);
}

function priceByTime(htfCandles: Candle[], mtfCandles: Candle[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const c of htfCandles) map.set(c.time, c.close);
  for (const c of mtfCandles) map.set(c.time, c.close);
  return map;
}

export function segmentsFromChanges(changes: RegimeChange[], endTime: number): RegimeSegment[] {
  const segments: RegimeSegment[] = [];
  for (let i = 0; i < changes.length; i++) {
    const cur = changes[i]!;
    const next = changes[i + 1];
    const fromTime = Math.floor(cur.at.getTime() / 1000);
    const toTime = next !== undefined ? Math.floor(next.at.getTime() / 1000) : endTime;
    segments.push({
      trend: cur.market.trend,
      volatility: cur.market.volatility,
      fromTime,
      toTime,
      samples: 1,
    });
  }
  return segments;
}

/** Parse CLI flags for `regime`. */
export function parseRegimeArgs(argv: string[]): RegimeCliOptions {
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
      throw new Error(`Unknown regime option: ${arg}`);
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

  const result: RegimeCliOptions = {
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

export async function printRegimeReport(result: RegimeResult): Promise<void> {
  console.log("");
  console.log(
    `=== Regime ${result.pair} | HTF ${result.htfTimeframe} trend + ${result.mtfTimeframe} vol ===`,
  );
  console.log(
    `Window: ${new Date(result.fromTime * 1000).toISOString()} → ${new Date(result.toTime * 1000).toISOString()}`,
  );
  console.log(
    `Bars in window: ${result.htfCandleCount} ${result.htfTimeframe} + ${result.mtfCandleCount} ${result.mtfTimeframe}` +
      ` | evaluations: ${result.sampleCount} | switches: ${result.changes.length}`,
  );

  if (result.changes.length === 0) {
    console.log("No market-indicator samples in this window.");
  } else {
    console.log("Market indicator changes:");
    for (const change of result.changes) {
      const from =
        change.previous !== undefined
          ? `${change.previous.trend}/${change.previous.volatility}`
          : "—";
      const to = `${change.market.trend}/${change.market.volatility}`;
      const htf = change.market.htf;
      const mtf = change.market.mtf;
      const adx = htf?.adx != null ? ` adx=${htf.adx.toFixed(1)}` : "";
      const atrPct = mtf?.atrPct != null ? ` atrPct=${(mtf.atrPct * 100).toFixed(2)}%` : "";
      console.log(
        `  ${change.at.toISOString()} ${from} → ${to} @ ${change.price.toFixed(6)}` +
          `${adx}${atrPct} | ${change.strategyName} | risk ${change.riskName}`,
      );
    }

    console.log("Time in regime:");
    const totals = new Map<string, number>();
    let span = 0;
    for (const seg of result.segments) {
      const dur = Math.max(0, seg.toTime - seg.fromTime);
      span += dur;
      const key = `${seg.trend}/${seg.volatility}`;
      totals.set(key, (totals.get(key) ?? 0) + dur);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    for (const [key, dur] of ranked) {
      const pct = span > 0 ? ((dur / span) * 100).toFixed(1) : "0.0";
      console.log(`  ${key.padEnd(18)} ${formatDuration(dur)} (${pct}%)`);
    }
  }

  if (result.chartCandles.length > 0) {
    const events = result.changes.map(chartEventForChange);
    console.log("");
    console.log(
      await renderConsoleChart({
        pair: result.pair,
        candles: result.chartCandles,
        events,
        regimeBands: result.samples,
        title: `${result.pair} regime (${result.mtfCandleCount > 0 ? result.mtfTimeframe : result.htfTimeframe})`,
        color: Boolean(process.stdout.isTTY),
      }),
    );
  }
}

function chartEventForChange(change: RegimeChange): ChartEvent {
  if (change.previous?.trend !== change.market.trend) {
    return {
      at: change.at,
      label: trendLabel(change.market.trend),
      color: trendColor(change.market.trend),
    };
  }
  return {
    at: change.at,
    label: volLabel(change.market.volatility),
    color: volColor(change.market.volatility),
  };
}

function formatDuration(seconds: number): string {
  const hours = seconds / 3600;
  if (hours < 48) {
    return `${hours.toFixed(1)}h`;
  }
  return `${(hours / 24).toFixed(1)}d`;
}
