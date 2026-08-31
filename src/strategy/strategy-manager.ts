import { match } from "ts-pattern";
import { evaluateMarketIndicators, htfParamsFor, type HtfParams } from "../market/htf.js";
import { GenericRiskManager, HighRiskManager } from "../risk/risk-manager.js";
import type {
  Candle,
  HtfTimeframe,
  MarketIndicators,
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

export { evaluateMarketIndicators, htfParamsFor, type HtfParams } from "../market/htf.js";

export interface SimpleStrategyManagerOptions {
  strategyMode: StrategyMode;
  htf: HtfTimeframe;
}

/**
 * Active strategy is env/CLI. Both strategy AND risk manager are recreated on trend change:
 * - Grid: bull trend → {@link gridBullParamsFor} (wide TP + trail) + {@link GenericRiskManager}
 * - Grid: flat/bear/unknown → {@link gridParamsFor} (standard params) + appropriate manager
 * - Bollinger: same params for all trends; only risk manager switches
 */
export class SimpleStrategyManager implements StrategyManager {
  private readonly params: HtfParams;
  private readonly strategyMode: StrategyMode;
  private strategy: Strategy;
  private riskManager: RiskManager;

  constructor(options: SimpleStrategyManagerOptions) {
    this.strategyMode = options.strategyMode;
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
  ): MarketIndicators {
    return evaluateMarketIndicators({
      pair,
      candles,
      price,
      at,
      params: this.params,
      ...(poolStats !== undefined ? { poolStats } : {}),
    });
  }

  applyMarketIndicators(
    indicators: MarketIndicators,
    lastMarketIndicators?: MarketIndicators,
  ): boolean {
    // Recreate strategy with trend-appropriate params (e.g. wider TP in bull mode for Grid).
    // Bollinger returns the same params for every trend.
    this.strategy = loadStrategy(this.strategyMode, indicators.trend);
    this.riskManager = createRiskManager(indicators.trend, this.strategy);
    return lastMarketIndicators?.trend !== indicators.trend;
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
 * Create a strategy for `mode` tuned for `trend`.
 * Grid uses bull-optimised params (wide TP + trail) when `trend === "bullish"`.
 * Bollinger and all other modes return the same strategy regardless of trend.
 */
export function loadStrategy(mode: StrategyMode, trend: Trend = "flat"): Strategy {
  switch (mode) {
    case "bollinger":
      return new BollingerStrategy();
    case "grid":
      return new GridStrategy(trend);
  }
}
