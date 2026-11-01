import { getStrategy, listStrategies, type RegisteredStrategy } from "../db/strategies.js";
import {
  evaluateMarketIndicators,
  htfParamsFor,
  mtfParamsFor,
  type HtfParams,
  type MtfParams,
} from "../market/htf.js";
import { GenericRiskManager } from "./risk-manager.js";
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
import { BollingerStrategy, bollingerParamsFor, type BollingerParams } from "./mode/bollinger.js";
import { DonchianStrategy, donchianParamsFor, type DonchianParams } from "./mode/donchian.js";

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

/** Numeric overrides merged onto `*ParamsFor(trend, volatility)` on every reload. */
export interface StrategyParamPatch {
  bollinger?: Partial<BollingerParams>;
  donchian?: Partial<DonchianParams>;
}

export interface SimpleStrategyManagerOptions {
  /** `strategy.registry.id`. */
  strategyId: string;
  htf: HtfTimeframe;
  /** Kept across regime reloads. Omitted fields stay on the regime defaults. */
  paramPatch?: StrategyParamPatch;
}

/**
 * Active strategy id comes from env/CLI and must exist in `strategy.registry`.
 * Bollinger and Donchian params follow HTF trend × 1h volatility.
 * The risk manager is the same in every regime: hard stop and max deposit.
 */
export class SimpleStrategyManager implements StrategyManager {
  private readonly params: HtfParams;
  private readonly mtfParams: MtfParams;
  private readonly strategyId: string;
  private readonly paramPatch: StrategyParamPatch | undefined;
  private strategy: Strategy;
  private riskManager: RiskManager;

  private constructor(options: SimpleStrategyManagerOptions, strategy: Strategy) {
    this.strategyId = options.strategyId;
    this.paramPatch = options.paramPatch;
    this.strategy = strategy;
    this.riskManager = new GenericRiskManager();
    this.params = htfParamsFor(options.htf);
    this.mtfParams = mtfParamsFor();
  }

  static async create(options: SimpleStrategyManagerOptions): Promise<SimpleStrategyManager> {
    const strategy = await loadStrategy(options.strategyId, "flat", "low", options.paramPatch);
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
    this.strategy = await loadStrategy(
      this.strategyId,
      indicators.trend,
      indicators.volatility,
      this.paramPatch,
    );
    this.riskManager = createRiskManager(indicators.trend, this.strategy);
    return (
      lastMarketIndicators?.trend !== indicators.trend ||
      lastMarketIndicators?.volatility !== indicators.volatility
    );
  }
}

export function createRiskManager(_trend: Trend, _strategy: Strategy): RiskManager {
  return new GenericRiskManager();
}

type StrategyFactory = (
  trend: Trend,
  volatility: Volatility,
  patch?: StrategyParamPatch,
) => Strategy;

/** Implementations keyed by `strategy.registry.id`. */
const strategyFactories = new Map<string, StrategyFactory>([
  [
    "bollinger",
    (trend, volatility, patch) =>
      new BollingerStrategy(trend, volatility, mergeParams(bollingerParamsFor(), patch?.bollinger)),
  ],
  [
    "donchian",
    (trend, volatility, patch) =>
      new DonchianStrategy(
        trend,
        volatility,
        mergeParams(donchianParamsFor(trend, volatility), patch?.donchian),
      ),
  ],
]);

const registeredById = new Map<string, RegisteredStrategy>();

/**
 * Load `id` from `strategy.registry` and build the implementation tuned for HTF
 * `trend` and 1h `volatility`. The registry row is cached for the process.
 * Bollinger entries are a closed-bar band touch. A long is blocked when −DI
 * leads +DI, and a short when +DI leads −DI. Donchian volume SMA multiplier
 * scales with both.
 */
export async function loadStrategy(
  id: string,
  trend: Trend,
  volatility: Volatility,
  patch?: StrategyParamPatch,
): Promise<Strategy> {
  const registered = await registeredStrategy(id);
  const create = strategyFactories.get(registered.id);
  if (create === undefined) {
    throw new Error(
      `Strategy "${registered.id}" (${registered.name}) is registered but has no implementation`,
    );
  }
  return create(trend, volatility, patch);
}

function mergeParams<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (patch === undefined) {
    return base;
  }
  const merged = { ...base };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
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
