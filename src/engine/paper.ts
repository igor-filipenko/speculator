import type { AppConfig } from "../config.js";
import { JupiterExchange } from "../exchange/jupiter.js";
import type { ProgramState, RiskManager, ShutdownCb, Strategy } from "../types.js";
import { Telegram } from "../notify/telegram.js";
import { runTradingLoop } from "./tick.js";

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
 * Paper poll loop: candles → signal → risk command → Jupiter quote fill → virtual portfolio.
 */
export async function runPaper(options: PaperOptions): Promise<void> {
  const exchange = new JupiterExchange({ apiKey: options.config.jupiterApiKey });
  await runTradingLoop({
    ...options,
    exchange,
    modeLabel: "paper",
  });
}
