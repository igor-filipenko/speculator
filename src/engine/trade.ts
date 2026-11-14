import { Connection } from "@solana/web3.js";
import { assertTradeConfig, isPublicSolanaRpc, type AppConfig } from "../config.js";
import { JupiterExchange } from "../exchange/jupiter/jupiter.js";
import { candleIntervalSeconds, isCandleFirstMinute } from "../market/candle.js";
import { createMarket } from "../market/manager.js";
import {
  logPerpsFees,
  logPositionData,
  logRisk,
  logSignal,
  logSnapshot,
  logOrder,
  logTrade,
  persistSignal,
} from "../notify/console.js";
import { Telegram } from "../notify/telegram.js";
import { LivePortfolio } from "../portfolio/live/portfolio.js";
import { GenericRiskManager } from "../risk/risk-manager.js";
import { runInstanceTick, type TradingInstance } from "./tick.js";
import { loadKeypairFromFile, WalletBalances } from "../portfolio/wallet/wallet.js";
import {
  type Candle,
  type Exchange,
  type Market,
  type PairConfig,
  type Portfolio,
  type PositionSource,
  type ProgramState,
  type ShutdownCb,
  type Signal,
} from "../types.js";

export interface TradeOptions {
  config: AppConfig;
  exchange: Exchange;
  state: ProgramState;
  telegram: Telegram;
  once?: boolean;
  shutdownCb: ShutdownCb;
  instances: TradingInstance[];
}

export interface LiveRuntime {
  portfolios: Map<string, Portfolio>;
  exchange: Exchange & PositionSource;
  balances: import("../types.js").BalanceSource;
  walletAddress: string;
}

export interface TradingLoopOptions {
  config: AppConfig;
  exchange: Exchange;
  state: ProgramState;
  telegram: Telegram;
  once?: boolean;
  shutdownCb: ShutdownCb;
  modeLabel: string;
  instances: TradingInstance[];
}

/** Shared wallet + exchange. Books load from the watchlist unless `loadBooks` is false. */
export async function createLiveRuntime(
  config: AppConfig,
  options?: { loadBooks?: boolean },
): Promise<LiveRuntime> {
  assertTradeConfig(config);

  const keypair = await loadKeypairFromFile(config.walletKeypairPath);
  if (isPublicSolanaRpc(config.solanaRpcUrl)) {
    console.warn(
      "Warning: SOLANA_RPC_URL is the public mainnet endpoint; a dedicated RPC is recommended.",
    );
  }

  const connection = new Connection(config.solanaRpcUrl, {
    commitment: "confirmed",
    // Disable the default keep-alive Agent so one-shot `pnpm wallet` can exit.
    httpAgent: false,
  });
  const balances = new WalletBalances(connection, keypair.publicKey);
  const exchange = new JupiterExchange({
    apiKey: config.jupiterApiKey,
    keypair,
    balances,
    slippageBps: config.slippageBps,
    solReserveMin: config.solReserveMin,
    solReserveMax: config.solReserveMax,
  });
  const portfolios =
    options?.loadBooks === false
      ? new Map<string, Portfolio>()
      : await LivePortfolio.load(
          config.pairs,
          balances,
          {
            solReserveMin: config.solReserveMin,
            solReserveMax: config.solReserveMax,
            positions: exchange,
          },
          config.strategy,
        );

  return {
    portfolios,
    exchange,
    balances,
    walletAddress: keypair.publicKey.toBase58(),
  };
}

/**
 * Live poll loop: candles → signal → risk command → Jupiter swap → on-chain portfolio.
 */
export async function runTrade(options: TradeOptions): Promise<void> {
  await runTradingLoop({
    ...options,
    modeLabel: "trade",
  });
}

/**
 * Shared poll loop: candles → signal → risk command → exchange order → portfolio fill.
 * Watch mode skips fills when no portfolio is loaded for a pair.
 */
