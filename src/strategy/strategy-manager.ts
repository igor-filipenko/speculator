import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
  StrategyModule,
  StrategyParamPatch,
  Trend,
  Volatility,
} from "../types.js";

export type { StrategyParamPatch };
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
  /** Kept across regime reloads. Omitted fields stay on the regime defaults. */
  paramPatch?: StrategyParamPatch;
}

/**
 * Active strategy id comes from env/CLI and must exist in `strategy.registry`.
 * The matching `strategyModule` builds params for HTF trend × 1h volatility.
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

/** Implementations keyed by `strategy.registry.id`, filled from `mode/<id>/index`. */
const strategyFactories = new Map<string, StrategyModule["create"]>();

let modulesReady: Promise<void> | undefined;

function moduleExtension(): ".ts" | ".js" {
  return import.meta.url.endsWith(".ts") ? ".ts" : ".js";
}

async function importSpecifier(specifier: string): Promise<unknown> {
  return (await import(specifier)) as unknown;
}

function readStrategyModule(value: unknown): StrategyModule | undefined {
  if (typeof value !== "object" || value === null || !("strategyModule" in value)) return undefined;
  const mod: unknown = value.strategyModule;
  if (typeof mod !== "object" || mod === null) return undefined;
  if (!("id" in mod) || !("create" in mod)) return undefined;
  const id: unknown = mod.id;
  const create: unknown = mod.create;
  if (typeof id !== "string" || id.trim() === "" || typeof create !== "function") return undefined;
  return { id, create: create as StrategyModule["create"] };
}

/**
 * Import every strategy package under `mode/<id>/`. `index` exports
 * `strategyModule`, and the directory name is that id.
 */
function ensureStrategyModules(): Promise<void> {
  modulesReady ??= loadStrategyModules().catch((error: unknown) => {
    modulesReady = undefined;
    throw error;
  });
  return modulesReady;
}

async function loadStrategyModules(): Promise<void> {
  const ext = moduleExtension();
  const dir = fileURLToPath(new URL("./mode/", import.meta.url));
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const loaded = await Promise.all(
    names.map(async (name) => ({
      name,
      imported: await importSpecifier(`./mode/${name}/index${ext}`),
    })),
  );
  for (const { name, imported } of loaded) {
    const mod = readStrategyModule(imported);
    if (mod === undefined) continue;
    if (mod.id !== name) {
      throw new Error(`strategy directory "${name}" exports id "${mod.id}"`);
    }
    if (strategyFactories.has(mod.id)) {
      throw new Error(`strategy id "${mod.id}" is exported by more than one package`);
    }
    strategyFactories.set(mod.id, (trend, volatility, patch) =>
      mod.create(trend, volatility, patch),
    );
  }
}

/** Registry ids that have a `strategyModule` in this process. */
export async function listImplementedStrategyIds(): Promise<string[]> {
  await ensureStrategyModules();
  return [...strategyFactories.keys()].sort();
}

const registeredById = new Map<string, RegisteredStrategy>();

/**
 * Load `id` from `strategy.registry` and build the `strategyModule` for HTF
 * `trend` and 1h `volatility`. The registry row is cached for the process.
 */
export async function loadStrategy(
  id: string,
  trend: Trend,
  volatility: Volatility,
  patch?: StrategyParamPatch,
): Promise<Strategy> {
  const registered = await registeredStrategy(id);
  await ensureStrategyModules();
  const create = strategyFactories.get(registered.id);
  if (create === undefined) {
    throw new Error(
      `Strategy "${registered.id}" (${registered.name}) is registered but has no implementation`,
    );
  }
  const strategy = create(trend, volatility, patch);
  if (strategy.getId() !== registered.id) {
    throw new Error(`Strategy file for "${registered.id}" built id "${strategy.getId()}"`);
  }
  return strategy;
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
