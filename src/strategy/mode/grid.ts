import type {
  Candle,
  RequiredCandles,
  RiskParams,
  Signal,
  Snapshot,
  Strategy,
  Timeframe,
  Trend,
} from "../../types.js";
import { buildGridSvg } from "./grid-svg.js";
import { adx, atr, ema } from "../indicators.js";
import { match } from "ts-pattern";

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

function gridParamsFor(trend: Trend): GridParams {
  return {
    timeframe: "15m",
    atrPeriod: 14,
    adxPeriod: 14,
    gridMult: trend === "bullish" ? 8.0 : 2.0,
    reanchorBars: 40,
    adxMax: trend === "bullish" ? 30 : 25,
    trendEmaPeriod: 50,
  };
}

function riskParamsFor(trend: Trend): RiskParams {
  const atrStopMult = match(trend)
    .with("bullish", () => 4)
    .with("flat", () => 4)
    .with("bearish", () => 2.5)
    .with("unknown", () => 2.5)
    .exhaustive();
  const atrTrailMult = match(trend)
    .with("bullish", () => 8)
    .with("flat", () => 8)
    .with("bearish", () => 4)
    .with("unknown", () => 4)
    .exhaustive();
  return {
    timeframe: "15m",
    atrStopMult,
    atrTrailMult,
    cooldownBars: 3,
    minHoldBars: 1,  
  };
}

export interface GridSignalInput {
  pair: string;
  candles: Candle[];
  price: number;
  at: Date;
  params: GridParams;
  snapshot?: Snapshot | undefined;
}

export function evaluateGrid(input: GridSignalInput): Signal {
  const { pair, candles, price, at, params, snapshot } = input;
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

export class GridStrategy implements Strategy {
  private readonly params: GridParams;
  private readonly risk: RiskParams;

  constructor(trend: Trend) {
    this.params = gridParamsFor(trend);
    this.risk = riskParamsFor(trend);
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
    price: number,
    at: Date,
    snapshot?: Snapshot,
  ): Signal {
    return evaluateGrid({ pair, candles, price, at, params: this.params, snapshot });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildGridSvg({ pair, candles, strategy: this.params });
  }
}
