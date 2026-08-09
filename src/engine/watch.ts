import type { AppConfig } from "../config.js";
import { JupiterExchange } from "../exchange/jupiter.js";
import { fetchCandles } from "../market/gecko-terminal.js";
import { logSignal, logSnapshot, logTrade, persistSignal } from "../notify/console.js";
import { Telegram } from "../notify/telegram.js";
import { SimpleRiskManager } from "../risk/risk-manager.js";
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

export interface WatchOptions {
  config: AppConfig;
  strategy: Strategy;
  state: ProgramState;
  telegram: Telegram;
  /** When true, run a single iteration then exit (useful for smoke tests). */
  once?: boolean;
  shutdownCb: ShutdownCb;
}

/**
 * Main poll loop: candles → signal → risk command → exchange order → optional paper fill.
 */
export async function runWatch(options: WatchOptions): Promise<void> {
  const { config, strategy, once = false } = options;
  const exchange = new JupiterExchange({ apiKey: config.jupiterApiKey });
  const risk = new SimpleRiskManager();
  const params = strategy.getParams();

  if (!config.jupiterApiKey) {
    console.warn("Warning: JUPITER_API_KEY is empty; quotes may fail or be rate-limited.");
  }

  const portfolios = options.state.portfolios;
  const lastSignals = options.state.lastSignals;
  const lastCandles = options.state.lastCandles;
  const telegram = options.telegram;
  const shutdown = options.shutdownCb;
  const startMsg = `Starting ${config.mode} mode | strategy=${params.mode} (${params.timeframe}) | pairs=${config.watchlist.join(",")} | poll=${config.pollIntervalMs}ms`;
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
  const { config, pair, strategy, exchange, risk, portfolios, lastSignals, lastCandles, telegram } =
    args;

  const required = strategy.getRequiredCandles();
  const candles = await fetchCandles({
    poolAddress: pair.geckoPoolAddress,
    timeframe: required.timeframe,
    limit: required.count,
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

  if (config.mode !== "paper") {
    return;
  }

  const portfolio = portfolios.get(pair.symbol);
  if (!portfolio) {
    return;
  }

  const command = risk.check(signal, portfolio.getSnapshot(price));
  if (!command) {
    logSnapshot(portfolio.getSnapshot(price));
    return;
  }

  const order = await exchange.execute(command, pair);
  const trade = await portfolio.applyOrder(order);
  if (trade) {
    logTrade(trade);
    await telegram.notify({ type: "trade", trade });
  }
  logSnapshot(portfolio.getSnapshot(price));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
