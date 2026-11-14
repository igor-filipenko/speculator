import type { AppConfig } from "../config.js";
import { JupiterExchange } from "../exchange/jupiter/jupiter.js";
import type { ProgramState, ShutdownCb } from "../types.js";
import { Telegram } from "../notify/telegram.js";
import { runTradingLoop } from "./trade.js";
import type { TradingInstance } from "./tick.js";

export interface WatchOptions {
  config: AppConfig;
  state: ProgramState;
  telegram: Telegram;
  /** When true, run a single iteration then exit (useful for smoke tests). */
  once?: boolean;
  shutdownCb: ShutdownCb;
  instances: TradingInstance[];
}

/**
 * Watch poll loop: candles → signal only (no portfolio fills).
 */
export async function runWatch(options: WatchOptions): Promise<void> {
  const exchange = new JupiterExchange({ apiKey: options.config.jupiterApiKey });
  await runTradingLoop({
    ...options,
    exchange,
    modeLabel: "watch",
    instances: options.instances,
  });
}
