import { Connection } from "@solana/web3.js";
import { assertTradeConfig, isPublicSolanaRpc, type AppConfig } from "../config.js";
import { JupiterExchange } from "../exchange/jupiter/jupiter.js";
import { candleIntervalSeconds } from "../market/candle.js";
import { refreshMarketIndicators } from "../market/htf-indicators.js";
import { createMarket } from "../market/manager.js";
import {
  logMarket,
  logPerpsFees,
  logRisk,
  logSignal,
  logSnapshot,
  logOrder,
  logTrade,
  persistSignal,
} from "../notify/console.js";
import { Telegram } from "../notify/telegram.js";
import { LivePortfolio } from "../portfolio/live/portfolio.js";
import { loadKeypairFromFile, WalletBalances } from "../portfolio/wallet/wallet.js";
import {
  isOrder,
  type Candle,
  type Exchange,
  type Market,
  type MarketIndicators,
  type PairConfig,
  type Portfolio,
  type PositionSource,
  type ProgramState,
  type RiskManager,
  type ShutdownCb,
  type Signal,
  type StrategyManager,
} from "../types.js";

export interface TradeOptions {
  config: AppConfig;
  strategyManager: StrategyManager;
  exchange: Exchange;
  state: ProgramState;
  telegram: Telegram;
  once?: boolean;
  shutdownCb: ShutdownCb;
}

export interface LiveRuntime {
  portfolios: Map<string, Portfolio>;
  exchange: Exchange & PositionSource;
  walletAddress: string;
}

export interface TradingLoopOptions {
  config: AppConfig;
  strategyManager: StrategyManager;
  exchange: Exchange;
  state: ProgramState;
  telegram: Telegram;
  once?: boolean;
  shutdownCb: ShutdownCb;
  modeLabel: string;
}

