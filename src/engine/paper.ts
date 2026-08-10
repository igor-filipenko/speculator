import type { AppConfig } from "../config.js";
import { JupiterExchange } from "../exchange/jupiter.js";
import { fetchCandles } from "../market/gecko-terminal.js";
import { logSignal, logSnapshot, logTrade, persistSignal } from "../notify/console.js";
import { Telegram } from "../notify/telegram.js";
import type {
  Candle,
  Exchange,
  PairConfig,
  Portfolio,
  ProgramState,
  RiskManager,
  ShutdownCb,
  Signal,
  Strategy,
} from "../types.js";

export interface PaperOptions {
  config: AppConfig;
  strategy: Strategy;
  risk: RiskManager;
  state: ProgramState;
  telegram: Telegram;
  /** When true, run a single iteration then exit (useful for smoke tests). */
  once?: boolean;
  shutdownCb: ShutdownCb;
}

/**
 * Main poll loop: candles → signal → risk command → exchange order → optional paper fill.
 */
export async function runPaper(options: PaperOptions): Promise<void> {
  const { config, strategy, risk, once = false } = options;
  const exchange = new JupiterExchange({ apiKey: config.jupiterApiKey });
  const params = strategy.getParams();

  const portfolios = options.state.portfolios;
  const lastSignals = options.state.lastSignals;
  const lastCandles = options.state.lastCandles;
  const telegram = options.telegram;
  const shutdown = options.shutdownCb;
  const startMsg = `Starting paper mode | strategy=${params.mode} (${params.timeframe}) | pairs=${config.watchlist.join(",")} | poll=${config.pollIntervalMs}ms`;
  console.log(startMsg);

  const ok = await telegram.notify({ type: "start" });
  if (!ok) {
    console.error("Failed to send start message to Telegram");
    process.exit(1);
  }

  const tick = async (): Promise<void> => {
    for (const pair of config.pairs) {
      try {
        await processPair({
          config,
          pair,
          strategy,
          exchange,
          risk,
          portfolios,
          lastSignals,
          lastCandles,
          telegram,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${pair.symbol}] tick failed: ${message}`);
      }
    }
  };

  try {
    await tick();
    if (once) {
      await shutdown("once complete", 0);
      return;
    }

    for (;;) {
      await sleep(config.pollIntervalMs);
      await tick();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await shutdown(`crash: ${message}`, 1);
  }
}

async function processPair(args: {
  config: AppConfig;
  pair: PairConfig;
  strategy: Strategy;
  exchange: Exchange;
  risk: RiskManager;
  portfolios: Map<string, Portfolio>;
  lastSignals: Map<string, Signal>;
  lastCandles: Map<string, Candle[]>;
  telegram: Telegram;
}): Promise<void> {
  const { pair, strategy, exchange, risk, portfolios, lastSignals, lastCandles, telegram } = args;

  const requiredCandles = strategy.getRequiredCandles();
  const candles = await fetchCandles({
    poolAddress: pair.geckoPoolAddress,
    timeframe: requiredCandles.timeframe,
    limit: requiredCandles.count,
  });

  const price = await exchange.spotPrice(pair);

  const signal = strategy.evaluateSignal(
    pair.symbol,
    candles,
    price,
    new Date(candles[candles.length - 1]!.time * 1000),
  );

  lastCandles.set(pair.symbol, candles);
  lastSignals.set(pair.symbol, signal);
  logSignal(signal);
  await persistSignal(signal);
  await telegram.notify({ type: "signal", signal });

  const portfolio = portfolios.get(pair.symbol);
  if (!portfolio) {
    console.error(`[${pair.symbol}] portfolio not found`);
    return;
  }

  const command = risk.check(signal, portfolio.getSnapshot(price));
  if (!command) {
    logSnapshot(portfolio.getSnapshot(price));
    return;
  }

  const order = await exchange.execute(command, pair);
  if (!order) {
    console.error(`[${pair.symbol}] no order, exchange returned null`);
    return;
  }

  const trade = await portfolio.applyOrder(order);
  if (!trade) {
    logSnapshot(portfolio.getSnapshot(price));
    console.error(`[${pair.symbol}] no trade, portfolio returned null`);
    return;
  }

  logTrade(trade);
  await telegram.notify({ type: "trade", trade });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
