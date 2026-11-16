import type { AppConfig } from "../config.js";
import { EmulatedExchange } from "../exchange/emulated/emulated-exchange.js";
import type { ProgramState, ShutdownCb } from "../types.js";
import { Telegram } from "../notify/telegram.js";
import { runTradingLoop } from "./trade.js";
import type { TradingInstance } from "./tick.js";

export interface PaperOptions {
  config: AppConfig;
  state: ProgramState;
  telegram: Telegram;
  /** When true, run a single iteration then exit (useful for smoke tests). */
  once?: boolean;
  shutdownCb: ShutdownCb;
  instances: TradingInstance[];
}

/**
 * Paper poll loop: candles → signal → risk command → emulated fill → virtual portfolio.
 * The emulated venue replaces whatever integration the instance names.
 */
export async function runPaper(options: PaperOptions): Promise<void> {
  const exchange = new EmulatedExchange();
  await runTradingLoop({
    ...options,
    exchange,
    modeLabel: "paper",
    instances: options.instances,
  });
}
