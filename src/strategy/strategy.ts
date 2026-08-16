import type {
  BollingerParams,
  Candle,
  EmaStrategyMode,
  RequiredCandles,
  RiskParams,
  Signal,
  Strategy,
  StrategyMode,
  StrategyParams,
} from "../types.js";
import { evaluateBollinger } from "./bollinger.js";
import { buildBollingerSvg } from "./bollinger-svg.js";
import { evaluateEmaRsi } from "./ema-rsi.js";
import { buildOhlcvSvg } from "./ohlcv-svg.js";

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

/** Risk for mean-reversion range trades on 4h (longer cooldown after stops). */
const BOLLINGER_RISK_DEFAULTS: Omit<RiskParams, "timeframe"> = {
  atrStopMult: 2.5,
  atrTrailMult: 3,
  cooldownBars: 4,
  minHoldBars: 1,
};

/** Signal-side defaults (for tests / chart helpers). Not part of the Strategy public API. */
export function strategyParamsFor(mode: EmaStrategyMode): StrategyParams {
  if (mode === "swing") {
    return {
      mode: "swing",
      timeframe: "4h",
      emaFast: 12,
      emaSlow: 26,
      rsiPeriod: 14,
      ...SWING_SIGNAL_DEFAULTS,
    };
  }
  return {
    mode: "intraday",
    timeframe: "15m",
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    ...INTRADAY_SIGNAL_DEFAULTS,
  };
}

/** Bollinger flat defaults (for tests). Not part of the Strategy public API. */
export function bollingerParamsFor(): BollingerParams {
  return {
    mode: "bollinger",
    timeframe: "4h",
    period: 20,
    stdDev: 2,
    trendEmaPeriod: 50,
    atrPeriod: 14,
    adxPeriod: 14,
    adxMax: 20,
    minBandToMidPct: 0.015,
  };
}

function riskParamsFor(mode: EmaStrategyMode): RiskParams {
  if (mode === "swing") {
    return { timeframe: "4h", ...SWING_RISK_DEFAULTS };
  }
  return { timeframe: "15m", ...INTRADAY_RISK_DEFAULTS };
}

abstract class EmaRsiStrategy implements Strategy {
  protected constructor(
    private readonly params: StrategyParams,
    private readonly risk: RiskParams,
  ) {}

  getDisplayName(): string {
    return `${this.params.mode} (${this.params.timeframe})`;
  }

  getMode(): StrategyMode {
    return this.params.mode;
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

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildOhlcvSvg({ pair, candles, strategy: this.params });
  }
}

/** 4h swing: EMA 12/26 + RSI 14 + trend/ADX filters. */
export class SwingStrategy extends EmaRsiStrategy {
  constructor() {
    super(strategyParamsFor("swing"), riskParamsFor("swing"));
  }
}

/** 15m intraday: EMA 9/21 + RSI 14 + wider ATR / longer cooldown. */
export class IntradayStrategy extends EmaRsiStrategy {
  constructor() {
    super(strategyParamsFor("intraday"), riskParamsFor("intraday"));
  }
}

/** 4h mean-reversion: BB reclaim + trend EMA + ADX flat gate; exit at mid. */
export class BollingerStrategy implements Strategy {
  private readonly params: BollingerParams;
  private readonly risk: RiskParams;

  constructor() {
    this.params = bollingerParamsFor();
    this.risk = { timeframe: "4h", ...BOLLINGER_RISK_DEFAULTS };
  }

  getDisplayName(): string {
    return `bollinger (${this.params.timeframe})`;
  }

  getMode(): StrategyMode {
    return "bollinger";
  }

  getRiskParams(): RiskParams {
    return this.risk;
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, period, trendEmaPeriod, atrPeriod, adxPeriod } = this.params;
    const warm = Math.max(period, trendEmaPeriod, atrPeriod, adxPeriod * 2) + 5;
    return {
      timeframe,
      count: Math.max(warm, 160),
    };
  }

  evaluateSignal(pair: string, candles: Candle[], price: number, at: Date): Signal {
    return evaluateBollinger({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
    });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildBollingerSvg({ pair, candles, strategy: this.params });
  }
}

export function loadStrategy(mode: StrategyMode): Strategy {
  if (mode === "swing") {
    return new SwingStrategy();
  }
  if (mode === "bollinger") {
    return new BollingerStrategy();
  }
  return new IntradayStrategy();
}