export async function runTradingLoop(options: TradingLoopOptions): Promise<void> {
  const { config, exchange, once = false, modeLabel, instances } = options;
  if (instances.length === 0) {
    throw new Error("no strategies assigned to this bot; run strategy add");
  }
  const markets = new Map<string, Market>();
  const portfolios = options.state.portfolios;
  const lastSignals = options.state.lastSignals;
  const lastCandles = options.state.lastCandles;
  const telegram = options.telegram;
  const shutdown = options.shutdownCb;
  const names = instances
    .map((instance) => `${instance.registryId} ${instance.pair.symbol}`)
    .join(", ");
  const startMsg = `Starting ${modeLabel} mode | ${names} | poll=${config.pollIntervalMs}ms`;
  console.log(startMsg);

  const ok = await telegram.notify({ type: "start" });
  if (!ok) {
    throw new Error("Failed to send start message to Telegram");
  }

  const tick = async (): Promise<Delay> => {
    let nextDelay: Delay = Delay.any();
    for (const instance of instances) {
      const market = marketFor(markets, instance.candleSource, config.birdeyeApiKey);
      try {
        const requiredNextDelay = await processInstance({
          instance,
          market,
          exchange,
          portfolios,
          lastSignals,
          lastCandles,
          telegram,
        });
        nextDelay = nextDelay.min(requiredNextDelay);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${instance.registryId} ${instance.pair.symbol}] tick failed: ${message}`);
        await options.telegram.notify({ type: "error", pair: instance.pair.symbol, message });
      }
    }
    return nextDelay;
  };

  try {
    for (;;) {
      const nextDelay = await tick();
      if (once) {
        await shutdown("once complete", 0);
        return;
      }
      await sleep(nextDelay.minMs(config.pollIntervalMs));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await shutdown(`crash: ${message}`, 1);
  }
}

/**
 * One instance: fetch its candles, decide, and book. Returns when its signal
 * candle closes so the poll can wait for the soonest close.
 */
async function processInstance(args: {
  instance: TradingInstance;
  market: Market;
  exchange: Exchange;
  portfolios: Map<string, Portfolio>;
  lastSignals: Map<string, Signal>;
  lastCandles: Map<string, Candle[]>;
  telegram: Telegram;
}): Promise<Delay> {
  const { instance, market, exchange, portfolios, lastSignals, lastCandles, telegram } = args;
  const pair = instance.pair;
  const price = await exchange.spotPrice(pair);
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMinute = Math.floor(nowSec / 60);
  const tryUseCache = nowMinute % 2 === 1;

  const requiredCandles = instance.strategy.getRequiredCandles();
  const interval = candleIntervalSeconds(requiredCandles.timeframe);
  const isFirstMinute = isCandleFirstMinute(nowSec, interval);
  const tryUseCacheForWtf = tryUseCache && !isFirstMinute;
  console.log(`[${pair.symbol}] using cache for work time frame: ${tryUseCacheForWtf}`);
  const candles = await market.fetchCandles({
    pair,
    timeframe: requiredCandles.timeframe,
    fromTime: nowSec - requiredCandles.count * interval,
    toTime: nowSec,
    ...(tryUseCacheForWtf ? { tryUseCache } : {}),
  });
  const lastCandle = candles[candles.length - 1];
  if (lastCandle === undefined) {
    throw new Error(`no candles for ${pair.symbol}`);
  }

  const portfolio = portfolios.get(instance.id);
  const perpsFees = await exchange.perpsFeeSchedule(pair);
  logPerpsFees(pair.symbol, perpsFees);
  // Wall clock, not candle open: otherwise a just-closed bar (next candle not
  // published yet) is treated as still forming and stripped from the signal.
  const outcome = await runInstanceTick({
    strategy: instance.strategy,
    riskManager: new GenericRiskManager(instance.riskPercent),
    exchange,
    pair,
    candles,
    price,
    at: new Date(),
    ...(perpsFees !== undefined ? { perpsFees } : {}),
    ...(portfolio !== undefined ? { portfolio } : {}),
  });

  lastCandles.set(instance.id, candles);
  lastSignals.set(instance.id, outcome.signal);
  logSignal(outcome.signal);
  await persistSignal(outcome.signal, instance.id);
  await telegram.notify({ type: "signal", signal: outcome.signal });

  const ok = await reportBook(outcome.book, outcome.signal, price, portfolio, pair, telegram);
  if (!ok) return Delay.any();
  const candleCloseAtMs =
    (lastCandle.time + candleIntervalSeconds(requiredCandles.timeframe)) * 1000;
  const candleCloseAfterMs = candleCloseAtMs - Date.now();
  const ts = new Date().toISOString();
  if (candleCloseAfterMs <= 0) {
    console.log(`[${ts}] [${pair.symbol}] last candle already closed`);
    return Delay.any();
  }
  console.log(`[${ts}] [${pair.symbol}] last candle close in ${candleCloseAfterMs}ms`);
  return Delay.fromMs(candleCloseAfterMs);
}

async function reportBook(
  book: Awaited<ReturnType<typeof runInstanceTick>>["book"],
  signal: Signal,
  price: number,
  portfolio: Portfolio | undefined,
  pair: PairConfig,
  telegram: Telegram,
): Promise<boolean> {
  if (book.kind === "signal" || book.kind === "hold") {
    if (portfolio) logSnapshot(portfolio.getSnapshot(price));
    return true;
  }
  if (book.kind === "risk") {
    const risk = { signal, reason: book.reason };
    logRisk(risk);
    if (portfolio) logSnapshot(portfolio.getSnapshot(price));
    await telegram.notify({ type: "risk", risk });
    return true;
  }
  if (book.kind === "position-data") {
    logPositionData(book.data);
    if (portfolio) logSnapshot(portfolio.getSnapshot(price));
    return true;
  }
  if (book.kind === "rejected") {
    console.error(`[${pair.symbol}] ${book.message}`);
    await telegram.notify({ type: "error", pair: pair.symbol, message: book.message });
    return false;
  }
  if (book.kind === "sol") {
    logOrder(book.order);
    if (portfolio) logSnapshot(portfolio.getSnapshot(price));
    return true;
  }
  logTrade(book.trade);
  await telegram.notify(
    book.protective
      ? { type: "protective", trade: book.trade }
      : { type: "trade", trade: book.trade },
  );
  return true;
}

function marketFor(markets: Map<string, Market>, source: string, birdeyeApiKey: string): Market {
  const cached = markets.get(source);
  if (cached !== undefined) return cached;
  const market = createMarket(source as import("../types.js").CandleSource, birdeyeApiKey);
  markets.set(source, market);
  return market;
}

class Delay {
  readonly ms: number | undefined;

  private constructor(ms: number | undefined) {
    this.ms = ms;
  }

  /** Creates an unbound/any delay instance. */
  static any(): Delay {
    return new Delay(undefined);
  }

  /** Creates a Delay instance with a specific duration in milliseconds. */
  static fromMs(ms: number): Delay {
    return new Delay(ms);
  }

  /** Compares this delay with another delay and returns the minimum. */
  min(other: Delay): Delay {
    if (this.ms === undefined) {
      return other;
    }
    if (other.ms === undefined) {
      return this;
    }
    return Delay.fromMs(Math.min(this.ms, other.ms));
  }

  minMs(ms: number): number {
    if (this.ms === undefined) {
      return ms;
    }
    return Math.min(this.ms, ms);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
