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
  Command,
  Exchange,
  Order,
  OrderIntent,
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
  /** In-memory venue size for backtest. Paper and live read `exchange.positions`. */
  ledger?: ExchangeLedger;
}

/** Signed venue size for one pair. Backtest keeps this in memory and does not write it. */
export interface ExchangeLedger {
  get(pair: string): number;
  set(pair: string, signed: number): void;
}

export interface InstanceDecision {
  signal: Signal;
  book?: TickBook;
  command?: Command;
  protective?: boolean;
}

/** One pair's decided orders, before the venue sees them. */
export interface PendingFill {
  command: Command;
  portfolio: Portfolio;
  protective: boolean;
  prepareFill?: (priceHint: number) => void;
}

export interface NetIntent {
  intent: OrderIntent;
  /** Signed base change. A long is positive. */
  signedBase: number;
}

const SIZE_DUST = 1e-9;

/** Long is positive, short is negative, flat is zero. */
export function signedPosition(side: string, size: number): number {
  if (side === "long") return size;
  if (side === "short") return -size;
  return 0;
}

/** Base this command adds to the net. Opens are estimated at `price`. */
export function commandSignedBase(command: Command, price: number): number {
  if (command.intent === "open-long") {
    return price > 0 ? (command.quoteBudgetUsdc ?? 0) / price : 0;
  }
  if (command.intent === "open-short") {
    return price > 0 ? -((command.quoteBudgetUsdc ?? 0) / price) : 0;
  }
  if (command.intent === "close-long") return -(command.baseSize ?? 0);
  if (command.intent === "close-short") return command.baseSize ?? 0;
  return 0;
}

/**
 * Quote a live delta spends. Closing a long or covering a short does not.
 * Crossing through flat spends only the new side.
 */
export function quoteToSpend(current: number, target: number, price: number): number {
  if (!(price > 0)) return Number.POSITIVE_INFINITY;
  let spend = 0;
  if (target > Math.max(current, 0)) spend += (target - Math.max(current, 0)) * price;
  if (target < Math.min(current, 0)) spend += (Math.min(current, 0) - target) * price;
  return spend;
}

/**
 * Slippage and fee residue stay inside dust. A real extra position does not.
 * The band is one percent of the larger size, and at least 0.0001 base.
 */
export function exchangeDrifted(chain: number, booked: number): boolean {
  const gap = Math.abs(chain - booked);
  const dust = Math.max(1e-4, Math.max(Math.abs(chain), Math.abs(booked)) * 0.01);
  return gap > dust;
}

/** Drop every new open when the wallet cannot pay the net, or the chain has drifted. Closes stay. */
export function keepNetIntents<T extends NetIntent>(
  items: readonly T[],
  currentExchange: number,
  price: number,
  freeQuoteUsdc: number | undefined,
  blockEntries: boolean,
): T[] {
  const target = currentExchange + items.reduce((sum, item) => sum + item.signedBase, 0);
  const covered =
    freeQuoteUsdc === undefined || quoteToSpend(currentExchange, target, price) <= freeQuoteUsdc;
  if (!blockEntries && covered) return [...items];
  return items.filter((item) => item.intent !== "open-long" && item.intent !== "open-short");
}

/** Decide one instance. A command is not sent to the venue yet. */
export async function decideInstance(args: InstanceTickArgs): Promise<InstanceDecision> {
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
  return {
    signal,
    command: result.command,
    protective: result.kind === "protective-command",
  };
}

/**
 * Decide one instance and, when it is the only order, fill it.
 * Several instances on one pair go through {@link settlePair} instead.
 */
export async function runInstanceTick(
  args: InstanceTickArgs,
): Promise<{ signal: Signal; book: TickBook }> {
  const decision = await decideInstance(args);
  if (decision.command === undefined || args.portfolio === undefined) {
    rememberLedger(args);
    return { signal: decision.signal, book: decision.book ?? { kind: "hold" } };
  }
  const book = await fillCommand(
    {
      exchange: args.exchange,
      pair: args.pair,
      portfolio: args.portfolio,
      ...(args.prepareFill !== undefined ? { prepareFill: args.prepareFill } : {}),
    },
    decision.command,
    decision.protective === true,
  );
  rememberLedger(args);
  return { signal: decision.signal, book };
}

