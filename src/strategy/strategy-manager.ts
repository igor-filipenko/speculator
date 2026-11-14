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
const strategyModules = new Map<string, Pick<StrategyModule, "create" | "defaults">>();

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
  if (!("id" in mod) || !("create" in mod) || !("defaults" in mod)) return undefined;
  const id: unknown = mod.id;
  const create: unknown = mod.create;
  const defaults: unknown = mod.defaults;
  if (typeof id !== "string" || id.trim() === "" || typeof create !== "function") return undefined;
  if (typeof defaults !== "function") return undefined;
  return {
    id,
    create: create as StrategyModule["create"],
    defaults: defaults as StrategyModule["defaults"],
  };
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
    if (strategyModules.has(mod.id)) {
      throw new Error(`strategy id "${mod.id}" is exported by more than one package`);
    }
    strategyModules.set(mod.id, {
      create: (patch) => mod.create(patch),
      defaults: () => mod.defaults(),
    });
  }
}

/** Registry ids that have a `strategyModule` in this process. */
export async function listImplementedStrategyIds(): Promise<string[]> {
  await ensureStrategyModules();
  return [...strategyModules.keys()].sort();
}

const registeredById = new Map<string, RegisteredStrategy>();

/**
 * Load `id` from `strategy.registry` and build the `strategyModule`.
 * The registry row is cached for the process.
 */
export async function loadStrategy(id: string, patch?: StrategyParamPatch): Promise<Strategy> {
  const registered = await registeredStrategy(id);
  await ensureStrategyModules();
  const create = strategyModules.get(registered.id)?.create;
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

export type StrategyParamValue = string | number | boolean;

/** Knob object copied onto `strategy.instances.params` when an instance is added. */
export async function defaultStrategyParams(
  registryId: string,
): Promise<Record<string, StrategyParamValue>> {
  const registered = await registeredStrategy(registryId);
  await ensureStrategyModules();
  const defaults = strategyModules.get(registered.id)?.defaults;
  if (defaults === undefined) {
    throw new Error(
      `Strategy "${registered.id}" (${registered.name}) is registered but has no implementation`,
    );
  }
  return paramRecord(defaults());
}

/** Stored instance JSON over the module defaults. A key the module does not have is an error. */
export function overlayStrategyParams(
  defaults: Readonly<Record<string, StrategyParamValue>>,
  stored: unknown,
): Record<string, StrategyParamValue> {
  const next: Record<string, StrategyParamValue> = { ...defaults };
  for (const [key, value] of Object.entries(readParamObject(stored))) {
    const example = defaults[key];
    if (example === undefined) {
      throw new Error(`unknown strategy param "${key}"`);
    }
    next[key] = coerceStrategyParam(example, value);
  }
  return next;
}

/** Merge `key=value` strings into stored params. Unknown keys are an error. */
export function applyStrategyParamPatch(
  defaults: Readonly<Record<string, StrategyParamValue>>,
  stored: unknown,
  patch: Readonly<Record<string, string>>,
): Record<string, StrategyParamValue> {
  const next = overlayStrategyParams(defaults, stored);
  for (const [key, value] of Object.entries(patch)) {
    const example = defaults[key];
    if (example === undefined) {
      throw new Error(`unknown strategy param "${key}"`);
    }
    next[key] = coerceStrategyParam(example, value);
  }
  return next;
}

function readParamObject(stored: unknown): Record<string, unknown> {
  if (stored == null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error("strategy params must be an object");
  }
  return stored as Record<string, unknown>;
}

function paramRecord(value: object): Record<string, StrategyParamValue> {
  const out: Record<string, StrategyParamValue> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      throw new Error(`strategy param "${key}" must be a string, number, or boolean`);
    }
    out[key] = raw;
  }
  return out;
}

function coerceStrategyParam(example: StrategyParamValue, value: unknown): StrategyParamValue {
  if (typeof example === "number") {
    if (typeof value === "boolean") {
      throw new Error(`strategy param expected a number, got ${String(value)}`);
    }
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value.trim())
          : Number.NaN;
    if (!Number.isFinite(parsed)) {
      throw new Error(`strategy param expected a number, got ${JSON.stringify(value)}`);
    }
    return parsed;
  }
  if (typeof example === "boolean") {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    throw new Error(`strategy param expected true or false, got ${JSON.stringify(value)}`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`strategy param expected a string, got ${JSON.stringify(value)}`);
  }
  return value.trim();
}
