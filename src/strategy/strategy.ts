import type {
  Candle,
  RequiredCandles,
  Signal,
  Strategy,
  StrategyMode,
  StrategyParams,
} from "../types.js";
import { evaluateEmaRsi } from "./ema-rsi.js";

abstract class EmaRsiStrategy implements Strategy {
  protected constructor(private readonly params: StrategyParams) {}

  getParams(): StrategyParams {
    return this.params;
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, emaSlow, rsiPeriod } = this.params;
    return {
      timeframe,
      count: Math.max(emaSlow + rsiPeriod + 5, 120),
    };
  }

  evaluateSignal(pair: string, candles: Candle[], price: number, at: Date): Signal {
    return evaluateEmaRsi({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
    });
  }
}

/** 4h swing: EMA 12/26 + RSI 14. */
export class SwingStrategy extends EmaRsiStrategy {
  constructor() {
    super({
      mode: "swing",
      timeframe: "4h",
      emaFast: 12,
      emaSlow: 26,
      rsiPeriod: 14,
      rsiBuyMax: 70,
      rsiSellMin: 30,
    });
  }
}

/** 15m intraday: EMA 9/21 + RSI 14. */
export class IntradayStrategy extends EmaRsiStrategy {
  constructor() {
    super({
      mode: "intraday",
      timeframe: "15m",
      emaFast: 9,
      emaSlow: 21,
      rsiPeriod: 14,
      rsiBuyMax: 70,
      rsiSellMin: 30,
    });
  }
}

export function loadStrategy(mode: StrategyMode): Strategy {
  return mode === "swing" ? new SwingStrategy() : new IntradayStrategy();
}
