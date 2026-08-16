import type { Strategy, StrategyMode } from "../types.js";
import { BollingerStrategy } from "./bollinger.js";
import { EmaRsiStrategy } from "./ema-rsi.js";

export function loadStrategy(mode: StrategyMode): Strategy {
  return mode === "bollinger" ? new BollingerStrategy() : new EmaRsiStrategy();
}
