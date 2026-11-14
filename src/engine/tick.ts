import { getBotId, query } from "../db/db.js";
import { resolvePair } from "../config.js";
import {
  defaultStrategyParams,
  loadStrategy,
  overlayStrategyParams,
  type StrategyParamValue,
} from "../strategy/strategy-manager.js";
import type {
  Candle,
  CandleSource,
  Exchange,
  Order,
  PairConfig,
  PerpsFees,
  Portfolio,
  PositionData,
  RiskManager,
  Signal,
  Strategy,
  StrategyParamPatch,
  Timeframe,
  Trade,
} from "../types.js";
import { isOrder } from "../types.js";

const TIMEFRAMES = new Set<string>(["1m", "5m", "15m", "1h", "4h", "1d"]);
const FETCHABLE = new Set<string>(["gecko-terminal", "binance", "birdeye"]);

/** One assigned strategy this process can decide and book. */
export interface TradingInstance {
  id: string;
  registryId: string;
  pair: PairConfig;
  candleSource: CandleSource;
  exchangeId: string;
  riskPercent: number;
  depositUsdc: number;
  /** Stored knobs over the module defaults. */
  params: Record<string, StrategyParamValue>;
  strategy: Strategy;
}

export type TickBook =
  | { kind: "signal" }
  | { kind: "risk"; reason: string }
  | { kind: "hold" }
  | { kind: "position-data"; data: PositionData }
  | { kind: "filled"; trade: Trade; order: Order; protective: boolean }
  | { kind: "sol"; order: Order }
  | { kind: "rejected"; message: string };

export interface InstanceTickArgs {
  strategy: Strategy;
  riskManager: RiskManager;
  exchange: Exchange;
  pair: PairConfig;
  candles: Candle[];
  price: number;
  at: Date;
  perpsFees?: PerpsFees;
  /** Absent in watch: the tick decides and does not book. */
  portfolio?: Portfolio;
  /** Backtest points the emulated mid at the fill before the order is built. */
  prepareFill?: (priceHint: number) => void;
}

/** Decide one instance, then book its own order. Netting across instances is later. */
export async function runInstanceTick(
  args: InstanceTickArgs,
): Promise<{ signal: Signal; book: TickBook }> {
  const { strategy, pair, candles, price, at, portfolio } = args;
  const signal = strategy.evaluateSignal(
    pair.symbol,
    candles,
    price,
    at,
    portfolio?.getSnapshot(price),
    args.perpsFees,
  );
  if (portfolio === undefined) {
    return { signal, book: { kind: "signal" } };
  }

  const result = args.riskManager.check(signal, portfolio.getSnapshot(price), candles);
  if (result.kind === "risk") {
    return { signal, book: { kind: "risk", reason: result.risk.reason } };
  }
  if (result.kind === "no-command") {
    return { signal, book: { kind: "hold" } };
  }
  if (result.kind === "position-data") {
    await portfolio.applyPositionData(result.data);
    return { signal, book: { kind: "position-data", data: result.data } };
  }

  args.prepareFill?.(result.command.priceHint);
  const order = await args.exchange.execute(result.command, pair);
  if (!isOrder(order)) {
    return { signal, book: { kind: "rejected", message: order.message } };
  }
  if (order.intent === "buy-sol") {
    await portfolio.applyOrder(order);
    return { signal, book: { kind: "sol", order } };
  }
  const trade = await portfolio.applyOrder(order);
  if (trade == null) {
    return { signal, book: { kind: "rejected", message: "portfolio returned no trade" } };
  }
  return {
    signal,
    book: {
      kind: "filled",
      trade,
      order,
      protective: result.kind === "protective-command",
    },
  };
}

/** Instances assigned to this bot. Two on one pair must name the same exchange. */
export async function loadAssignedInstances(botId = getBotId()): Promise<TradingInstance[]> {
  const rows = await query<Record<string, unknown>>(
    `
    SELECT
      i.id::text AS id,
      i.registry_id,
      i.pair,
      i.candle_source,
      i.exchange_id,
      i.risk_percent,
      i.params,
      b.deposit_usdc
    FROM bot.strategies b
    JOIN strategy.instances i ON i.id = b.strategy_id
    WHERE b.bot_id = $1
    ORDER BY i.pair, i.id
    `,
    [botId],
  );
  const instances = await Promise.all(rows.map((row) => tradingInstance(row)));
  const exchangeByPair = new Map<string, string>();
  for (const instance of instances) {
    const previous = exchangeByPair.get(instance.pair.symbol);
    if (previous !== undefined && previous !== instance.exchangeId) {
      throw new Error(
        `${instance.pair.symbol} instances must use the same exchange (found ${previous} and ${instance.exchangeId})`,
      );
    }
    exchangeByPair.set(instance.pair.symbol, instance.exchangeId);
  }
  return instances;
}

/** The one instance `strategy use` stored. Backtest and tune run only this row. */
export async function loadSelectedInstance(botId = getBotId()): Promise<TradingInstance> {
  const rows = await query<Record<string, unknown>>(
    `
    SELECT
      i.id::text AS id,
      i.registry_id,
      i.pair,
      i.candle_source,
      i.exchange_id,
      i.risk_percent,
      i.params,
      b.deposit_usdc
    FROM bot.selection s
    JOIN strategy.instances i ON i.id = s.strategy_id
    JOIN bot.strategies b ON b.bot_id = s.bot_id AND b.strategy_id = s.strategy_id
    WHERE s.bot_id = $1
    `,
    [botId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no strategy selected for this bot; run strategy add or strategy use");
  }
  return tradingInstance(row);
}

export function paramsToPatch(params: Record<string, StrategyParamValue>): StrategyParamPatch {
  const patch: StrategyParamPatch = { values: params };
  const timeframe = params["timeframe"];
  if (typeof timeframe === "string" && TIMEFRAMES.has(timeframe)) {
    patch.timeframe = timeframe as Timeframe;
  }
  return patch;
}

async function tradingInstance(row: Record<string, unknown>): Promise<TradingInstance> {
  const registryId = text(row["registry_id"], "registry_id");
  const defaults = await defaultStrategyParams(registryId);
  const params = overlayStrategyParams(defaults, row["params"]);
  const strategy = await loadStrategy(registryId, paramsToPatch(params));
  const candleSource = text(row["candle_source"], "candle_source");
  if (!FETCHABLE.has(candleSource)) {
    throw new Error(`candle source "${candleSource}" is not fetched by this process`);
  }
  return {
    id: text(row["id"], "id"),
    registryId,
    pair: await resolvePair(text(row["pair"], "pair")),
    candleSource: candleSource as CandleSource,
    exchangeId: text(row["exchange_id"], "exchange_id"),
    riskPercent: Number(row["risk_percent"]),
    depositUsdc: Number(row["deposit_usdc"]),
    params,
    strategy,
  };
}

function text(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new Error(`expected ${field} on a strategy instance`);
}
