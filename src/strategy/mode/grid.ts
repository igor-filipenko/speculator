import { candleIntervalSeconds } from "../../market/gecko-terminal.js";
import type {
  Candle,
  MarketIndicators,
  PriceLevel,
  RequiredCandles,
  RiskParams,
  Signal,
  PortfolioSnapshot,
  Strategy,
  Timeframe,
  Trade,
  Trend,
  Volatility,
} from "../../types.js";
import { buildGridSvg } from "./grid-svg.js";
import { adx, atr } from "../indicators.js";

export interface GridParams {
  timeframe: Timeframe;
  atrPeriod: number;
  adxPeriod: number;
  /**
   * ATR multiplier for both grid spacing (entries) and the take-profit target.
   * Wider = fewer trades, bigger per-RT profit.
   */
  gridMult: number;
  /** Recalculate grid anchor every N bars (0 = every bar). */
  reanchorBars: number;
  /** BUY only when ADX <= this (flat regime gate). */
  adxMax: number;
  /** Skip a new long while close is within this many ATR of the last exit. */
  chaseAtrMult: number;
  /** Bars to skip BUY after an ATR stop/trail (0 = no skip). */
  atrReentryBars: number;
  /**
   * Reclaim only when the grid level is at/below the anchor and this many
   * ATR below the recent high. 0 = skip.
   */
  dipAtrMult: number;
  /**
   * Skip reclaim when the level is more than this many ATR below the recent
   * high (waterfall after a spike). 0 = skip.
   */
  maxDipAtrMult: number;
  /**
   * While long and HTF is not bullish, SELL if close falls back through the
   * reclaimed level, capped at entry − this many ATR (level can drift after
   * reanchor). 0 = skip. Bullish keeps the ATR stop as the only hard cut.
   */
  failReclaimAtrMult: number;
}

/** HTF trend × 1h vol → grid spacing / ADX gate. High vol widens; flat stays ≥ stop so TP ≥ risk. */
const GRID_MULT: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 8, low: 5, squeeze: 7, unknown: 6 },
  flat: { high: 6, low: 5, squeeze: 5, unknown: 5 },
  bearish: { high: 2, low: 2, squeeze: 2, unknown: 2 },
  unknown: { high: 2, low: 2, squeeze: 2, unknown: 2 },
};

/** Lower ADX cap in quiet bullish and in flat (skip a range that is already stretching). */
const ADX_MAX: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 30, low: 22, squeeze: 28, unknown: 28 },
  flat: { high: 22, low: 20, squeeze: 20, unknown: 20 },
  bearish: { high: 25, low: 25, squeeze: 25, unknown: 25 },
  unknown: { high: 25, low: 25, squeeze: 25, unknown: 25 },
};

/** Hard stop follows HTF trend only (vol is already in spacing / trail). */
const ATR_STOP: Record<Trend, number> = {
  bullish: 3,
  flat: 1.5,
  bearish: 1.5,
  unknown: 1.5,
};

/** Tight trail in bullish high/squeeze so a spike does not reverse through the whole TP. */
const ATR_TRAIL: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 6, low: 8, squeeze: 6, unknown: 8 },
  flat: { high: 8, low: 8, squeeze: 8, unknown: 8 },
  bearish: { high: 4, low: 4, squeeze: 4, unknown: 4 },
  unknown: { high: 4, low: 4, squeeze: 4, unknown: 4 },
};

export function gridParamsFor(trend: Trend, volatility: Volatility): GridParams {
  return {
    timeframe: "15m",
    atrPeriod: 14,
    adxPeriod: 14,
    gridMult: GRID_MULT[trend][volatility],
    reanchorBars: 40,
    adxMax: ADX_MAX[trend][volatility],
    chaseAtrMult: 0.5,
    /** 24h on 15m: skip the post-stop bounce, then trade again. */
    atrReentryBars: 96,
    dipAtrMult: 1.5,
    maxDipAtrMult: 2,
    failReclaimAtrMult: 0.75,
  };
}

function riskParamsFor(trend: Trend, volatility: Volatility): RiskParams {
  return {
    timeframe: "15m",
    atrStopMult: ATR_STOP[trend],
    atrTrailMult: ATR_TRAIL[trend][volatility],
    cooldownBars: 8,
    minHoldBars: 1,
  };
}

export interface GridSignalInput {
  pair: string;
  candles: Candle[];
  price: number;
  at: Date;
  params: GridParams;
  snapshot?: PortfolioSnapshot | undefined;
  market?: MarketIndicators;
}