export interface SettlePairArgs {
  pair: PairConfig;
  exchange: Exchange;
  price: number;
  pending: readonly PendingFill[];
  /** Signed size already on `exchange.positions` for this pair. */
  currentExchange: number;
  /** Omitted for paper and backtest, which do not gate on a wallet. */
  freeQuoteUsdc?: number;
  /** Live chain size disagrees with the exchange row, so new entries wait. */
  blockEntries?: boolean;
  /** Paper and backtest fills are simulated. A live venue order keeps its own flag. */
  simulated: boolean;
  perpsFees?: PerpsFees;
}

/**
 * One venue order for the pair, then each instance books at that fill price.
 * A single command is sent through unchanged so its stop and size stay put.
 */
export async function settlePair(args: SettlePairArgs): Promise<TickBook[]> {
  const sized = args.pending.map((item) => ({
    ...item,
    intent: item.command.intent,
    signedBase: commandSignedBase(item.command, args.price),
  }));
  const kept = new Set(
    keepNetIntents(
      sized,
      args.currentExchange,
      args.price,
      args.freeQuoteUsdc,
      args.blockEntries === true,
    ),
  );
  const dropReason = args.blockEntries
    ? "exchange position differs from the chain"
    : "wallet USDC cannot pay the net";

  if (kept.size === 1) {
    return Promise.all(
      sized.map(async (item) => {
        if (!kept.has(item)) return { kind: "risk" as const, reason: dropReason };
        if (item.command.intent === "buy-sol") return { kind: "hold" as const };
        return fillCommand(
          {
            exchange: args.exchange,
            pair: args.pair,
            portfolio: item.portfolio,
            ...(item.prepareFill !== undefined ? { prepareFill: item.prepareFill } : {}),
          },
          item.command,
          item.protective,
        );
      }),
    );
  }

  const delta = [...kept].reduce((sum, item) => sum + item.signedBase, 0);
  const moves = venueMoves(args.currentExchange, args.currentExchange + delta, args.price);
  const filled: Order[] = [];
  let failure: string | undefined;
  for (const move of moves) {
    const order = await args.exchange.execute(
      venueCommand(args.pair.symbol, args.price, new Date(), move),
      args.pair,
    );
    if (!isOrder(order)) {
      failure = order.message;
      break;
    }
    filled.push(order);
  }

  return Promise.all(
    sized.map(async (item) => {
      if (!kept.has(item)) return { kind: "risk" as const, reason: dropReason };
      if (item.command.intent === "buy-sol") return { kind: "hold" as const };
      const venue = filled.find((order) => order.intent === item.command.intent);
      if (failure !== undefined && venue === undefined) {
        return { kind: "rejected" as const, message: failure };
      }
      const price = venue?.price ?? filled[filled.length - 1]?.price ?? args.price;
      const simulated = venue?.simulated ?? args.simulated;
      const order = orderForCommand(item.command, price, simulated, args.perpsFees, venue);
      return bookOrder(item.portfolio, order, item.protective);
    }),
  );
}

function rememberLedger(args: InstanceTickArgs): void {
  if (args.ledger === undefined || args.portfolio === undefined) return;
  const position = args.portfolio.getSnapshot(args.price).position;
  args.ledger.set(args.pair.symbol, signedPosition(position.side, position.size));
}

async function fillCommand(
  args: {
    exchange: Exchange;
    pair: PairConfig;
    portfolio: Portfolio;
    prepareFill?: (priceHint: number) => void;
  },
  command: Command,
  protective: boolean,
): Promise<TickBook> {
  args.prepareFill?.(command.priceHint);
  const order = await args.exchange.execute(command, args.pair);
  if (!isOrder(order)) {
    return { kind: "rejected", message: order.message };
  }
  if (order.intent === "buy-sol") {
    await args.portfolio.applyOrder(order);
    return { kind: "sol", order };
  }
  return bookOrder(args.portfolio, order, protective);
}

