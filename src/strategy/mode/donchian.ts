import type {
  Candle,
  MarketIndicators,
  RequiredCandles,
  RiskParams,
  Signal,
  SignalSide,
  Strategy,
  Timeframe,
  Trend,
  Volatility,
} from "../../types.js";
import { atr, donchian, ema, sma } from "../indicators.js";
import { buildDonchianSvg } from "./donchian-svg.js";

export interface DonchianParams {
  timeframe: Timeframe;
  /** N-bar high used for BUY breakout. */
  entryPeriod: number;
  /** N-bar low used for SELL exit. */
  exitPeriod: number;
  /** SMA lookback on volume (prior bars only at signal time). */
  volumeSmaPeriod: number;
  /** BUY only when last volume > this × prior volume SMA. */
  volumeSmaMult: number;
  /** Slow trend EMA; BUY only when close is above it. 0 = skip. */
  trendEmaPeriod: number;
  /** Wilder ATR period (into Signal.meta for risk stops). */
  atrPeriod: number;
  /**
   * Minimum (close − prior upper) in ATR units. 0 = skip.
   * Filters 20-bar highs that barely poke the channel.
   */
  minBreakAtrMult: number;
  /** When false, breakouts are ignored (HTF not bullish). Exits still fire. */
  enableBuy: boolean;
}

/** Stricter volume confirmation in squeeze; unused when enableBuy is false. */
const VOLUME_SMA_MULT: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 1.1, low: 1.3, squeeze: 1.4, unknown: 1.2 },
  flat: { high: 1.5, low: 1.5, squeeze: 1.8, unknown: 1.5 },
  bearish: { high: 1.8, low: 1.8, squeeze: 1.8, unknown: 1.8 },
  unknown: { high: 1.8, low: 1.8, squeeze: 1.8, unknown: 1.8 },
};

const ATR_STOP: Record<Trend, number> = {
  bullish: 3,
  flat: 2.5,
  bearish: 2,
  unknown: 2,
};

const ATR_TRAIL: Record<Trend, number> = {
  bullish: 4,
  flat: 3.5,
  bearish: 2.5,
  unknown: 2.5,
};

/** Signal-side params for HTF `trend` × 1h `volatility` (defaults: flat / low). */
export function donchianParamsFor(
  trend: Trend = "flat",
  volatility: Volatility = "low",
): DonchianParams {
  return {
    timeframe: "15m",
    entryPeriod: 20,
    exitPeriod: 20,
    volumeSmaPeriod: 20,
    volumeSmaMult: VOLUME_SMA_MULT[trend][volatility],
    trendEmaPeriod: 50,
    atrPeriod: 14,
    minBreakAtrMult: 0.1,
    enableBuy: trend === "bullish",
  };
}

function riskParamsFor(trend: Trend): RiskParams {
  return {
    timeframe: "15m",
    atrStopMult: ATR_STOP[trend],
    atrTrailMult: ATR_TRAIL[trend],
    cooldownBars: 8,
    minHoldBars: 4,
  };
}

export interface DonchianInput {
  pair: string;
  candles: Candle[];
  strategy: DonchianParams;
  /** Spot price used in the signal (usually exchange quote). */
  price: number;
  at?: Date;
}

/**
 * Trend-following Donchian breakout (HTF bullish only).
 * BUY when close crosses above the prior entry-period high by minBreakAtrMult×ATR,
 * volume exceeds k × prior volume SMA, and close is above trend EMA.
 * SELL when close crosses below the prior exit-period low.
 * Volume / EMA / enableBuy do not block exits.
 */
