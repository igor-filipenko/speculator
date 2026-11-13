import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getStrategy, listStrategies, type RegisteredStrategy } from "../db/strategies.js";
import { GenericRiskManager } from "./risk-manager.js";
import type {
  RiskManager,
  Strategy,
  StrategyManager,
  StrategyModule,
  StrategyParamPatch,
} from "../types.js";

export type { StrategyParamPatch };

export interface SimpleStrategyManagerOptions {
  /** `strategy.registry.id`. */
  strategyId: string;
  /** Merged onto the module defaults. Omitted fields stay on those defaults. */
  paramPatch?: StrategyParamPatch;
}

/**
 * Active strategy id comes from env/CLI and must exist in `strategy.registry`.
 * The risk manager is the hard stop and max deposit.
 */
export class SimpleStrategyManager implements StrategyManager {
  private readonly strategy: Strategy;
  private readonly riskManager: RiskManager;

  private constructor(strategy: Strategy) {
    this.strategy = strategy;
    this.riskManager = new GenericRiskManager();
  }

  static async create(options: SimpleStrategyManagerOptions): Promise<SimpleStrategyManager> {
    const strategy = await loadStrategy(options.strategyId, options.paramPatch);
    return new SimpleStrategyManager(strategy);
  }

  getActiveStrategy(): Strategy {
    return this.strategy;
  }

  getActiveRiskManager(): RiskManager {
    return this.riskManager;
  }
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
    strategyFactories.set(mod.id, (patch) => mod.create(patch));
  }
}

/** Registry ids that have a `strategyModule` in this process. */
export async function listImplementedStrategyIds(): Promise<string[]> {
  await ensureStrategyModules();
  return [...strategyFactories.keys()].sort();
}

const registeredById = new Map<string, RegisteredStrategy>();

/**
 * Load `id` from `strategy.registry` and build the `strategyModule`.
 * The registry row is cached for the process.
 */
export async function loadStrategy(id: string, patch?: StrategyParamPatch): Promise<Strategy> {
  const registered = await registeredStrategy(id);
  await ensureStrategyModules();
  const create = strategyFactories.get(registered.id);
  if (create === undefined) {
    throw new Error(
      `Strategy "${registered.id}" (${registered.name}) is registered but has no implementation`,
    );
  }
  const strategy = create(patch);
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
