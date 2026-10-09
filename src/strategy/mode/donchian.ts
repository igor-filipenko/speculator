import { candleIntervalSeconds, isCandleClosed } from "../../market/gecko-terminal.js";
import type {
  Candle,
  MarketIndicators,
  PerpsFees,
  PortfolioSnapshot,
  RequiredCandles,
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
  /** N-bar channel for entries: high opens a long, low opens a short. */
  entryPeriod: number;
  /** N-bar channel for exits: low closes a long, high covers a short. */
  exitPeriod: number;
  /** SMA lookback on volume (prior bars only at signal time). */
  volumeSmaPeriod: number;
  /** Entry only when last volume > this × prior volume SMA. Same gate both sides. */
  volumeSmaMult: number;
  /** Slow trend EMA. Longs need close above it; shorts need close below. 0 = skip. */
  trendEmaPeriod: number;
  /** Wilder ATR period (into Signal.meta for risk stops). */
  atrPeriod: number;
  /**
   * Minimum distance past the prior channel, in ATR units. 0 = skip.
   * Filters breaks that barely poke the channel.
   */
  minBreakAtrMult: number;
  /**
   * Skip a short when the close is more than this many ATR under the trend EMA
   * (capitulation; bounces are common). 0 = skip.
   */
  shortMaxExtendAtrMult: number;
  /** Shorts need `volumeSmaMult` scaled by this (≥ 1 = stricter). */
  shortVolumeSmaScale: number;
  /** Shorts need `minBreakAtrMult` scaled by this (≥ 1 = stricter). */
  shortMinBreakScale: number;
  /**
   * Exit when price gives back this many ATR from the hold extreme
   * (peak high for a long, trough low for a short).
   */
  givebackAtrMult: number;
  /**
   * Giveback only arms after the hold extreme is at least this many ATR in profit
   * from the fill. 0 = armed from the start. Until then the hard stop, channel exit,
   * and time stop apply.
   */
  givebackArmAtrMult: number;
  /**
   * Once the giveback is armed, never trail worse than the fill: a long's level is at
   * least the entry price, a short's at most. Turns an armed trade into a scratch at worst.
   */
  givebackLockEntry: boolean;
  /**
   * Entries only fire within this many bars of the breakout bar's close, so a stale signal
   * cannot re-open on the same bar after a stop-out. Exits ignore it. 0 = off.
   */
  maxEntryAgeBars: number;
  /**
   * Bars after entry to prove follow-through. 0 = off. Wicks do not count.
   * Long: a later close must reach breakoutHigh − ATR.
   * Short: a later close must reach breakoutLow + ATR.
   */
  timeStopBars: number;
  /** Hard stop distance from the entry price, in ATRs. */
  atrStopMult: number;
}

/** Volume confirmation by HTF trend × 1h volatility. The same multiple applies both sides. */
const VOLUME_SMA_MULT: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 1.6, low: 2.0, squeeze: 2.1, unknown: 1.7 },
  flat: { high: 2.0, low: 2.6, squeeze: 2.3, unknown: 2.3 },
  bearish: { high: 2.3, low: 2.3, squeeze: 2.3, unknown: 2.3 },
  unknown: { high: 2.3, low: 2.3, squeeze: 2.3, unknown: 2.3 },
};

/** Skip channel pokes that are not a real break (false breaks). */
const MIN_BREAK_ATR: Record<Volatility, number> = {
  high: 0.7,
  low: 0.7,
  squeeze: 0.5,
  unknown: 0.5,
};

/** Signal-side params for HTF `trend` × 1h `volatility` (defaults: flat / low). */
export function donchianParamsFor(
  trend: Trend = "flat",
  volatility: Volatility = "low",
): DonchianParams {
  return {
    timeframe: "15m",
    entryPeriod: 40,
    exitPeriod: 20,
    volumeSmaPeriod: 20,
    volumeSmaMult: VOLUME_SMA_MULT[trend][volatility],
    trendEmaPeriod: 50,
    atrPeriod: 14,
    minBreakAtrMult: MIN_BREAK_ATR[volatility],
    shortMaxExtendAtrMult: 0,
    shortVolumeSmaScale: 1.7,
    shortMinBreakScale: 1.5,
    givebackAtrMult: 4,
    givebackArmAtrMult: 2,
    givebackLockEntry: true,
    maxEntryAgeBars: 0.25,
    timeStopBars: 3,
    atrStopMult: 3,
  };
}

/**
 * Hard stop beyond the fill. Longs sit `atrStopMult` × ATR under the price;
 * shorts sit the same distance over it.
 */
