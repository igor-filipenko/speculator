import type { BollingerParams, Candle, Signal, SignalSide } from "../types.js";
import { adx, atr, bollinger, ema } from "./indicators.js";

export interface BollingerInput {
  pair: string;
  candles: Candle[];
  strategy: BollingerParams;
  /** Spot price used in the signal (usually exchange quote). */
  price: number;
  at?: Date;
}

/**
 * Mean-reversion Bollinger for flat markets.
 * BUY on lower-band **reclaim** (prev close ≤ lower, close > lower) when:
 * ADX ≤ adxMax, close > trend EMA, and (mid − lower) / close ≥ minBandToMidPct.
 * SELL when close ≥ middle (SMA basis). ADX does not block exits.
 */
export function evaluateBollinger(input: BollingerInput): Signal {
  const { pair, candles, strategy, price } = input;
  const at = input.at ?? new Date();
  const closes = candles.map((c) => c.close);

  const bands = bollinger(closes, strategy.period, strategy.stdDev);
  const trendSeries = ema(closes, strategy.trendEmaPeriod);
  const atrSeries = atr(candles, strategy.atrPeriod);
  const adxSeries = adx(candles, strategy.adxPeriod);

  const i = closes.length - 1;
  const prev = i - 1;
  const bbMid = bands.mid[i];
  const bbUpper = bands.upper[i];
  const bbLower = bands.lower[i];
  const bbLowerPrev = prev >= 0 ? bands.lower[prev] : null;
  const trendEma = trendSeries[i];
  const atrNow = atrSeries[i];
  const adxNow = adxSeries[i];
  const lastBar = candles[i];

  const meta: NonNullable<Signal["meta"]> = {};
  if (bbMid != null) meta.bbMid = bbMid;
  if (bbUpper != null) meta.bbUpper = bbUpper;
  if (bbLower != null) meta.bbLower = bbLower;
  if (trendEma != null) meta.trendEma = trendEma;
  if (atrNow != null) meta.atr = atrNow;
  if (adxNow != null) meta.adx = adxNow;
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
    bbMid == null ||
    bbUpper == null ||
    bbLower == null ||
    bbLowerPrev == null ||
    trendEma == null ||
    adxNow == null ||
    prev < 0
  ) {
    return {
      ...base,
      side: "HOLD",
      reason: "Indicators not warm yet (need more candles)",
    };
  }

  const close = closes[i]!;
  const closePrev = closes[prev]!;
  const bandToMidPct = (bbMid - bbLower) / close;
  const reclaimedLower = closePrev <= bbLowerPrev && close > bbLower;

  let side: SignalSide = "HOLD";
  let reason = `No BB signal (close=${fmt(close)}, lower=${fmt(bbLower)}, mid=${fmt(bbMid)}, upper=${fmt(bbUpper)}, ADX=${fmt(adxNow)})`;

  if (reclaimedLower) {
    if (adxNow > strategy.adxMax) {
      reason = `Lower reclaim ignored: ADX ${fmt(adxNow)} > ${strategy.adxMax} (not flat)`;
    } else if (close <= trendEma) {
      reason = `Lower reclaim ignored: close ${fmt(close)} <= trend EMA${strategy.trendEmaPeriod} ${fmt(trendEma)}`;
    } else if (bandToMidPct < strategy.minBandToMidPct) {
      reason = `Lower reclaim ignored: band→mid ${pct(bandToMidPct)} < min ${pct(strategy.minBandToMidPct)}`;
    } else {
      side = "BUY";
      reason =
        `Reclaimed lower BB (prev ${fmt(closePrev)} ≤ ${fmt(bbLowerPrev)}, close ${fmt(close)} > ${fmt(bbLower)}); ` +
        `ADX ${fmt(adxNow)} <= ${strategy.adxMax}; close > trend EMA; band→mid ${pct(bandToMidPct)}`;
    }
  } else if (close >= bbMid) {
    side = "SELL";
    reason = `Close ${fmt(close)} >= BB mid ${fmt(bbMid)}`;
  }

  if (side == "HOLD")
    console.log(`HOLD: ${reason}`);
  return { ...base, side, reason };
}

function fmt(n: number): string {
  return n.toFixed(4);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}
