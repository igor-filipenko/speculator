import type {
  Candle,
  RequiredCandles,
  RiskParams,
  Signal,
  Strategy,
  StrategyMode,
  StrategyParams,
} from "../types.js";
import { evaluateEmaRsi } from "./ema-rsi.js";

const INTRADAY_SIGNAL_DEFAULTS = {
  rsiBuyMin: 40,
  rsiBuyMax: 60,
  rsiSellMin: 45,
  trendEmaPeriod: 100,
  atrPeriod: 14,
  adxPeriod: 14,
  adxMin: 25,
} as const;

const SWING_SIGNAL_DEFAULTS = {
  rsiBuyMin: 40,
  rsiBuyMax: 60,
  rsiSellMin: 45,
  trendEmaPeriod: 50,
  atrPeriod: 14,
  adxPeriod: 14,
  adxMin: 20,
} as const;

/** Wider stops / longer cooldown on 15m so noise + ~1.1% RT costs do not churn. */
const INTRADAY_RISK_DEFAULTS: Omit<RiskParams, "timeframe"> = {
  atrStopMult: 3.5,
  atrTrailMult: 4.5,
  cooldownBars: 12,
  minHoldBars: 4,
};

const SWING_RISK_DEFAULTS: Omit<RiskParams, "timeframe"> = {
  atrStopMult: 2,
  atrTrailMult: 2.5,
  cooldownBars: 2,
  minHoldBars: 1,
};

abstract class EmaRsiStrategy implements Strategy {
  protected constructor(
    private readonly params: StrategyParams,
    private readonly risk: RiskParams,
  ) {}

  getParams(): StrategyParams {
    return this.params;
  }

  getRiskParams(): RiskParams {
    return this.risk;
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, emaSlow, rsiPeriod, trendEmaPeriod, atrPeriod, adxPeriod } = this.params;
    const warm = Math.max(emaSlow, trendEmaPeriod, atrPeriod, adxPeriod * 2) + rsiPeriod + 5;
    return {
      timeframe,
      count: Math.max(warm, 160),
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

/** 4h swing: EMA 12/26 + RSI 14 + trend/ADX filters. */
export class SwingStrategy extends EmaRsiStrategy {
  constructor() {
    super(
      {
        mode: "swing",
        timeframe: "4h",
        emaFast: 12,
        emaSlow: 26,
        rsiPeriod: 14,
        ...SWING_SIGNAL_DEFAULTS,
      },
      { timeframe: "4h", ...SWING_RISK_DEFAULTS },
    );
  }
}

/** 15m intraday: EMA 9/21 + RSI 14 + wider ATR / longer cooldown. */
export class IntradayStrategy extends EmaRsiStrategy {
  constructor() {
    super(
      {
        mode: "intraday",
        timeframe: "15m",
        emaFast: 9,
        emaSlow: 21,
        rsiPeriod: 14,
        ...INTRADAY_SIGNAL_DEFAULTS,
      },
      { timeframe: "15m", ...INTRADAY_RISK_DEFAULTS },
    );
  }
}

export function loadStrategy(mode: StrategyMode): Strategy {
  return mode === "swing" ? new SwingStrategy() : new IntradayStrategy();
}