export function donchianStopPrice(
  side: "long" | "short",
  entryPrice: number,
  atrValue: number,
  atrStopMult: number,
): number {
  const distance = atrStopMult * atrValue;
  return side === "long" ? entryPrice - distance : entryPrice + distance;
}

export interface DonchianInput {
  pair: string;
  candles: Candle[];
  strategy: DonchianParams;
  /** Spot price used in the signal (usually exchange quote). */
  price: number;
  at?: Date;
  /** Open fill; enables extreme-giveback and time-stop exits. */
  entryPrice?: number;
  /** Which side `entryPrice` belongs to. Omitted with a fill means a long. */
  positionSide?: "long" | "short";
  /** When the position was opened; the extreme is taken from overlapping candles. */
  openedAt?: Date;
  /**
   * Perps open/close/borrow rates from the exchange cache.
   * Missing rates block a new short. Covers do not need them.
   */
  perpsFees?: PerpsFees;
  /**
   * HTF trend. Long breakouts need bullish or flat; short breakouts need
   * bearish. Exits ignore it.
   */
  trend: Trend;
}

/**
 * Symmetric Donchian breakout.
 * BUY when a **closed** bar's close crosses above the prior entry-period high by
 * minBreakAtrMult×ATR, volume exceeds k × prior volume SMA, close is above the
 * trend EMA, and HTF trend is bullish or flat.
 * SELL (open short) is the mirror through the prior entry-period low, with close
 * under the trend EMA and HTF bearish (flat does not open shorts). A short is not opened without a
 * perps fee schedule.
 * A forming last candle is ignored for entries (live/intra-bar); fill is the next tick after close.
 * An open long sells on the prior exit-period low, on givebackAtrMult×ATR off the
 * peak (armed once the peak is givebackArmAtrMult×ATR above the fill), or when timeStopBars pass without a close at breakoutHigh − ATR.
 * An open short covers on the prior exit-period high, on the same giveback off the
 * trough, or when no close reaches breakoutLow + ATR. Wicks alone do not count.
 * Volume / EMA / trend do not block exits.
 * An opening signal sets `slPrice` at atrStopMult×ATR. There is no take-profit: the
 * trade ends on the channel exit, the giveback, the time stop, or the hard stop.
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
  const entryLowerPrev = prev >= 0 ? entry.lower[prev] : null;
  const exitUpperPrev = prev >= 0 ? exit.upper[prev] : null;
  const exitLowerPrev = prev >= 0 ? exit.lower[prev] : null;
  const volumeSmaPrev = prev >= 0 ? volumeSmaSeries[prev] : null;
  const trendEma = strategy.trendEmaPeriod > 0 ? trendSeries[i] : undefined;
  const atrNow = atrSeries[i];
  const lastBar = signalCandles[i];

  const meta: NonNullable<Signal["meta"]> = {};
  if (entryUpperPrev != null) meta.donchianUpper = entryUpperPrev;
  if (entryLowerPrev != null) meta.donchianLower = entryLowerPrev;
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
    strategyId: "donchian",
    price,
    at,
    meta,
    tpPrices: [] as number[],
    // No take-profit, so the reward:risk gate is skipped.
    minRewardRisk: 0,
  };

  if (
    entryUpperPrev == null ||
    entryLowerPrev == null ||
    exitUpperPrev == null ||
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
  const shortVolumeThreshold = volumeThreshold * strategy.shortVolumeSmaScale;
  const shortBreakMargin = breakMargin * strategy.shortMinBreakScale;
  const extend = trendEma != null ? Math.abs(close - trendEma) / atrNow : 0;
  const entryFill = input.entryPrice;
  const openSide = input.positionSide;
  const long = entryFill != null && entryFill > 0 && openSide !== "short";
  const short = openSide === "short" && entryFill != null && entryFill > 0;

  const brokeEntryUpper = closePrev <= entryUpperPrev && close > entryUpperPrev;
  const brokeEntryLower = closePrev >= entryLowerPrev && close < entryLowerPrev;
  const brokeExitLower = closePrev >= exitLowerPrev && close < exitLowerPrev;
  const brokeExitUpper = closePrev <= exitUpperPrev && close > exitUpperPrev;

  if (long) {
    const gaveBack = gaveBackFromExtreme({
      side: "long",
      givebackLockEntry: strategy.givebackLockEntry,
      entryPrice: entryFill,
      openedAt: input.openedAt,
      candles,
      timeframe: strategy.timeframe,
      atrNow,
      givebackAtrMult: strategy.givebackAtrMult,
      givebackArmAtrMult: strategy.givebackArmAtrMult,
      close,
      price,
    });
    if (gaveBack != null) {
      const peak = gaveBack.extreme;
      const level = gaveBack.level;
      return {
        ...base,
        side: "SELL",
        reason: `Gave back ${strategy.givebackAtrMult}×ATR from peak ${fmt(peak)} (level ${fmt(level)}, ATR=${fmt(atrNow)})`,
      };
    }
    const timeStop = stalledBreakout({
      side: "long",
      entryPrice: entryFill,
      openedAt: input.openedAt,
      candles: signalCandles,
      timeframe: strategy.timeframe,
      atrNow,
      timeStopBars: strategy.timeStopBars,
      at,
    });
    if (timeStop != null) {
      return {
        ...base,
        side: "SELL",
        reason:
          `Time stop: no follow-through in ${strategy.timeStopBars} bars ` +
          `(best close ${fmt(timeStop.bestClose)} < ${fmt(timeStop.followLevel)} ` +
          `= breakout high ${fmt(timeStop.extreme)} - ATR, ATR=${fmt(atrNow)})`,
      };
    }
    if (brokeExitLower) {
      return {
        ...base,
        side: "SELL",
        reason: `Donchian exit: close broke prior ${strategy.exitPeriod}-bar low (prev ${fmt(closePrev)} ≥ ${fmt(exitLowerPrev)}, close ${fmt(close)} < ${fmt(exitLowerPrev)})`,
      };
    }
    return {
      ...base,
      side: "HOLD",
      reason: `Holding long (close=${fmt(close)}, exitLow=${fmt(exitLowerPrev)})`,
    };
  }

  if (short) {
    const gaveBack = gaveBackFromExtreme({
      side: "short",
      givebackLockEntry: strategy.givebackLockEntry,
      entryPrice: entryFill,
      openedAt: input.openedAt,
      candles,
      timeframe: strategy.timeframe,
      atrNow,
      givebackAtrMult: strategy.givebackAtrMult,
      givebackArmAtrMult: strategy.givebackArmAtrMult,
      close,
      price,
    });
    if (gaveBack != null) {
      const trough = gaveBack.extreme;
      const level = gaveBack.level;
      return {
        ...base,
        side: "BUY",
        reason: `Gave back ${strategy.givebackAtrMult}×ATR from trough ${fmt(trough)} (level ${fmt(level)}, ATR=${fmt(atrNow)})`,
      };
    }
    const timeStop = stalledBreakout({
      side: "short",
      entryPrice: entryFill,
      openedAt: input.openedAt,
      candles: signalCandles,
      timeframe: strategy.timeframe,
      atrNow,
      timeStopBars: strategy.timeStopBars,
      at,
    });
    if (timeStop != null) {
      return {
        ...base,
        side: "BUY",
        reason:
          `Time stop: no follow-through in ${strategy.timeStopBars} bars ` +
          `(best close ${fmt(timeStop.bestClose)} > ${fmt(timeStop.followLevel)} ` +
          `= breakout low ${fmt(timeStop.extreme)} + ATR, ATR=${fmt(atrNow)})`,
      };
    }
    if (brokeExitUpper) {
      return {
        ...base,
        side: "BUY",
        reason: `Donchian exit: close broke prior ${strategy.exitPeriod}-bar high (prev ${fmt(closePrev)} ≤ ${fmt(exitUpperPrev)}, close ${fmt(close)} > ${fmt(exitUpperPrev)})`,
      };
    }
    return {
      ...base,
      side: "HOLD",
      reason: `Holding short (close=${fmt(close)}, exitHigh=${fmt(exitUpperPrev)})`,
    };
  }

  const closeAtSec = lastBar.time + candleIntervalSeconds(strategy.timeframe);
  const entryAgeBars =
    strategy.maxEntryAgeBars > 0
      ? (at.getTime() / 1000 - closeAtSec) / candleIntervalSeconds(strategy.timeframe)
      : 0;
  const staleEntry = strategy.maxEntryAgeBars > 0 && entryAgeBars > strategy.maxEntryAgeBars;

  let side: SignalSide = "HOLD";
  let reason = lastIsClosed
    ? `No Donchian signal (close=${fmt(close)}, upper=${fmt(entryUpperPrev)}, lower=${fmt(entryLowerPrev)}, vol=${fmt(volume)}, volSMA=${fmt(volumeSmaPrev)})`
    : `No Donchian signal (waiting for closed 15m breakout; close=${fmt(close)}, upper=${fmt(entryUpperPrev)}, lower=${fmt(entryLowerPrev)})`;

  if ((brokeEntryUpper || brokeEntryLower) && staleEntry) {
    reason = `Entry ignored: breakout bar closed ${entryAgeBars.toFixed(2)} bars ago (> ${strategy.maxEntryAgeBars})`;
  } else if (brokeEntryUpper) {
    if (input.trend !== "bullish" && input.trend !== "flat") {
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
  } else if (brokeEntryLower) {
    if (input.trend !== "bearish") {
      reason = `Breakdown ignored: HTF trend not bearish`;
    } else if (input.perpsFees == null) {
      reason = "Breakdown ignored: perps fee schedule missing";
    } else if (close >= entryLowerPrev - shortBreakMargin) {
      reason =
        `Breakdown ignored: lower ${fmt(entryLowerPrev)} − close ${fmt(close)} ` +
        `<= ${fmt(shortBreakMargin)} (${strategy.minBreakAtrMult * strategy.shortMinBreakScale}×ATR)`;
    } else if (volume <= shortVolumeThreshold) {
      reason = `Breakdown ignored: volume ${fmt(volume)} <= ${fmt(shortVolumeThreshold)} (${strategy.volumeSmaMult * strategy.shortVolumeSmaScale}× SMA ${fmt(volumeSmaPrev)})`;
    } else if (strategy.trendEmaPeriod > 0 && trendEma != null && close >= trendEma) {
      reason = `Breakdown ignored: close ${fmt(close)} >= trend EMA${strategy.trendEmaPeriod} ${fmt(trendEma)}`;
    } else if (strategy.shortMaxExtendAtrMult > 0 && extend > strategy.shortMaxExtendAtrMult) {
      reason = `Breakdown ignored: close ${extend.toFixed(2)}×ATR under EMA > ${strategy.shortMaxExtendAtrMult}×ATR (capitulation)`;
    } else {
      side = "SELL";
      const emaNote =
        strategy.trendEmaPeriod > 0 && trendEma != null
          ? `close < trend EMA${strategy.trendEmaPeriod}; `
          : "";
      reason =
        `Donchian breakdown (prev ${fmt(closePrev)} ≥ ${fmt(entryLowerPrev)}, close ${fmt(close)} < ${fmt(entryLowerPrev)}); ` +
        `volume ${fmt(volume)} > ${fmt(volumeThreshold)} (${strategy.volumeSmaMult}× SMA); ${emaNote}`.trim();
    }
  }

  if ((side !== "BUY" && side !== "SELL") || !(atrNow > 0)) {
    return { ...base, side, reason };
  }
  const positionSide = side === "BUY" ? "long" : "short";
  const slPrice = donchianStopPrice(positionSide, price, atrNow, strategy.atrStopMult);
  return {
    ...base,
    side,
    reason,
    slPrice,
  };
}

/** 15m symmetric Donchian: closed-bar DC40 breakout + SMA volume + EMA50; long on bullish/flat, short on bearish only; exit DC20, 4×ATR giveback armed after a 2×ATR gain, or 3-bar time stop. No take-profit. */
export class DonchianStrategy implements Strategy {
  private readonly params: DonchianParams;
  private readonly trend: Trend;

