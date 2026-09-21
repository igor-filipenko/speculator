import { candleIntervalSeconds, isCandleClosed } from "../../market/gecko-terminal.js";
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
  /**
   * SELL when close/price falls this many ATR from the hold's peak high.
   * Caps giveback if HTF later widens the risk trail.
   */
  givebackAtrMult: number;
}

/** Stricter volume confirmation in squeeze; unused when HTF is bearish/unknown. */
const VOLUME_SMA_MULT: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 1.2, low: 1.5, squeeze: 1.6, unknown: 1.3 },
  flat: { high: 1.5, low: 2.0, squeeze: 1.8, unknown: 1.8 },
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

const GIVEBACK_ATR_MULT: Record<Volatility, number> = {
  high: 3,
  low: 3,
  squeeze: 3,
  unknown: 3,
};

/**
 * Wide enough to hold the first 15m pullback after a breakout on a bullish HTF
 * (4× trails out of the runner before the HTF move). Flat uses a tighter trail
 * so a 15m spike cannot give the whole move back to the ATR stop.
 */
const ATR_TRAIL: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 6, low: 8, squeeze: 6, unknown: 6 },
  flat: { high: 3, low: 3, squeeze: 3, unknown: 3 },
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
    givebackAtrMult: GIVEBACK_ATR_MULT[volatility],
  };
}

