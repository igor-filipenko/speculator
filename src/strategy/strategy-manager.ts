import { GenericRiskManager, HighRiskManager } from "../risk/risk-manager.js";
import type {
  Candle,
  HtfTimeframe,
  MarketState,
  PoolStats,
  RequiredCandles,
  RiskManager,
  Strategy,
  StrategyManager,
  StrategyMode,
  Trend,
} from "../types.js";
import { BollingerStrategy } from "./mode/bollinger.js";
import { GridStrategy } from "./mode/grid.js";
import { adx, atr, ema } from "./indicators.js";
import { match } from "ts-pattern";

/** HTF indicator periods for {@link SimpleStrategyManager}. */
export interface HtfParams {
  timeframe: HtfTimeframe;
  emaSlow: number;
  emaFast: number;
  atrPeriod: number;
  adxPeriod: number;
  adxFlatMax: number;
}

export function htfParamsFor(timeframe: HtfTimeframe): HtfParams {
  return {
    timeframe,
    emaSlow: 200,
    emaFast: 50,
    atrPeriod: 14,
    adxPeriod: 14,
    adxFlatMax: 20,
  };
}

export interface EvaluateMarketStateInput {
  pair: string;
  candles: Candle[];
  price: number;
  at: Date;
  params: HtfParams;
  strategyMode: StrategyMode;
  poolStats?: PoolStats;
}

/**
 * Pure HTF regime from candles. Callers load OHLCV via {@link StrategyManager.getRequiredCandles}.
 *
 * TODO: Open Interest / OI-mcap would need a derivatives vendor; GeckoTerminal does not provide it.
 */
export function evaluateMarketState(input: EvaluateMarketStateInput): MarketState {
  const { pair, candles, price, at, params, strategyMode, poolStats } = input;
  const base: MarketState = {
    pair,
    timeframe: params.timeframe,
    at,
    price,
    trend: "unknown",
    strategyMode,
    candles,
  };
  if (poolStats?.marketCapUsd != null) {
    base.marketCapUsd = poolStats.marketCapUsd;
  }
  if (poolStats?.fdvUsd != null) {
    base.fdvUsd = poolStats.fdvUsd;
  }

  if (candles.length === 0) {
    return base;
  }

  const closes = candles.map((c) => c.close);
  const lastClose = candles[candles.length - 1]!.close;
  const ema200 = last(ema(closes, params.emaSlow));
  const ema50 = last(ema(closes, params.emaFast));
  const atrNow = last(atr(candles, params.atrPeriod));
  const adxNow = last(adx(candles, params.adxPeriod));

  const trend = classifyTrend(lastClose, ema200, adxNow, params.adxFlatMax);

  const state: MarketState = { ...base, trend };
  if (ema200 != null) {
    state.ema200 = ema200;
    if (price > 0 && ema200 > 0) {
      state.distEma200Pct = (price - ema200) / ema200;
    }
  }
  if (ema50 != null) {
    state.ema50 = ema50;
  }
  if (adxNow != null) {
    state.adx = adxNow;
  }
  if (atrNow != null) {
    state.atr = atrNow;
    if (price > 0) {
      state.atrPct = atrNow / price;
    }
  }
  return state;
}

function classifyTrend(
  close: number,
  ema200: number | undefined,
  adxNow: number | undefined,
  adxFlatMax: number,
): Trend {
  if (ema200 == null) {
    return "unknown";
  }
  if (adxNow == null || adxNow < adxFlatMax) {
    return "flat";
  }
  if (close > ema200) {
    return "bullish";
  }
  if (close < ema200) {
    return "bearish";
  }
  return "flat";
}

function last(series: (number | null)[]): number | undefined {
  const value = series[series.length - 1];
  return value ?? undefined;
}

export interface SimpleStrategyManagerOptions {
  strategyMode: StrategyMode;
  htf: HtfTimeframe;
}

/**
 * Active strategy is env/CLI. Risk manager follows HTF {@link MarketState.trend}:
 * bullish → {@link GenericRiskManager}, otherwise {@link HighRiskManager}.
 */
export class SimpleStrategyManager implements StrategyManager {
  private readonly params: HtfParams;
  private readonly strategy: Strategy;
  private riskManager: RiskManager;

  constructor(options: SimpleStrategyManagerOptions) {
    this.strategy = loadStrategy(options.strategyMode);
    this.riskManager = new GenericRiskManager(this.strategy.getRiskParams());
    this.params = htfParamsFor(options.htf);
  }

  getActiveStrategy(): Strategy {
    return this.strategy;
  }

  getActiveRiskManager(): RiskManager {
    return this.riskManager;
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, emaSlow, atrPeriod, adxPeriod } = this.params;
    const warm = Math.max(emaSlow, atrPeriod, adxPeriod * 2) + 20;
    return { timeframe, count: Math.max(warm, 220) };
  }

  evaluate(
    pair: string,
    candles: Candle[],
    price: number,
    at: Date,
    poolStats?: PoolStats,
  ): MarketState {
    return evaluateMarketState({
      pair,
      candles,
      price,
      at,
      params: this.params,
      strategyMode: this.strategy.getMode(),
      ...(poolStats !== undefined ? { poolStats } : {}),
    });
  }

  applyMarketState(state: MarketState, lastMarketState?: MarketState): boolean {
    this.riskManager = createRiskManager(state.trend, this.strategy);
    const changed = lastMarketState?.trend !== state.trend;
    if (changed) {
      if (lastMarketState === undefined) {
        console.log(`[${state.pair}] trend is ${state.trend}`);
      } else {
        console.log(
          `[${state.pair}] trend changed from ${lastMarketState.trend} to ${state.trend}`,
        );
      }
    }
    return changed;
  }
}

export function createRiskManager(trend: Trend, strategy: Strategy): RiskManager {
  return match(trend)
    .with("bullish", () => new GenericRiskManager(strategy.getRiskParams()))
    .with("flat", () => new GenericRiskManager(strategy.getRiskParams()))
    .with("bearish", () => new HighRiskManager("trend is bearish", strategy.getRiskParams()))
    .with("unknown", () => new HighRiskManager("trend is unknown", strategy.getRiskParams()))
    .exhaustive();
}

export function loadStrategy(mode: StrategyMode): Strategy {
  switch (mode) {
    case "bollinger":
      return new BollingerStrategy();
    case "grid":
      return new GridStrategy();
  }
}