  constructor(trend: Trend = "flat", volatility: Volatility = "low") {
    this.trend = trend;
    this.params = donchianParamsFor(trend, volatility);
  }

  getDisplayName(): string {
    const {
      timeframe,
      entryPeriod,
      exitPeriod,
      volumeSmaPeriod,
      volumeSmaMult,
      trendEmaPeriod,
      timeStopBars,
    } = this.params;
    const gate =
      this.trend === "bullish"
        ? "bull"
        : this.trend === "bearish"
          ? "bear"
          : this.trend === "flat"
            ? "flat"
            : "no-entry";
    const stop = timeStopBars > 0 ? ` tStop${timeStopBars}` : "";
    return `donchian (${timeframe} DC${entryPeriod}/${exitPeriod} volSMA${volumeSmaPeriod}×${volumeSmaMult.toFixed(1)} EMA${trendEmaPeriod}${stop} ${gate})`;
  }

  getId(): string {
    return "donchian";
  }

  /** Long: entry − atrStopMult × ATR. Short: entry + atrStopMult × ATR. */
  hardStopLoss(side: "long" | "short", entryPrice: number, atrValue: number): number {
    return donchianStopPrice(side, entryPrice, atrValue, this.params.atrStopMult);
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
    perpsFees?: PerpsFees,
  ): Signal {
    const position = snapshot?.position;
    const positioned =
      (position?.side === "long" || position?.side === "short") && position.entryPrice > 0
        ? position
        : undefined;
    return evaluateDonchian({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
      trend: market.trend,
      ...(perpsFees !== undefined ? { perpsFees } : {}),
      ...(positioned?.side === "long" || positioned?.side === "short"
        ? {
            entryPrice: positioned.entryPrice,
            positionSide: positioned.side,
            ...(positioned.openedAt != null ? { openedAt: positioned.openedAt } : {}),
          }
        : {}),
    });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildDonchianSvg({ pair, candles, strategy: this.params });
  }
}

