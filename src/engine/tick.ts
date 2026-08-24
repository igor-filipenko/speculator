import type { AppConfig } from "../config.js";
import { fetchCandles } from "../market/gecko-terminal.js";
import { logRisk, logSignal, logSnapshot, logTrade, persistSignal } from "../notify/console.js";
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

export interface TradingLoopOptions {
  config: AppConfig;
  strategy: Strategy;
  riskManager: RiskManager;
  exchange: Exchange;
  state: ProgramState;
  telegram: Telegram;
  once?: boolean;
  shutdownCb: ShutdownCb;
  modeLabel: string;
}

/**
 * Shared poll loop: candles → signal → risk command → exchange order → portfolio fill.
 */
export async function runTradingLoop(options: TradingLoopOptions): Promise<void> {
  const { config, strategy, riskManager, exchange, once = false, modeLabel } = options;
  const portfolios = options.state.portfolios;
  const lastSignals = options.state.lastSignals;
  const lastCandles = options.state.lastCandles;
  const telegram = options.telegram;
  const shutdown = options.shutdownCb;
  const startMsg = `Starting ${modeLabel} mode | strategy=${strategy.getDisplayName()} | pairs=${config.watchlist.join(",")} | poll=${config.pollIntervalMs}ms`;
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
          pair,
          strategy,
          exchange,
          riskManager,
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

export async function processPair(args: {
  pair: PairConfig;
  strategy: Strategy;
  exchange: Exchange;
  riskManager: RiskManager;
  portfolios: Map<string, Portfolio>;
  lastSignals: Map<string, Signal>;
  lastCandles: Map<string, Candle[]>;
  telegram: Telegram;
}): Promise<void> {
  const { pair, strategy, exchange, riskManager, portfolios, lastSignals, lastCandles, telegram } =
    args;

  const requiredCandles = strategy.getRequiredCandles();
  const candles = await fetchCandles({
    poolAddress: pair.geckoPoolAddress,
    timeframe: requiredCandles.timeframe,
    limit: requiredCandles.count,
  });

  const price = await exchange.spotPrice(pair);

  const portfolio = portfolios.get(pair.symbol);
  if (portfolio) {
    await portfolio.syncFromChain(price);
  }

  const signal = strategy.evaluateSignal(
    pair.symbol,
    candles,
    price,
    new Date(candles[candles.length - 1]!.time * 1000),
    portfolio?.getSnapshot(price),
  );

  lastCandles.set(pair.symbol, candles);
  lastSignals.set(pair.symbol, signal);
  logSignal(signal);
  await persistSignal(signal);
  await telegram.notify({ type: "signal", signal });

  if (!portfolio) {
    console.error(`[${pair.symbol}] portfolio not found`);
    return;
  }

  const result = riskManager.check(signal, portfolio.getSnapshot(price));
  if (result.kind === "risk") {
    logRisk(result.risk);
    await telegram.notify({ type: "risk", risk: result.risk });
    logSnapshot(portfolio.getSnapshot(price));
    return;
  }
  if (result.kind === "no-command") {
    logSnapshot(portfolio.getSnapshot(price));
    return;
  }
  const command = result.command;

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
