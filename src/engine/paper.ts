import type { AppConfig } from "../config.js";
import { JupiterExchange } from "../exchange/jupiter/jupiter.js";
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
 * Paper poll loop: candles → signal → risk command → Jupiter quote fill → virtual portfolio.
 */
export async function runPaper(options: PaperOptions): Promise<void> {
  const exchange = new JupiterExchange({ apiKey: options.config.jupiterApiKey });
  await runTradingLoop({
    ...options,
    exchange,
    modeLabel: "paper",
    instances: options.instances,
  });
}
