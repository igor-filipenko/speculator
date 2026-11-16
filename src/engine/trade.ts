import { Connection } from "@solana/web3.js";
import { assertTradeConfig, isPublicSolanaRpc, type AppConfig } from "../config.js";
import { exchangeSignedSize, type BotMode } from "../db/bot.js";
import { EmulatedExchange } from "../exchange/emulated/emulated-exchange.js";
import { tradableBaseSize } from "../exchange/jupiter/amounts.js";
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
import {
  decideInstance,
  exchangeDrifted,
  settlePair,
  type PendingFill,
  type TickBook,
  type TradingInstance,
} from "./tick.js";
import { loadKeypairFromFile, WalletBalances } from "../portfolio/wallet/wallet.js";
import {
  isOrder,
  type BalanceSource,
  type Candle,
  type Command,
  type Exchange,
  type Market,
  type PairConfig,
  type PerpsFees,
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
  /** Live wallet. Paper and watch leave this unset, so quote is not gated. */
  liveWallet?: LiveWallet;
}

export interface LiveWallet {
  balances: BalanceSource;
  solReserveMin: number;
  solReserveMax: number;
  positions: PositionSource;
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
  liveWallet?: LiveWallet;
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
    const anchor = instances[0];
    if (anchor !== undefined && options.liveWallet !== undefined) {
      await topUpSolReserve(exchange, anchor.pair, options.liveWallet);
    }
    let nextDelay: Delay = Delay.any();
    for (const group of groupByPair(instances)) {
      const first = group[0];
      if (first === undefined) continue;
      let sharedPrice: number | undefined;
      if (!(exchange instanceof EmulatedExchange)) {
        sharedPrice = await exchange.spotPrice(first.pair);
      }
      const perpsFees = await exchange.perpsFeeSchedule(first.pair);
      logPerpsFees(first.pair.symbol, perpsFees);
      const prepared: Prepared[] = [];
      for (const instance of group) {
        const market = marketFor(markets, instance.candleSource, config.birdeyeApiKey);
        try {
          prepared.push(
            await prepareInstance({
              instance,
              market,
              exchange,
              portfolios,
              lastSignals,
              lastCandles,
              telegram,
              ...(sharedPrice !== undefined ? { price: sharedPrice } : {}),
              ...(perpsFees !== undefined ? { perpsFees } : {}),
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[${instance.registryId} ${instance.pair.symbol}] tick failed: ${message}`);
          await options.telegram.notify({ type: "error", pair: instance.pair.symbol, message });
        }
      }
      await settleGroup({
        group,
        prepared,
        exchange,
        mode: modeLabel === "trade" ? "live" : "paper",
        simulated: modeLabel !== "trade",
        ...(options.liveWallet !== undefined ? { liveWallet: options.liveWallet } : {}),
        telegram,
      });
      for (const item of prepared) nextDelay = nextDelay.min(item.delay);
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

interface Prepared {
  instance: TradingInstance;
  signal: Signal;
  book?: TickBook;
  command?: Command;
  protective: boolean;
  portfolio?: Portfolio;
  price: number;
  delay: Delay;
}

function groupByPair(instances: readonly TradingInstance[]): TradingInstance[][] {
  const groups = new Map<string, TradingInstance[]>();
  for (const instance of instances) {
    const list = groups.get(instance.pair.symbol) ?? [];
    list.push(instance);
    groups.set(instance.pair.symbol, list);
  }
  return [...groups.values()];
}

/**
 * Fetch one instance's candles and decide. The pair books after every instance
 * on that pair has decided, so the venue sees one net order.
 */
async function prepareInstance(args: {
  instance: TradingInstance;
  market: Market;
  exchange: Exchange;
  portfolios: Map<string, Portfolio>;
  lastSignals: Map<string, Signal>;
  lastCandles: Map<string, Candle[]>;
  telegram: Telegram;
  price?: number;
  perpsFees?: PerpsFees;
}): Promise<Prepared> {
  const { instance, market, exchange, portfolios, lastSignals, lastCandles, telegram } = args;
  const pair = instance.pair;
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
  let price = args.price;
  if (price === undefined) {
    if (exchange instanceof EmulatedExchange) exchange.setMidPrice(lastCandle.close);
    price = await exchange.spotPrice(pair);
  }

  const portfolio = portfolios.get(instance.id);
  // Wall clock, not candle open: otherwise a just-closed bar (next candle not
  // published yet) is treated as still forming and stripped from the signal.
  const decision = await decideInstance({
    strategy: instance.strategy,
    riskManager: new GenericRiskManager(instance.riskPercent),
    exchange,
    pair,
    candles,
    price,
    at: new Date(),
    ...(args.perpsFees !== undefined ? { perpsFees: args.perpsFees } : {}),
    ...(portfolio !== undefined ? { portfolio } : {}),
  });

  lastCandles.set(instance.id, candles);
  lastSignals.set(instance.id, decision.signal);
  logSignal(decision.signal);
  await persistSignal(decision.signal, instance.id);
  await telegram.notify({ type: "signal", signal: decision.signal });

  const prepared: Prepared = {
    instance,
    signal: decision.signal,
    protective: decision.protective === true,
    price,
    delay: candleDelay(pair.symbol, lastCandle.time, interval),
    ...(portfolio !== undefined ? { portfolio } : {}),
  };
  if (decision.command !== undefined && decision.command.intent !== "buy-sol" && portfolio) {
    prepared.command = decision.command;
  } else {
    prepared.book = decision.book ?? { kind: "hold" };
  }
  return prepared;
}

async function settleGroup(args: {
  group: readonly TradingInstance[];
  prepared: Prepared[];
  exchange: Exchange;
  mode: BotMode;
  simulated: boolean;
  liveWallet?: LiveWallet;
  telegram: Telegram;
}): Promise<void> {
  const { group, prepared, exchange, telegram } = args;
  const first = group[0];
  if (first === undefined) return;
  const pending: PendingFill[] = [];
  const indexes: number[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i];
    if (item?.command === undefined || item.portfolio === undefined) continue;
    indexes.push(i);
    pending.push({
      command: item.command,
      portfolio: item.portfolio,
      protective: item.protective,
    });
  }
  if (pending.length > 0) {
    const price = prepared.find((item) => item.price > 0)?.price ?? 0;
    if (exchange instanceof EmulatedExchange && price > 0) exchange.setMidPrice(price);
    const currentExchange = await exchangeSignedSize(first.pair.symbol, args.mode);
    let blockEntries = false;
    if (args.liveWallet !== undefined) {
      const chain = await chainSignedSize(first.pair, args.liveWallet);
      if (exchangeDrifted(chain, currentExchange)) {
        blockEntries = true;
        console.error(
          `[${first.pair.symbol}] exchange position ${currentExchange} differs from chain ${chain}; no new entries until they match`,
        );
      }
    }
    const freeQuoteUsdc =
      args.liveWallet !== undefined
        ? await walletQuoteUsdc(first.pair, args.liveWallet.balances)
        : undefined;
    const perpsFees = await args.exchange.perpsFeeSchedule(first.pair);
    const books = await settlePair({
      pair: first.pair,
      exchange,
      price,
      pending,
      currentExchange,
      simulated: args.simulated,
      ...(freeQuoteUsdc !== undefined ? { freeQuoteUsdc } : {}),
      ...(blockEntries ? { blockEntries } : {}),
      ...(perpsFees !== undefined ? { perpsFees } : {}),
    });
    let traded = false;
    for (let i = 0; i < books.length; i++) {
      const item = prepared[indexes[i] ?? -1];
      const book = books[i];
      if (item === undefined || book === undefined) continue;
      if (book.kind === "filled") traded = true;
      const ok = await reportBook(
        book,
        item.signal,
        item.price,
        item.portfolio,
        first.pair,
        telegram,
      );
      if (!ok) item.delay = Delay.any();
    }
    if (traded && args.liveWallet !== undefined) {
      await logResidual(first.pair, args.liveWallet.balances, prepared);
    }
  }
  for (const item of prepared) {
    if (item.command !== undefined || item.book === undefined) continue;
    const ok = await reportBook(
      item.book,
      item.signal,
      item.price,
      item.portfolio,
      item.instance.pair,
      telegram,
    );
    if (!ok) item.delay = Delay.any();
  }
}

function candleDelay(symbol: string, openSec: number, intervalSec: number): Delay {
  const candleCloseAfterMs = (openSec + intervalSec) * 1000 - Date.now();
  const ts = new Date().toISOString();
  if (candleCloseAfterMs <= 0) {
    console.log(`[${ts}] [${symbol}] last candle already closed`);
    return Delay.any();
  }
  console.log(`[${ts}] [${symbol}] last candle close in ${candleCloseAfterMs}ms`);
  return Delay.fromMs(candleCloseAfterMs);
}

async function topUpSolReserve(
  exchange: Exchange,
  pair: PairConfig,
  wallet: LiveWallet,
): Promise<void> {
  await wallet.balances.refresh([pair.quoteMint]);
  const native = wallet.balances.nativeSol();
  if (native >= wallet.solReserveMin) return;
  const order = await exchange.execute(
    {
      pair: pair.symbol,
      intent: "buy-sol",
      orderType: "market",
      reason: "native SOL below reserve minimum",
      at: new Date(),
      priceHint: 0,
      baseSize: wallet.solReserveMax - native,
    },
    pair,
  );
  if (!isOrder(order)) {
    console.error(`[wallet] SOL top-up failed: ${order.message}`);
    return;
  }
  logOrder(order);
}

async function chainSignedSize(pair: PairConfig, wallet: LiveWallet): Promise<number> {
  await wallet.balances.refresh([pair.baseMint, pair.quoteMint]);
  const short = await wallet.positions.findOpenPosition(pair);
  if (short != null && short.size > 1e-9) return -short.size;
  const spot = tradableBaseSize({
    baseMint: pair.baseMint,
    tokenUi: wallet.balances.tokenUi(pair.baseMint),
    nativeSol: wallet.balances.nativeSol(),
    reserveSol: wallet.solReserveMax,
  });
  return spot > 1e-9 ? spot : 0;
}

async function walletQuoteUsdc(pair: PairConfig, balances: BalanceSource): Promise<number> {
  await balances.refresh([pair.quoteMint]);
  return balances.tokenUi(pair.quoteMint);
}

async function logResidual(
  pair: PairConfig,
  balances: BalanceSource,
  prepared: readonly Prepared[],
): Promise<void> {
  await balances.refresh([pair.quoteMint]);
  const walletUsdc = balances.tokenUi(pair.quoteMint);
  let strategyCash = 0;
  for (const item of prepared) {
    if (item.portfolio === undefined) continue;
    strategyCash += item.portfolio.getSnapshot(item.price).cashUsdc;
  }
  const residual = walletUsdc - strategyCash;
  if (Math.abs(residual) <= 0.01) return;
  console.log(
    `[${pair.symbol}] wallet USDC ${walletUsdc.toFixed(4)} vs strategy cash ${strategyCash.toFixed(4)}; residual ${residual.toFixed(4)} stays on the wallet`,
  );
}

async function reportBook(
  book: TickBook,
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
