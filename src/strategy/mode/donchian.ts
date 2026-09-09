import type {
  Candle,
  MarketIndicators,
  PortfolioSnapshot,
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
}

/** Stricter volume confirmation in squeeze; unused when HTF is not bullish. */
const VOLUME_SMA_MULT: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 1.2, low: 1.5, squeeze: 1.6, unknown: 1.3 },
  flat: { high: 1.5, low: 1.5, squeeze: 1.8, unknown: 1.5 },
  bearish: { high: 1.8, low: 1.8, squeeze: 1.8, unknown: 1.8 },
  unknown: { high: 1.8, low: 1.8, squeeze: 1.8, unknown: 1.8 },
};

/**
 * Exit channel is longer than entry so a 5h pullback does not dump a multi-day
 * runner. Squeeze breakouts get the widest channel (those are the big legs).
 */
const EXIT_PERIOD: Record<Volatility, number> = {
  high: 40,
  low: 40,
  squeeze: 55,
  unknown: 40,
};

/** Skip 20-bar highs that barely poke the channel (false breaks). */
const MIN_BREAK_ATR: Record<Volatility, number> = {
  high: 0.2,
  low: 0.35,
  squeeze: 0.25,
  unknown: 0.25,
};

const ATR_STOP: Record<Trend, number> = {
  bullish: 3,
  flat: 2.5,
  bearish: 2,
  unknown: 2,
};

/**
 * Wide enough to hold the first 15m pullback after a breakout (4× trails out
 * of the runner before the HTF move); not so wide that a 102 spike gives back
 * to 80. Low-vol grind can trail a bit further.
 */
const ATR_TRAIL: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 6, low: 8, squeeze: 6, unknown: 6 },
  flat: { high: 5, low: 5, squeeze: 5, unknown: 5 },
  bearish: { high: 3, low: 3, squeeze: 3, unknown: 3 },
  unknown: { high: 3, low: 3, squeeze: 3, unknown: 3 },
};

/** Signal-side params for HTF `trend` × 1h `volatility` (defaults: flat / low). */
export function donchianParamsFor(
  trend: Trend = "flat",
  volatility: Volatility = "low",
): DonchianParams {
  return {
    timeframe: "15m",
    entryPeriod: 20,
    exitPeriod: EXIT_PERIOD[volatility],
    volumeSmaPeriod: 20,
    volumeSmaMult: VOLUME_SMA_MULT[trend][volatility],
    trendEmaPeriod: 50,
    atrPeriod: 14,
    minBreakAtrMult: MIN_BREAK_ATR[volatility],
  };
}

function riskParamsFor(trend: Trend, volatility: Volatility): RiskParams {
  return {
    timeframe: "15m",
    atrStopMult: ATR_STOP[trend],
    atrTrailMult: ATR_TRAIL[trend][volatility],
    /** 24h on 15m: skip throwback longs right after a trail/DC exit. */
    cooldownBars: 96,
    minHoldBars: 16,
  };
}

export interface DonchianInput {
  pair: string;
  candles: Candle[];
  strategy: DonchianParams;
  /** Spot price used in the signal (usually exchange quote). */
  price: number;
  at?: Date;
  /**
   * Last SELL fill. A new breakout's prior channel high must exceed it so
   * throwbacks that only reclaim a local 20-bar high are ignored.
   */
  lastSellPrice?: number;
  /** When true, breakouts are ignored (HTF not bullish). Exits still fire. */
  doNotBuy?: boolean;
}

/**
 * Trend-following Donchian breakout (HTF bullish only).
 * BUY when close crosses above the prior entry-period high by minBreakAtrMult×ATR,
 * volume exceeds k × prior volume SMA, close is above trend EMA, and the prior
 * channel high is above the last SELL fill when one exists.
 * SELL when close crosses below the prior (longer) exit-period low.
 * Volume / EMA / doNotBuy do not block exits.
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
    if (input.doNotBuy) {
      reason = `Breakout ignored: HTF trend not bullish`;
    } else if (close <= entryUpperPrev + breakMargin) {
      reason =
        `Breakout ignored: close ${fmt(close)} − upper ${fmt(entryUpperPrev)} ` +
        `<= ${fmt(breakMargin)} (${strategy.minBreakAtrMult}×ATR)`;
    } else if (volume <= volumeThreshold) {
      reason = `Breakout ignored: volume ${fmt(volume)} <= ${fmt(volumeThreshold)} (${strategy.volumeSmaMult}× SMA ${fmt(volumeSmaPrev)})`;
    } else if (strategy.trendEmaPeriod > 0 && trendEma != null && close <= trendEma) {
      reason = `Breakout ignored: close ${fmt(close)} <= trend EMA${strategy.trendEmaPeriod} ${fmt(trendEma)}`;
    } else if (input.lastSellPrice != null && entryUpperPrev <= input.lastSellPrice) {
      reason = `Breakout ignored: channel high ${fmt(entryUpperPrev)} <= last exit ${fmt(input.lastSellPrice)}`;
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

/** 15m Donchian breakout: 20-bar high + SMA volume + EMA50; HTF bullish only; exit at 40/55-bar low. */
export class DonchianStrategy implements Strategy {
  private readonly params: DonchianParams;
  private readonly risk: RiskParams;
  private readonly trend: Trend;

  constructor(trend: Trend = "flat", volatility: Volatility = "low") {
    this.trend = trend;
    this.params = donchianParamsFor(trend, volatility);
    this.risk = riskParamsFor(trend, volatility);
  }

  getDisplayName(): string {
    const { timeframe, entryPeriod, exitPeriod, volumeSmaPeriod, volumeSmaMult, trendEmaPeriod } =
      this.params;
    const gate = this.trend === "bullish" ? "bull" : "no-buy";
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
    market: MarketIndicators,
    price: number,
    at: Date,
    snapshot?: PortfolioSnapshot,
  ): Signal {
    const lastSellPrice = lastSellFillPrice(snapshot);
    return evaluateDonchian({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
      doNotBuy: market.trend !== "bullish",
      ...(lastSellPrice != null ? { lastSellPrice } : {}),
    });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildDonchianSvg({ pair, candles, strategy: this.params });
  }
}

function lastSellFillPrice(snapshot: PortfolioSnapshot | undefined): number | undefined {
  if (snapshot == null) {
    return undefined;
  }
  for (let i = snapshot.trades.length - 1; i >= 0; i--) {
    const trade = snapshot.trades[i];
    if (trade?.side === "SELL" && trade.price > 0) {
      return trade.price;
    }
  }
  return undefined;
}

function fmt(n: number): string {
  return n.toFixed(4);
}