export function evaluateGrid(input: GridSignalInput): Signal {
  const { pair, candles, price, at, params, snapshot, market } = input;

  const hold = (reason: string, meta?: NonNullable<Signal["meta"]>): Signal => {
    const signal: Signal = { pair, side: "HOLD", reason, price, at };
    if (meta !== undefined) {
      signal.meta = meta;
    }
    return signal;
  };

  if (candles.length < Math.max(params.reanchorBars, params.atrPeriod + 1, 2 * params.adxPeriod)) {
    return hold("warmup");
  }

  const atrSeries = atr(candles, params.atrPeriod);
  const currentAtr = atrSeries[atrSeries.length - 1];
  if (currentAtr == null || currentAtr <= 0) return hold("ATR not ready");

  const adxSeries = adx(candles, params.adxPeriod);
  const currentAdx = adxSeries[adxSeries.length - 1];

  const lastCandle = candles[candles.length - 1]!;
  const prevCandle = candles[candles.length - 2]!;
  const close = lastCandle.close;
  const prevClose = prevCandle.close;

  const sr = srBounds(market, close);
  const gridSpacing = currentAtr * params.gridMult;

  const anchorSlice = candles.slice(-params.reanchorBars);
  const referencePrice = anchorSlice.reduce((s, c) => s + c.close, 0) / anchorSlice.length;

  const meta: NonNullable<Signal["meta"]> = {
    atr: currentAtr,
    ...(currentAdx != null ? { adx: currentAdx } : {}),
    barLow: lastCandle.low,
    barHigh: lastCandle.high,
  };

  if (snapshot?.position.side === "long") {
    const entryPrice = snapshot.position.entryPrice;
    const target =
      sr.resistance != null
        ? Math.min(entryPrice + gridSpacing, sr.resistance)
        : entryPrice + gridSpacing;
    const tpSpacing = target - entryPrice;
    const barHigh = lastCandle.high;
    // Check intra-bar TP: bar high cleared the target even if close did not.
    // This prevents the ATR trail from stealing trades the price already won.
    const tpHit = close >= target || barHigh >= target;
    if (tpHit) {
      const hitIntraBar = barHigh >= target && close < target;
      return {
        pair,
        side: "SELL",
        reason: `grid TP: ${hitIntraBar ? "high" : "close"} ${(hitIntraBar ? barHigh : close).toFixed(4)} >= entry ${entryPrice.toFixed(4)} + spacing ${tpSpacing.toFixed(4)}`,
        price: hitIntraBar ? target : price,
        at,
        meta,
      };
    }
    if (params.failReclaimAtrMult > 0 && market?.trend !== "bullish") {
      const reclaimedLevel = clipGridLevel(
        findNearestGridLevelBelow(entryPrice, referencePrice, gridSpacing),
        sr,
      );
      const failCap = entryPrice - params.failReclaimAtrMult * currentAtr;
      const failLevel = Math.max(reclaimedLevel, failCap);
      if (close < failLevel) {
        return {
          pair,
          side: "SELL",
          reason: `grid fail reclaim: close ${close.toFixed(4)} < level ${failLevel.toFixed(4)}`,
          price,
          at,
          meta,
        };
      }
    }
    return hold(
      `long, waiting for TP, target ${target.toFixed(4)}, current ${close.toFixed(4)}`,
      meta,
    );
  }

  if (market != null && market.trend !== "bullish" && market.trend !== "flat") {
    return hold(`HTF trend ${market.trend}, skip grid entry`, meta);
  }

  const lastSell = lastSellTrade(snapshot);
  if (lastSell != null && inAtrReentrySkip(lastSell, at, params)) {
    return hold(`skip re-entry after ATR exit`, meta);
  }

  if (lastSell != null && lastSell.price > 0) {
    const chaseFloor = lastSell.price - params.chaseAtrMult * currentAtr;
    if (close >= chaseFloor) {
      const lastExitWasTp = lastSell.reason?.includes("TP") === true;
      if (market?.volatility === "squeeze" && lastExitWasTp) {
        return hold(
          `squeeze chase: close ${close.toFixed(4)} >= last exit ${lastSell.price.toFixed(4)} − ${params.chaseAtrMult}×ATR`,
          meta,
        );
      }
      if (market?.trend === "bullish" && market.volatility === "low") {
        return hold(
          `low-vol chase: close ${close.toFixed(4)} >= last exit ${lastSell.price.toFixed(4)} − ${params.chaseAtrMult}×ATR`,
          meta,
        );
      }
    }
  }

  if (currentAdx != null && currentAdx > params.adxMax) {
    return hold(`ADX ${currentAdx.toFixed(1)} > ${params.adxMax}`, meta);
  }

  const nearestLevelBelow = clipGridLevel(
    findNearestGridLevelBelow(close, referencePrice, gridSpacing),
    sr,
  );

  if (prevClose <= nearestLevelBelow && close > nearestLevelBelow) {
    if (params.dipAtrMult > 0 || params.maxDipAtrMult > 0) {
      const swingHigh = lookbackHigh(candles, params.reanchorBars);
      if (params.dipAtrMult > 0) {
        const highCeiling = swingHigh - params.dipAtrMult * currentAtr;
        if (nearestLevelBelow > referencePrice || nearestLevelBelow > highCeiling) {
          return hold(
            `no dip: level ${nearestLevelBelow.toFixed(4)} > anchor ${referencePrice.toFixed(4)} or high ${swingHigh.toFixed(4)} − ${params.dipAtrMult}×ATR`,
            meta,
          );
        }
      }
      if (params.maxDipAtrMult > 0) {
        const highFloor = swingHigh - params.maxDipAtrMult * currentAtr;
        if (nearestLevelBelow < highFloor) {
          return hold(
            `waterfall: level ${nearestLevelBelow.toFixed(4)} < high ${swingHigh.toFixed(4)} − ${params.maxDipAtrMult}×ATR`,
            meta,
          );
        }
      }
    }
    return {
      pair,
      side: "BUY",
      reason: `grid reclaim: ${close.toFixed(4)} crossed above level ${nearestLevelBelow.toFixed(4)}`,
      price,
      at,
      meta,
    };
  }

  return hold(
    `no grid level crossed, current ${close.toFixed(4)}, nearest level below ${nearestLevelBelow.toFixed(4)}`,
    meta,
  );
}

