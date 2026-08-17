import type { Strategy, StrategyMode } from "../types.js";
import { BollingerStrategy } from "./bollinger.js";
import { EmaRsiStrategy } from "./ema-rsi.js";
import { GridStrategy } from "./grid.js";

export function loadStrategy(mode: StrategyMode): Strategy {
  if (mode === "bollinger") return new BollingerStrategy();
  if (mode === "grid") return new GridStrategy();
  return new EmaRsiStrategy();
}
