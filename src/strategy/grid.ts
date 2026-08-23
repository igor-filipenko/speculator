import type {
  Candle,
  RequiredCandles,
  RiskParams,
  Signal,
  Snapshot,
  Strategy,
  Timeframe,
} from "../types.js";
import { buildGridSvg } from "./grid-svg.js";
import { adx, atr, ema } from "./indicators.js";

export interface GridParams {
  timeframe: Timeframe;
  atrPeriod: number;
  adxPeriod: number;
  /** Grid spacing = ATR * gridMult. Wider = fewer trades, bigger per-RT profit. */
  gridMult: number;
  /** Recalculate grid anchor every N bars (0 = every bar). */
  reanchorBars: number;
  /** BUY only when ADX <= this (flat regime gate). */
  adxMax: number;
  /** Trend EMA period; BUY only above it. */
  trendEmaPeriod: number;
}

const GRID_RISK: Omit<RiskParams, "timeframe"> = {
  atrStopMult: 2.5,
  atrTrailMult: 3,
  cooldownBars: 1,
  minHoldBars: 1,
};

export function gridParamsFor(): GridParams {
  return {
    timeframe: "15m",
    atrPeriod: 14,
    adxPeriod: 14,
    gridMult: 1.5,
    reanchorBars: 20,
    adxMax: 30,
    trendEmaPeriod: 20,
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

  const hold = (reason: string): Signal => ({
    pair,
    side: "HOLD",
    reason,
    price,
    at,
  });

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
    const target = entryPrice + gridSpacing;
    if (close >= target) {
      return {
        pair,
        side: "SELL",
        reason: `grid TP: close ${close.toFixed(4)} >= entry ${entryPrice.toFixed(4)} + spacing ${gridSpacing.toFixed(4)}`,
        price,
        at,
        meta,
      };
    }
    return hold(`long, waiting for TP, target ${target.toFixed(4)}, current ${close.toFixed(4)}`);
  }

  if (currentAdx != null && currentAdx > params.adxMax) {
    return hold(`ADX ${currentAdx.toFixed(1)} > ${params.adxMax}`);
  }

  if (currentTrendEma != null && close < currentTrendEma) {
    return hold(
      `below trend EMA, current ${close.toFixed(4)}, trend EMA ${currentTrendEma.toFixed(4)}`,
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

  constructor(params?: GridParams) {
    this.params = params ?? gridParamsFor();
    this.risk = { timeframe: this.params.timeframe, ...GRID_RISK };
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