function riskParamsFor(trend: Trend, volatility: Volatility): RiskParams {
  return {
    timeframe: "15m",
    atrStopMult: ATR_STOP[trend],
    atrTrailMult: ATR_TRAIL[trend][volatility],
    /** 2h on 15m: skip an immediate re-entry, not a full day after an ATR stop. */
    cooldownBars: 8,
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
  /** Open-long fill; enables peak-giveback SELL. */
  entryPrice?: number;
  /** When the long was opened; peak is max high of overlapping candles. */
  openedAt?: Date;
  /** When true, breakouts are ignored (HTF bearish/unknown). Exits still fire. */
  doNotBuy?: boolean;
}

/**
 * Trend-following Donchian breakout (HTF bullish or flat).
 * BUY when a **closed** bar's close crosses above the prior entry-period high by
 * minBreakAtrMult×ATR, volume exceeds k × prior volume SMA, and close is above trend EMA.
 * A forming last candle is ignored for entries (live/intra-bar); fill is the next tick after close.
 * SELL when a closed close crosses below the prior (longer) exit-period low, or when
 * price gives back givebackAtrMult × ATR from the hold's peak (does not widen with HTF).
 * Volume / EMA / doNotBuy do not block exits. ATR stop/trail still use the forming range.
 */
export function evaluateDonchian(input: DonchianInput): Signal {
  const { pair, candles, strategy, price } = input;
  const at = input.at ?? new Date();
  const forming = candles[candles.length - 1];
  const lastIsClosed =
    forming != null && isCandleClosed(forming, at.getTime() / 1000, strategy.timeframe);
  const signalCandles = lastIsClosed || forming == null ? candles : candles.slice(0, -1);
  const closes = signalCandles.map((c) => c.close);
  const volumes = signalCandles.map((c) => c.volume);

  const entry = donchian(signalCandles, strategy.entryPeriod);
  const exit = donchian(signalCandles, strategy.exitPeriod);
  const volumeSmaSeries = sma(volumes, strategy.volumeSmaPeriod);
  const trendSeries = strategy.trendEmaPeriod > 0 ? ema(closes, strategy.trendEmaPeriod) : [];
  const atrSeries = atr(signalCandles, strategy.atrPeriod);

  const i = closes.length - 1;
  const prev = i - 1;
  const entryUpperPrev = prev >= 0 ? entry.upper[prev] : null;
  const exitLowerPrev = prev >= 0 ? exit.lower[prev] : null;
  const volumeSmaPrev = prev >= 0 ? volumeSmaSeries[prev] : null;
  const trendEma = strategy.trendEmaPeriod > 0 ? trendSeries[i] : undefined;
  const atrNow = atrSeries[i];
  const lastBar = signalCandles[i];

  const meta: NonNullable<Signal["meta"]> = {};
  if (entryUpperPrev != null) meta.donchianUpper = entryUpperPrev;
  if (exitLowerPrev != null) meta.donchianLower = exitLowerPrev;
  if (volumeSmaPrev != null) meta.volumeSma = volumeSmaPrev;
  if (trendEma != null) meta.trendEma = trendEma;
  if (atrNow != null) meta.atr = atrNow;
  const rangeBar = forming ?? lastBar;
  if (rangeBar != null) {
    meta.barLow = rangeBar.low;
    meta.barHigh = rangeBar.high;
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
  let reason = lastIsClosed
    ? `No Donchian signal (close=${fmt(close)}, upper=${fmt(entryUpperPrev)}, exitLow=${fmt(exitLowerPrev)}, vol=${fmt(volume)}, volSMA=${fmt(volumeSmaPrev)})`
    : `No Donchian signal (waiting for closed 15m breakout; close=${fmt(close)}, upper=${fmt(entryUpperPrev)}, exitLow=${fmt(exitLowerPrev)})`;

  if (
    input.entryPrice != null &&
    input.entryPrice > 0 &&
    strategy.givebackAtrMult > 0 &&
    gaveBackFromPeak({
      entryPrice: input.entryPrice,
      openedAt: input.openedAt,
      candles,
      timeframe: strategy.timeframe,
      atrNow,
      givebackAtrMult: strategy.givebackAtrMult,
      close,
      price,
    })
  ) {
    const peak = holdPeak(input.entryPrice, input.openedAt, candles, strategy.timeframe);
    const level = peak - strategy.givebackAtrMult * atrNow;
    side = "SELL";
    reason = `Gave back ${strategy.givebackAtrMult}×ATR from peak ${fmt(peak)} (level ${fmt(level)}, ATR=${fmt(atrNow)})`;
  } else if (brokeLower) {
    side = "SELL";
    reason = `Donchian exit: close broke prior ${strategy.exitPeriod}-bar low (prev ${fmt(closePrev)} ≥ ${fmt(exitLowerPrev)}, close ${fmt(close)} < ${fmt(exitLowerPrev)})`;
  } else if (brokeUpper) {
    if (input.doNotBuy) {
      reason = `Breakout ignored: HTF trend not bullish or flat`;
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

/** 15m Donchian breakout: closed-bar 20-bar high + SMA volume + EMA50; HTF bullish or flat; exit at 40/55-bar low or 3×ATR giveback. */
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
    const gate = this.trend === "bullish" ? "bull" : this.trend === "flat" ? "flat" : "no-buy";
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
    const position = snapshot?.position;
    const entryPrice =
      position?.side === "long" && position.entryPrice > 0 ? position.entryPrice : undefined;
    return evaluateDonchian({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
      doNotBuy: market.trend !== "bullish" && market.trend !== "flat",
      ...(entryPrice != null ? { entryPrice } : {}),
      ...(position?.openedAt != null ? { openedAt: position.openedAt } : {}),
    });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildDonchianSvg({ pair, candles, strategy: this.params });
  }
}

function holdPeak(
  entryPrice: number,
  openedAt: Date | undefined,
  candles: Candle[],
  timeframe: Timeframe,
): number {
  let peak = entryPrice;
  const intervalSec = candleIntervalSeconds(timeframe);
  const openedSec = openedAt != null ? openedAt.getTime() / 1000 : undefined;
  for (const candle of candles) {
    if (openedSec != null && intervalSec > 0 && candle.time + intervalSec <= openedSec) {
      continue;
    }
    peak = Math.max(peak, candle.high);
  }
  return peak;
}

function gaveBackFromPeak(input: {
  entryPrice: number;
  openedAt: Date | undefined;
  candles: Candle[];
  timeframe: Timeframe;
  atrNow: number;
  givebackAtrMult: number;
  close: number;
  price: number;
}): boolean {
  const peak = holdPeak(input.entryPrice, input.openedAt, input.candles, input.timeframe);
  const level = peak - input.givebackAtrMult * input.atrNow;
  return input.close <= level || input.price <= level;
}

function fmt(n: number): string {
  return n.toFixed(4);
}