function holdExtreme(
  side: "long" | "short",
  entryPrice: number,
  openedAt: Date | undefined,
  candles: Candle[],
  timeframe: Timeframe,
): number {
  let extreme = entryPrice;
  const intervalSec = candleIntervalSeconds(timeframe);
  const openedSec = openedAt != null ? openedAt.getTime() / 1000 : undefined;
  for (const candle of candles) {
    if (openedSec != null && intervalSec > 0 && candle.time + intervalSec <= openedSec) {
      continue;
    }
    extreme = side === "long" ? Math.max(extreme, candle.high) : Math.min(extreme, candle.low);
  }
  return extreme;
}

/**
 * False breakout: after `timeStopBars`, no later **close** has reached the
 * follow level. Wicks through the level do not count.
 * Long follow level is breakoutHigh − ATR; short is breakoutLow + ATR.
 * The breakout bar is the last candle that closed at or before the fill.
 */
function stalledBreakout(input: {
  side: "long" | "short";
  entryPrice: number;
  openedAt: Date | undefined;
  candles: Candle[];
  timeframe: Timeframe;
  atrNow: number;
  timeStopBars: number;
  at: Date;
}): { bestClose: number; extreme: number; followLevel: number } | null {
  if (
    input.entryPrice <= 0 ||
    input.timeStopBars <= 0 ||
    input.openedAt == null ||
    !(input.atrNow > 0)
  ) {
    return null;
  }

  const intervalSec = candleIntervalSeconds(input.timeframe);
  if (intervalSec <= 0) {
    return null;
  }

  const elapsedSec = Math.max(0, (input.at.getTime() - input.openedAt.getTime()) / 1000);
  const barsHeld = Math.floor(elapsedSec / intervalSec);
  if (barsHeld < input.timeStopBars) {
    return null;
  }

  const openedSec = input.openedAt.getTime() / 1000;
  let extreme: number | null = null;
  for (const candle of input.candles) {
    if (candle.time + intervalSec <= openedSec) {
      extreme = input.side === "long" ? candle.high : candle.low;
    }
  }
  if (extreme == null) {
    return null;
  }

  const followLevel = input.side === "long" ? extreme - input.atrNow : extreme + input.atrNow;
  let bestClose = input.side === "long" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (const candle of input.candles) {
    if (candle.time + intervalSec <= openedSec) {
      continue;
    }
    bestClose =
      input.side === "long" ? Math.max(bestClose, candle.close) : Math.min(bestClose, candle.close);
  }
  if (!Number.isFinite(bestClose)) {
    bestClose = input.entryPrice;
  }

  const followed = input.side === "long" ? bestClose >= followLevel : bestClose <= followLevel;
  if (followed) {
    return null;
  }
  return { bestClose, extreme, followLevel };
}