/** Shared wallet + exchange + live portfolios (one BalanceSource for all pairs). */
export async function createLiveRuntime(config: AppConfig): Promise<LiveRuntime> {
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
  const portfolios = await LivePortfolio.load(config.pairs, balances, {
    solReserveMin: config.solReserveMin,
    solReserveMax: config.solReserveMax,
    positions: exchange,
  });

  return {
    portfolios,
    exchange,
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
  const { config, strategyManager, exchange, once = false, modeLabel } = options;
  const market = createMarket(config.candleSource);
  const strategy = strategyManager.getActiveStrategy();
  const portfolios = options.state.portfolios;
  const lastSignals = options.state.lastSignals;
  const lastCandles = options.state.lastCandles;
  const lastMarketIndicators = options.state.lastMarketIndicators;
  const telegram = options.telegram;
  const shutdown = options.shutdownCb;
  const startMsg = `Starting ${modeLabel} mode | strategy=${strategy.getDisplayName()} | htf=${config.htf} | pairs=${config.watchlist.join(",")} | poll=${config.pollIntervalMs}ms`;
  console.log(startMsg);

  const ok = await telegram.notify({ type: "start" });
  if (!ok) {
    throw new Error("Failed to send start message to Telegram");
  }

  const tick = async (): Promise<Delay> => {
    let nextDelay: Delay = Delay.any();
    for (const pair of config.pairs) {
      try {
        const requiredNextDelay = await processPair({
          pair,
          market,
          strategyManager,
          exchange,
          portfolios,
          lastSignals,
          lastCandles,
          lastMarketIndicators,
          telegram,
        });
        nextDelay = nextDelay.min(requiredNextDelay);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${pair.symbol}] tick failed: ${message}`);
        await options.telegram.notify({ type: "error", pair: pair.symbol, message });
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
 * Process one pair. Returns when the current signal candle closes (for poll scheduling).
 */
async function processPair(args: {
  pair: PairConfig;
  market: Market;
  strategyManager: StrategyManager;
  exchange: Exchange;
  portfolios: Map<string, Portfolio>;
  lastSignals: Map<string, Signal>;
  lastCandles: Map<string, Candle[]>;
  lastMarketIndicators: Map<string, MarketIndicators>;
  telegram: Telegram;
}): Promise<Delay> {
  const {
    pair,
    market,
    strategyManager,
    exchange,
    portfolios,
    lastSignals,
    lastCandles,
    lastMarketIndicators,
    telegram,
  } = args;

  const price = await exchange.spotPrice(pair);
  const nowSec = Math.floor(Date.now() / 1000);
  const tryUseCache = Math.floor(nowSec / 60) % 2 === 1;

  try {
    const previous = lastMarketIndicators.get(pair.symbol);
    const indicators = await refreshMarketIndicators({
      pair,
      market,
      required: strategyManager.getRequiredHtfCandles(),
      mtfRequired: strategyManager.getRequiredMtfCandles(),
      price,
      at: new Date(nowSec * 1000),
      ...(tryUseCache ? { tryUseCache } : {}),
    });
    logMarket(indicators);
    const marketChanged =
      previous !== undefined
        ? await strategyManager.applyMarketIndicators(indicators, previous)
        : await strategyManager.applyMarketIndicators(indicators);
    lastMarketIndicators.set(pair.symbol, indicators);
    if (marketChanged) {
      console.log(
        `[${pair.symbol}] market changed trend=${previous?.trend}→${indicators.trend}` +
          ` vol=${previous?.volatility}→${indicators.volatility}`,
      );
      await telegram.notify({
        type: "market",
        market: indicators,
        ...(previous !== undefined ? { previous: previous.trend } : {}),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${pair.symbol}] market indicators failed: ${message}`);
  }

  const strategy = strategyManager.getActiveStrategy();
  const riskManager = strategyManager.getActiveRiskManager();

  const requiredCandles = strategy.getRequiredCandles();
  const interval = candleIntervalSeconds(requiredCandles.timeframe);
  const candles = await market.fetchCandles({
    pair,
    timeframe: requiredCandles.timeframe,
    fromTime: nowSec - requiredCandles.count * interval,
    toTime: nowSec,
    ...(tryUseCache ? { tryUseCache } : {}),
  });
  const lastCandle = candles[candles.length - 1]!;

  const portfolio = portfolios.get(pair.symbol);
  if (portfolio) {
    await portfolio.syncFromChain(price);
  }

  const indicators = lastMarketIndicators.get(pair.symbol) ?? {
    pair: pair.symbol,
    price,
    trend: "unknown" as const,
    volatility: "unknown" as const,
  };
  const perpsFees = await exchange.perpsFeeSchedule(pair);
  logPerpsFees(pair.symbol, perpsFees);
  // Wall clock, not candle open: otherwise a just-closed bar (next candle not
  // published yet) is treated as still forming and stripped from the signal.
  const signal = strategy.evaluateSignal(
    pair.symbol,
    candles,
    indicators,
    price,
    new Date(),
    portfolio?.getSnapshot(price),
    perpsFees,
  );

  lastCandles.set(pair.symbol, candles);
  lastSignals.set(pair.symbol, signal);
  logSignal(signal);
  await persistSignal(signal);
  await telegram.notify({ type: "signal", signal });

  const ok = await processSignal(
    signal,
    price,
    candles,
    portfolio,
    exchange,
    riskManager,
    pair,
    telegram,
  );
  if (ok) {
    const candleCloseAtMs =
      (lastCandle.time + candleIntervalSeconds(requiredCandles.timeframe)) * 1000;
    const candleCloseAfterMs = candleCloseAtMs - Date.now();
    const alreadyClosed = candleCloseAfterMs <= 0;
    const ts = new Date().toISOString();
    if (alreadyClosed) {
      console.log(`[${ts}] [${pair.symbol}] last candle already closed`);
      return Delay.any();
    }
    console.log(`[${ts}] [${pair.symbol}] last candle close in ${candleCloseAfterMs}ms`);
    return Delay.fromMs(candleCloseAfterMs);
  }
  return Delay.any();
}

async function processSignal(
  signal: Signal,
  price: number,
  candles: Candle[],
  portfolio: Portfolio | undefined,
  exchange: Exchange,
  riskManager: RiskManager,
  pair: PairConfig,
  telegram: Telegram,
): Promise<boolean> {
  if (!portfolio) {
    // Watch mode: signal-only, no portfolio to fill.
    return true;
  }

  const result = riskManager.check(signal, portfolio.getSnapshot(price), candles);
  if (result.kind === "risk") {
    logRisk(result.risk);
    logSnapshot(portfolio.getSnapshot(price));
    await telegram.notify({ type: "risk", risk: result.risk });
    return true;
  }
  if (result.kind === "no-command") {
    logSnapshot(portfolio.getSnapshot(price));
    return true;
  }
  const command = result.command;
  const protective = result.kind === "protective-command";

  const order = await exchange.execute(command, pair);
  if (!isOrder(order)) {
    console.error(`[${pair.symbol}] ${order.message}`);
    await telegram.notify({ type: "error", pair: pair.symbol, message: order.message });
    return false;
  }

  if (order.intent === "buy-sol") {
    await portfolio.applyOrder(order);
    logOrder(order);
    logSnapshot(portfolio.getSnapshot(price));
    return true;
  }

  const trade = await portfolio.applyOrder(order);
  if (!trade) {
    logSnapshot(portfolio.getSnapshot(price));
    console.error(`[${pair.symbol}] no trade, portfolio returned null`);
    return false;
  }

  logTrade(trade);
  await telegram.notify(protective ? { type: "protective", trade } : { type: "trade", trade });
  return true;
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