async function bookOrder(
  portfolio: Portfolio,
  order: Order,
  protective: boolean,
): Promise<TickBook> {
  if (!(order.size > 0) || !(order.price > 0)) {
    return { kind: "rejected", message: "net fill has no size" };
  }
  const trade = await portfolio.applyOrder(order);
  if (trade == null) {
    return { kind: "rejected", message: "portfolio returned no trade" };
  }
  return { kind: "filled", trade, order, protective };
}

interface VenueMove {
  intent: "open-long" | "close-long" | "open-short" | "close-short";
  quoteBudgetUsdc?: number;
  baseSize?: number;
}

/** Orders that move the venue from `current` to `target`. A sign change is two orders. */
function venueMoves(current: number, target: number, price: number): VenueMove[] {
  if (Math.abs(target - current) <= SIZE_DUST) return [];
  if (current >= -SIZE_DUST && target >= -SIZE_DUST) {
    if (target > current) {
      return [{ intent: "open-long", quoteBudgetUsdc: (target - current) * price }];
    }
    return [{ intent: "close-long", baseSize: current - target }];
  }
  if (current <= SIZE_DUST && target <= SIZE_DUST) {
    if (target < current) {
      return [{ intent: "open-short", quoteBudgetUsdc: (current - target) * price }];
    }
    return [{ intent: "close-short", baseSize: target - current }];
  }
  const moves: VenueMove[] = [];
  if (current > SIZE_DUST) moves.push({ intent: "close-long", baseSize: current });
  if (current < -SIZE_DUST) moves.push({ intent: "close-short", baseSize: -current });
  if (target > SIZE_DUST) moves.push({ intent: "open-long", quoteBudgetUsdc: target * price });
  if (target < -SIZE_DUST) {
    moves.push({ intent: "open-short", quoteBudgetUsdc: -target * price });
  }
  return moves;
}

function venueCommand(pair: string, price: number, at: Date, move: VenueMove): Command {
  const command: Command = {
    pair,
    intent: move.intent,
    orderType: "market",
    reason: "net",
    at,
    priceHint: price,
  };
  if (move.quoteBudgetUsdc !== undefined) command.quoteBudgetUsdc = move.quoteBudgetUsdc;
  if (move.baseSize !== undefined) command.baseSize = move.baseSize;
  return command;
}

function orderForCommand(
  command: Command,
  fillPrice: number,
  simulated: boolean,
  perpsFees: PerpsFees | undefined,
  venue: Order | undefined,
): Order {
  const opens = command.intent === "open-long" || command.intent === "open-short";
  const size = opens ? (command.quoteBudgetUsdc ?? 0) / fillPrice : (command.baseSize ?? 0);
  const order: Order = {
    pair: command.pair,
    type: "market",
    intent: command.intent,
    price: fillPrice,
    size,
    at: command.at,
    simulated,
    reason: command.reason,
    priorityFeeUsdc: 0,
  };
  if (venue?.txSignature !== undefined) order.txSignature = venue.txSignature;
  const strategyId = command.signal?.strategyId;
  if (strategyId !== undefined) order.strategyId = strategyId;
  if (command.slPrice !== undefined) order.slPrice = command.slPrice;
  const costs = venue?.fillCosts ?? shortCosts(command.intent, fillPrice, perpsFees);
  if (costs !== undefined) order.fillCosts = costs;
  return order;
}

function shortCosts(
  intent: OrderIntent,
  price: number,
  perpsFees: PerpsFees | undefined,
): Order["fillCosts"] | undefined {
  if (perpsFees === undefined || (intent !== "open-short" && intent !== "close-short")) {
    return undefined;
  }
  return { mid: price, slippageUsdcPerBase: 0, poolFeeUsdcPerBase: 0, perps: perpsFees };
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
