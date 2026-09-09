import type {
  Candle,
  MarketIndicators,
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
import { adx, atr, ema } from "../indicators.js";

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
  /** Trend EMA period; BUY only above it. */
  trendEmaPeriod: number;
}

/** HTF trend × 1h vol → grid spacing / ADX gate. High vol widens; squeeze stays medium. */
const GRID_MULT: Record<Trend, Record<Volatility, number>> = {
  bullish: { high: 8, low: 5, squeeze: 7, unknown: 6 },
  flat: { high: 4, low: 3, squeeze: 3, unknown: 3 },
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
  bullish: 4,
  flat: 4,
  bearish: 2.5,
  unknown: 2.5,
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
    trendEmaPeriod: 50,
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
  const closes = candles.map((c) => c.close);

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

  const trendEmaSeries = ema(closes, params.trendEmaPeriod);
  const currentTrendEma = trendEmaSeries[trendEmaSeries.length - 1];

  const gridSpacing = currentAtr * params.gridMult;

  const anchorSlice = closes.slice(-params.reanchorBars);
  const referencePrice = anchorSlice.reduce((s, v) => s + v, 0) / anchorSlice.length;

  const lastCandle = candles[candles.length - 1]!;
  const prevCandle = candles[candles.length - 2]!;
  const close = lastCandle.close;
  const prevClose = prevCandle.close;

  const meta: NonNullable<Signal["meta"]> = {
    atr: currentAtr,
    ...(currentAdx != null ? { adx: currentAdx } : {}),
    ...(currentTrendEma != null ? { trendEma: currentTrendEma } : {}),
    barLow: lastCandle.low,
    barHigh: lastCandle.high,
  };

  if (snapshot?.position.side === "long") {
    const entryPrice = snapshot.position.entryPrice;
    const tpSpacing = params.gridMult * currentAtr;
    const target = entryPrice + tpSpacing;
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
    return hold(
      `long, waiting for TP, target ${target.toFixed(4)}, current ${close.toFixed(4)}`,
      meta,
    );
  }

  if (market != null && market.trend !== "bullish" && market.trend !== "flat") {
    return hold(`HTF trend ${market.trend}, skip grid entry`, meta);
  }

  const lastSell = lastSellTrade(snapshot);
  if (lastSell?.reason?.startsWith("ATR") === true && market?.trend === "bullish") {
    return hold(`skip re-entry after ATR exit while HTF bullish`, meta);
  }

  if (lastSell != null && lastSell.price > 0 && close >= lastSell.price) {
    const lastExitWasTp = lastSell.reason?.includes("TP") === true;
    if (market?.volatility === "squeeze" && lastExitWasTp) {
      return hold(
        `squeeze chase: close ${close.toFixed(4)} >= last exit ${lastSell.price.toFixed(4)}`,
        meta,
      );
    }
    if (market?.trend === "bullish" && market.volatility === "low") {
      return hold(
        `low-vol chase: close ${close.toFixed(4)} >= last exit ${lastSell.price.toFixed(4)}`,
        meta,
      );
    }
  }

  if (currentAdx != null && currentAdx > params.adxMax) {
    return hold(`ADX ${currentAdx.toFixed(1)} > ${params.adxMax}`, meta);
  }

  if (currentTrendEma != null && close < currentTrendEma) {
    return hold(
      `below trend EMA, current ${close.toFixed(4)}, trend EMA ${currentTrendEma.toFixed(4)}`,
      meta,
    );
  }

  const nearestLevelBelow = findNearestGridLevelBelow(close, referencePrice, gridSpacing);

  if (prevClose <= nearestLevelBelow && close > nearestLevelBelow) {
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

function findNearestGridLevelBelow(price: number, reference: number, spacing: number): number {
  const diff = price - reference;
  const levels = Math.floor(diff / spacing);
  return reference + levels * spacing;
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
      this.params.trendEmaPeriod,
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
