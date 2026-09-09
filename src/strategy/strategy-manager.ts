import { match } from "ts-pattern";
import {
  evaluateMarketIndicators,
  htfParamsFor,
  mtfParamsFor,
  type HtfParams,
  type MtfParams,
} from "../market/htf.js";
import { GenericRiskManager, HighRiskManager } from "../risk/risk-manager.js";
import type {
  Candle,
  HtfTimeframe,
  MarketIndicators,
  RequiredCandles,
  RiskManager,
  Strategy,
  StrategyManager,
  StrategyMode,
  Trend,
  Volatility,
} from "../types.js";
import { BollingerStrategy } from "./mode/bollinger.js";
import { DonchianStrategy } from "./mode/donchian.js";
import { GridStrategy } from "./mode/grid.js";

export {
  classifyHighLow,
  confirmLabel,
  confirmTrend,
  evaluateMarketIndicators,
  htfParamsFor,
  mtfParamsFor,
  type HtfParams,
  type MtfParams,
} from "../market/htf.js";

export interface SimpleStrategyManagerOptions {
  strategyMode: StrategyMode;
  htf: HtfTimeframe;
}

/**
 * Active strategy is env/CLI. Grid, Bollinger, and Donchian params (and ATR
 * trail) follow HTF trend × 1h volatility; Generic vs High risk still follows
 * trend only.
 */
export class SimpleStrategyManager implements StrategyManager {
  private readonly params: HtfParams;
  private readonly mtfParams: MtfParams;
  private readonly strategyMode: StrategyMode;
  private strategy: Strategy;
  private riskManager: RiskManager;

  constructor(options: SimpleStrategyManagerOptions) {
    this.strategyMode = options.strategyMode;
    this.strategy = loadStrategy(options.strategyMode, "flat", "low");
    this.riskManager = new GenericRiskManager(this.strategy.getRiskParams());
    this.params = htfParamsFor(options.htf);
    this.mtfParams = mtfParamsFor();
  }

  getActiveStrategy(): Strategy {
    return this.strategy;
  }

  getActiveRiskManager(): RiskManager {
    return this.riskManager;
  }

  getRequiredHtfCandles(): RequiredCandles {
    const { timeframe, emaSlow, atrPeriod, adxPeriod } = this.params;
    const warm = Math.max(emaSlow, atrPeriod, adxPeriod * 2) + 20;
    return { timeframe, count: Math.max(warm, 220) };
  }

  getRequiredMtfCandles(): RequiredCandles {
    const { timeframe, atrPctLookback, kcPeriod, bbPeriod } = this.mtfParams;
    const warm = Math.max(atrPctLookback + kcPeriod, bbPeriod) + 20;
    return { timeframe, count: Math.max(warm, 120) };
  }

  evaluate(
    pair: string,
    htfCandles: Candle[],
    mtfCandles: Candle[],
    price: number,
    at: Date,
  ): MarketIndicators {
    return evaluateMarketIndicators({
      pair,
      candles: htfCandles,
      mtfCandles,
      price,
      at,
      params: this.params,
      mtfParams: this.mtfParams,
    });
  }

  applyMarketIndicators(
    indicators: MarketIndicators,
    lastMarketIndicators?: MarketIndicators,
  ): boolean {
    this.strategy = loadStrategy(this.strategyMode, indicators.trend, indicators.volatility);
    this.riskManager = createRiskManager(indicators.trend, this.strategy);
    return (
      lastMarketIndicators?.trend !== indicators.trend ||
      lastMarketIndicators?.volatility !== indicators.volatility
    );
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

/**
 * Create a strategy for `mode` tuned for HTF `trend` and 1h `volatility`.
 * Grid spacing / ATR, Bollinger ADX–RSI gates, and Donchian volume SMA
 * multiplier scale with both.
 */
export function loadStrategy(mode: StrategyMode, trend: Trend, volatility: Volatility): Strategy {
  switch (mode) {
    case "bollinger":
      return new BollingerStrategy(trend, volatility);
    case "grid":
      return new GridStrategy(trend, volatility);
    case "donchian":
      return new DonchianStrategy(trend, volatility);
  }
}