export function evaluateDonchian(input: DonchianInput): Signal {
  const { pair, candles, strategy, price } = input;
  const at = input.at ?? new Date();
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const entry = donchian(candles, strategy.entryPeriod);
  const exit = donchian(candles, strategy.exitPeriod);
  const volumeSmaSeries = sma(volumes, strategy.volumeSmaPeriod);
  const trendSeries = strategy.trendEmaPeriod > 0 ? ema(closes, strategy.trendEmaPeriod) : [];
  const atrSeries = atr(candles, strategy.atrPeriod);

  const i = closes.length - 1;
  const prev = i - 1;
  const entryUpperPrev = prev >= 0 ? entry.upper[prev] : null;
  const exitLowerPrev = prev >= 0 ? exit.lower[prev] : null;
  const volumeSmaPrev = prev >= 0 ? volumeSmaSeries[prev] : null;
  const trendEma = strategy.trendEmaPeriod > 0 ? trendSeries[i] : undefined;
  const atrNow = atrSeries[i];
  const lastBar = candles[i];

  const meta: NonNullable<Signal["meta"]> = {};
  if (entryUpperPrev != null) meta.donchianUpper = entryUpperPrev;
  if (exitLowerPrev != null) meta.donchianLower = exitLowerPrev;
  if (volumeSmaPrev != null) meta.volumeSma = volumeSmaPrev;
  if (trendEma != null) meta.trendEma = trendEma;
  if (atrNow != null) meta.atr = atrNow;
  if (lastBar != null) {
    meta.barLow = lastBar.low;
    meta.barHigh = lastBar.high;
  }

  const base = {
    pair,
    price,
    at,
    meta,
  };

  if (
    entryUpperPrev == null ||
    exitLowerPrev == null ||
    volumeSmaPrev == null ||
    (strategy.trendEmaPeriod > 0 && trendEma == null) ||
    atrNow == null ||
    lastBar == null ||
    prev < 0
  ) {
    return {
      ...base,
      side: "HOLD",
      reason: "Indicators not warm yet (warmup, need more candles)",
    };
  }

  const close = closes[i]!;
  const closePrev = closes[prev]!;
  const volume = lastBar.volume;
  const volumeThreshold = strategy.volumeSmaMult * volumeSmaPrev;
  const breakMargin = strategy.minBreakAtrMult * atrNow;

  const brokeLower = closePrev >= exitLowerPrev && close < exitLowerPrev;
  const brokeUpper = closePrev <= entryUpperPrev && close > entryUpperPrev;

  let side: SignalSide = "HOLD";
  let reason = `No Donchian signal (close=${fmt(close)}, upper=${fmt(entryUpperPrev)}, exitLow=${fmt(exitLowerPrev)}, vol=${fmt(volume)}, volSMA=${fmt(volumeSmaPrev)})`;

  if (brokeLower) {
    side = "SELL";
    reason = `Donchian exit: close broke prior ${strategy.exitPeriod}-bar low (prev ${fmt(closePrev)} ≥ ${fmt(exitLowerPrev)}, close ${fmt(close)} < ${fmt(exitLowerPrev)})`;
  } else if (brokeUpper) {
    if (!strategy.enableBuy) {
      reason = `Breakout ignored: HTF trend not bullish`;
    } else if (close <= entryUpperPrev + breakMargin) {
      reason =
        `Breakout ignored: close ${fmt(close)} − upper ${fmt(entryUpperPrev)} ` +
        `<= ${fmt(breakMargin)} (${strategy.minBreakAtrMult}×ATR)`;
    } else if (volume <= volumeThreshold) {
      reason = `Breakout ignored: volume ${fmt(volume)} <= ${fmt(volumeThreshold)} (${strategy.volumeSmaMult}× SMA ${fmt(volumeSmaPrev)})`;
    } else if (strategy.trendEmaPeriod > 0 && trendEma != null && close <= trendEma) {
      reason = `Breakout ignored: close ${fmt(close)} <= trend EMA${strategy.trendEmaPeriod} ${fmt(trendEma)}`;
    } else {
      side = "BUY";
      const emaNote =
        strategy.trendEmaPeriod > 0 && trendEma != null
          ? `close > trend EMA${strategy.trendEmaPeriod}; `
          : "";
      reason =
        `Donchian breakout (prev ${fmt(closePrev)} ≤ ${fmt(entryUpperPrev)}, close ${fmt(close)} > ${fmt(entryUpperPrev)}); ` +
        `volume ${fmt(volume)} > ${fmt(volumeThreshold)} (${strategy.volumeSmaMult}× SMA); ${emaNote}`.trim();
    }
  }

  return { ...base, side, reason };
}

/** 15m Donchian breakout: 20-bar high + SMA volume + EMA50; HTF bullish only; exit at 20-bar low. */
export class DonchianStrategy implements Strategy {
  private readonly params: DonchianParams;
  private readonly risk: RiskParams;

  constructor(trend: Trend = "flat", volatility: Volatility = "low") {
    this.params = donchianParamsFor(trend, volatility);
    this.risk = riskParamsFor(trend);
  }

  getDisplayName(): string {
    const {
      timeframe,
      entryPeriod,
      exitPeriod,
      volumeSmaPeriod,
      volumeSmaMult,
      trendEmaPeriod,
      enableBuy,
    } = this.params;
    const gate = enableBuy ? "bull" : "no-buy";
    return `donchian (${timeframe} DC${entryPeriod}/${exitPeriod} volSMA${volumeSmaPeriod}×${volumeSmaMult.toFixed(1)} EMA${trendEmaPeriod} ${gate})`;
  }

  getMode(): "donchian" {
    return "donchian";
  }

  getRiskParams(): RiskParams {
    return this.risk;
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, entryPeriod, exitPeriod, volumeSmaPeriod, trendEmaPeriod, atrPeriod } =
      this.params;
    const warm =
      Math.max(entryPeriod, exitPeriod, volumeSmaPeriod + 1, trendEmaPeriod, atrPeriod + 1) + 20;
    return {
      timeframe,
      count: Math.min(warm, 100),
    };
  }

  evaluateSignal(
    pair: string,
    candles: Candle[],
    _market: MarketIndicators,
    price: number,
    at: Date,
  ): Signal {
    return evaluateDonchian({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
    });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildDonchianSvg({ pair, candles, strategy: this.params });
  }
}

function fmt(n: number): string {
  return n.toFixed(4);
}