function gaveBackFromExtreme(input: {
  side: "long" | "short";
  givebackLockEntry: boolean;
  entryPrice: number;
  openedAt: Date | undefined;
  candles: Candle[];
  timeframe: Timeframe;
  atrNow: number;
  givebackAtrMult: number;
  givebackArmAtrMult: number;
  close: number;
  price: number;
}): { extreme: number; level: number } | null {
  if (input.entryPrice <= 0 || input.givebackAtrMult <= 0) {
    return null;
  }

  const extreme = holdExtreme(
    input.side,
    input.entryPrice,
    input.openedAt,
    input.candles,
    input.timeframe,
  );
  const advance = input.side === "long" ? extreme - input.entryPrice : input.entryPrice - extreme;
  if (advance < input.givebackArmAtrMult * input.atrNow) {
    return null;
  }
  const trail =
    input.side === "long"
      ? extreme - input.givebackAtrMult * input.atrNow
      : extreme + input.givebackAtrMult * input.atrNow;
  const armed = input.givebackArmAtrMult > 0 && input.givebackLockEntry;
  const level = armed
    ? input.side === "long"
      ? Math.max(trail, input.entryPrice)
      : Math.min(trail, input.entryPrice)
    : trail;
  const hit =
    input.side === "long"
      ? input.close <= level || input.price <= level
      : input.close >= level || input.price >= level;
  return hit ? { extreme, level } : null;
}

function fmt(n: number): string {
  return n.toFixed(4);
}