function lookbackHigh(candles: Candle[], lookback: number): number {
  const slice = lookback > 0 ? candles.slice(-lookback) : candles;
  let high = -Infinity;
  for (const candle of slice) {
    high = Math.max(high, candle.high);
  }
  return high;
}

interface SrBounds {
  support?: number;
  resistance?: number;
}

/** Nearest support below and resistance above `price` from HTF then 1h levels. */
function srBounds(market: MarketIndicators | undefined, price: number): SrBounds {
  const fromLevels = nearestSr(collectLevels(market), price);
  const support = fromLevels.support ?? market?.htf?.support ?? market?.mtf?.support;
  const resistance = fromLevels.resistance ?? market?.htf?.resistance ?? market?.mtf?.resistance;
  const bounds: SrBounds = {};
  if (support != null) {
    bounds.support = support;
  }
  if (resistance != null) {
    bounds.resistance = resistance;
  }
  return bounds;
}

function collectLevels(market: MarketIndicators | undefined): PriceLevel[] {
  if (market == null) {
    return [];
  }
  return [...(market.htf?.levels ?? []), ...(market.mtf?.levels ?? [])];
}

function nearestSr(levels: PriceLevel[], price: number): SrBounds {
  let support: number | undefined;
  let resistance: number | undefined;
  for (const level of levels) {
    if (level.kind === "support" && level.price < price) {
      if (support == null || level.price > support) {
        support = level.price;
      }
    }
    if (level.kind === "resistance" && level.price > price) {
      if (resistance == null || level.price < resistance) {
        resistance = level.price;
      }
    }
  }
  const bounds: SrBounds = {};
  if (support != null) {
    bounds.support = support;
  }
  if (resistance != null) {
    bounds.resistance = resistance;
  }
  return bounds;
}

function clipGridLevel(level: number, sr: SrBounds): number {
  let clipped = level;
  if (sr.support != null) {
    clipped = Math.max(clipped, sr.support);
  }
  if (sr.resistance != null) {
    clipped = Math.min(clipped, sr.resistance);
  }
  return clipped;
}

function findNearestGridLevelBelow(price: number, reference: number, spacing: number): number {
  const diff = price - reference;
  const levels = Math.floor(diff / spacing);
  return reference + levels * spacing;
}

function inAtrReentrySkip(lastSell: Trade, at: Date, params: GridParams): boolean {
  if (lastSell.reason?.startsWith("ATR") !== true || params.atrReentryBars <= 0) {
    return false;
  }
  const intervalSec = candleIntervalSeconds(params.timeframe);
  const elapsedSec = Math.max(0, (at.getTime() - lastSell.at.getTime()) / 1000);
  const barsSince = Math.floor(elapsedSec / intervalSec);
  return barsSince < params.atrReentryBars;
}

function lastSellTrade(snapshot: PortfolioSnapshot | undefined): Trade | undefined {
  if (snapshot == null) {
    return undefined;
  }
  for (let i = snapshot.trades.length - 1; i >= 0; i--) {
    const trade = snapshot.trades[i];
    if (trade?.side === "SELL") {
      return trade;
    }
  }
  return undefined;
}

export class GridStrategy implements Strategy {
  private readonly params: GridParams;
  private readonly risk: RiskParams;

  constructor(trend: Trend, volatility: Volatility) {
    this.params = gridParamsFor(trend, volatility);
    this.risk = riskParamsFor(trend, volatility);
  }

  getDisplayName(): string {
    return `Grid(ATR${this.params.atrPeriod}×${this.params.gridMult}, anchor${this.params.reanchorBars})`;
  }

  getMode(): "grid" {
    return "grid";
  }

  getRiskParams(): RiskParams {
    return this.risk;
  }

  getRequiredCandles(): RequiredCandles {
    const warmup = Math.max(
      this.params.reanchorBars,
      this.params.atrPeriod + 1,
      2 * this.params.adxPeriod,
    );
    return { timeframe: this.params.timeframe, count: warmup + 100 };
  }

  evaluateSignal(
    pair: string,
    candles: Candle[],
    market: MarketIndicators,
    price: number,
    at: Date,
    snapshot?: PortfolioSnapshot,
  ): Signal {
    return evaluateGrid({ pair, candles, price, at, params: this.params, snapshot, market });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildGridSvg({ pair, candles, strategy: this.params });
  }
}
