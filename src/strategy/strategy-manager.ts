import { match } from "ts-pattern";
import { getStrategy, listStrategies, type RegisteredStrategy } from "../db/strategies.js";
import {
  evaluateMarketIndicators,
  htfParamsFor,
  mtfParamsFor,
  type HtfParams,
  type MtfParams,
} from "../market/htf.js";
import { GenericRiskManager, HighRiskManager } from "./risk-manager.js";
import type {
  Candle,
  HtfTimeframe,
  MarketIndicators,
  RequiredCandles,
  RiskManager,
  Strategy,
  StrategyManager,
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
  /** `strategy.registry.id`. */
  strategyId: string;
  htf: HtfTimeframe;
}

/**
 * Active strategy id comes from env/CLI and must exist in `strategy.registry`.
 * Grid, Bollinger, and Donchian params (and ATR trail) follow HTF trend × 1h
 * volatility; Generic vs High risk still follows trend only.
 */
export class SimpleStrategyManager implements StrategyManager {
  private readonly params: HtfParams;
  private readonly mtfParams: MtfParams;
  private readonly strategyId: string;
  private strategy: Strategy;
  private riskManager: RiskManager;

  private constructor(options: SimpleStrategyManagerOptions, strategy: Strategy) {
    this.strategyId = options.strategyId;
    this.strategy = strategy;
    this.riskManager = new GenericRiskManager(strategy.getRiskParams());
    this.params = htfParamsFor(options.htf);
    this.mtfParams = mtfParamsFor();
  }

  static async create(options: SimpleStrategyManagerOptions): Promise<SimpleStrategyManager> {
    const strategy = await loadStrategy(options.strategyId, "flat", "low");
    return new SimpleStrategyManager(options, strategy);
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

  async applyMarketIndicators(
    indicators: MarketIndicators,
    lastMarketIndicators?: MarketIndicators,
  ): Promise<boolean> {
    this.strategy = await loadStrategy(this.strategyId, indicators.trend, indicators.volatility);
    this.riskManager = createRiskManager(indicators.trend, this.strategy);
    return (
      lastMarketIndicators?.trend !== indicators.trend ||
      lastMarketIndicators?.volatility !== indicators.volatility
    );
  }
}

export function createRiskManager(trend: Trend, strategy: Strategy): RiskManager {
  const risk = strategy.getRiskParams();
  return match(trend)
    .with("bearish", () => new HighRiskManager("trend is bearish", risk, true))
    .with("unknown", () => new HighRiskManager("trend is unknown", risk, false))
    .with("bullish", () => new GenericRiskManager(risk, { allowLong: true, allowShort: false }))
    .with("flat", () => new GenericRiskManager(risk, { allowLong: true, allowShort: true }))
    .exhaustive();
}

type StrategyFactory = (trend: Trend, volatility: Volatility) => Strategy;

/** Implementations keyed by `strategy.registry.id`. */
const strategyFactories = new Map<string, StrategyFactory>([
  ["bollinger", (trend, volatility) => new BollingerStrategy(trend, volatility)],
  ["donchian", (trend, volatility) => new DonchianStrategy(trend, volatility)],
  ["grid", (trend, volatility) => new GridStrategy(trend, volatility)],
]);

const registeredById = new Map<string, RegisteredStrategy>();

/**
 * Load `id` from `strategy.registry` and build the implementation tuned for HTF
 * `trend` and 1h `volatility`. The registry row is cached for the process.
 * Grid spacing / ATR, Bollinger ADX–RSI gates (no long in bear or 1h high vol;
 * short entries only in bear/flat), and Donchian volume SMA multiplier scale with both.
 */
export async function loadStrategy(
  id: string,
  trend: Trend,
  volatility: Volatility,
): Promise<Strategy> {
  const registered = await registeredStrategy(id);
  const create = strategyFactories.get(registered.id);
  if (create === undefined) {
    throw new Error(
      `Strategy "${registered.id}" (${registered.name}) is registered but has no implementation`,
    );
  }
  return create(trend, volatility);
}

async function registeredStrategy(id: string): Promise<RegisteredStrategy> {
  const key = id.trim();
  const cached = registeredById.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const row = await getStrategy(key);
  if (row == null) {
    const known = (await listStrategies()).map((strategy) => strategy.id);
    const suffix = known.length > 0 ? known.join(", ") : "none";
    throw new Error(`Unknown strategy "${key}". Known: ${suffix}`);
  }
  registeredById.set(row.id, row);
  return row;
}
