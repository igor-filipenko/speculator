import { candleIntervalSeconds, timeframeFromMinutes } from "../../../market/candle.js";
import { applySearchPatch } from "../../../types.js";
import type {
  Candle,
  MarketIndicators,
  PerpsFees,
  PortfolioSnapshot,
  RequiredCandles,
  SearchSpace,
  Signal,
  Strategy,
  StrategyModule,
  StrategyParamPatch,
  Timeframe,
  Trend,
  Volatility,
} from "../../../types.js";
import { ema, macd } from "../../indicators.js";
import { buildMacdCrossoverSvg } from "./svg.js";

export interface MacdCrossoverParams {
  timeframe: Timeframe;
  /** MACD fast EMA length. */
  fastPeriod: number;
  /** MACD slow EMA length. Must be greater than `fastPeriod`. */
  slowPeriod: number;
  /** EMA length of the MACD line. The histogram is MACD minus this line. */
  signalPeriod: number;
  /** Fast price EWMA. Longs need it above `trendPeriod`; shorts need it below. */
  pricePeriod: number;
  /** Slow price EWMA. Direction of the fast average against this gates entries. */
  trendPeriod: number;
  /**
   * Which new entries are allowed.
   * 0 opens longs and shorts, 1 opens longs only, 2 opens shorts only.
   * An open position still closes on the histogram cross either way.
   */
  direction: number;
}

/** 4h MACD histogram with the fast price average against the slow one. Both sides. */
export function macdCrossoverParamsFor(): MacdCrossoverParams {
  return {
    timeframe: "4h",
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    pricePeriod: 2,
    trendPeriod: 200,
    direction: 1,
  };
}

/**
 * Decision knobs for `pnpm tune`. `pricePeriod` stays at 2: it is the price
 * smoother, not a separate signal. Levels are the MACD sets and timeframes
 * compared on the 4h crypto book, plus the trend length and side filter.
 */
export const MACD_CROSSOVER_SEARCH_SPACE: SearchSpace = {
  axes: [
    { key: "timeframe", levels: [240, 1440] },
    { key: "direction", levels: [0, 1, 2] },
    { key: "fastPeriod", levels: [8, 12, 19, 24] },
    { key: "slowPeriod", levels: [17, 26, 39, 52] },
    { key: "signalPeriod", levels: [9, 18] },
    { key: "trendPeriod", levels: [100, 150, 200] },
  ],
  accept(values) {
    const fast = values["fastPeriod"];
    const slow = values["slowPeriod"];
    if (fast !== undefined && slow !== undefined && !(fast < slow)) return false;
    const direction = values["direction"];
    if (direction !== undefined && direction !== 0 && direction !== 1 && direction !== 2) {
      return false;
    }
    return true;
  },
};

export interface MacdCrossoverInput {
  pair: string;
  candles: Candle[];
  strategy: MacdCrossoverParams;
  /** Spot price used in the signal (usually the exchange quote). */
  price: number;
  at?: Date;
  /** Open fill. The histogram crossing through zero closes this side. */
  entryPrice?: number;
  /** Which side `entryPrice` belongs to. */
  positionSide?: "long" | "short";
  /**
   * Perps open/close/borrow rates. Missing rates block a new short.
   * An open short still covers without them.
   */
  perpsFees?: PerpsFees;
}

/**
 * Bars of history kept for one evaluation.
 * The trend EMA needs several lengths so its SMA seed has decayed.
 */
const TREND_WARM_MULT = 3;

/**
 * Two-sided momentum on closed bars.
 * BUY when the MACD histogram is above zero and the price EWMA is above the
 * trend EWMA. SELL when the histogram is below zero and the price EWMA is
 * below the trend EWMA. `direction` 1 blocks new shorts and `direction` 2
 * blocks new longs. A new short also needs a perps fee schedule.
 * An open long sells when the histogram drops below zero, and an open short
 * buys when it rises above zero. The trend filter and `direction` do not
 * exit. No hard stop and no take-profit.
 */
export function evaluateMacdCrossover(input: MacdCrossoverInput): Signal {
  const at = input.at ?? new Date();
  const { pair, candles, strategy, price } = input;
  const signalCandles = closedSignalCandles(candles, at);
  const forming = candles[candles.length - 1];
  const closes = signalCandles.map((candle) => candle.close);
  const i = closes.length - 1;

  const meta: NonNullable<Signal["meta"]> = {};
  const rangeBar = forming ?? signalCandles[i];
  if (rangeBar != null) {
    meta.barLow = rangeBar.low;
    meta.barHigh = rangeBar.high;
  }

  const base = {
    pair,
    strategyId: "macd-crossover",
    price,
    at,
    meta,
    tpPrices: [] as number[],
    minRewardRisk: 0,
  };

  const invalid = invalidPeriods(strategy);
  if (invalid != null || i < 0) {
    return {
      ...base,
      side: "HOLD",
      reason: invalid ?? "Indicators not warm yet (need more candles)",
    };
  }

  const macdSeries = macd(closes, strategy.fastPeriod, strategy.slowPeriod, strategy.signalPeriod);
  const priceEma = ema(closes, strategy.pricePeriod);
  const trendEma = ema(closes, strategy.trendPeriod);
  const line = macdSeries.macd[i];
  const signal = macdSeries.signal[i];
  const histogram = macdSeries.histogram[i];
  const px = priceEma[i];
  const trend = trendEma[i];
  if (line != null) meta.macd = line;
  if (signal != null) meta.macdSignal = signal;
  if (histogram != null) meta.macdHist = histogram;
  if (px != null) meta.emaFast = px;
  if (trend != null) meta.emaSlow = trend;

  if (histogram == null || px == null || trend == null) {
    return { ...base, side: "HOLD", reason: "Indicators not warm yet (need more candles)" };
  }

  const positioned = input.entryPrice != null && input.entryPrice > 0;
  const long = input.positionSide === "long" && positioned;
  const short = input.positionSide === "short" && positioned;
  const allowLong = strategy.direction !== 2;
  const allowShort = strategy.direction !== 1;
  const uptrend = px > trend;
  const downtrend = px < trend;
  const levels =
    `histogram ${fmt(histogram)}, EMA${strategy.pricePeriod} ${fmt(px)}, ` +
    `EMA${strategy.trendPeriod} ${fmt(trend)}`;

  if (long && histogram < 0) {
    return { ...base, side: "SELL", reason: `MACD crossed down (${levels})` };
  }
  if (long) {
    return { ...base, side: "HOLD", reason: `Long holds (${levels})` };
  }
  if (short && histogram > 0) {
    return { ...base, side: "BUY", reason: `MACD crossed up (${levels})` };
  }
  if (short) {
    return { ...base, side: "HOLD", reason: `Short holds (${levels})` };
  }
  if (histogram > 0 && uptrend) {
    if (!allowLong) {
      return { ...base, side: "HOLD", reason: `MACD up ignored: short only (${levels})` };
    }
    return { ...base, side: "BUY", reason: `MACD up in uptrend (${levels})` };
  }
  if (histogram > 0) {
    return {
      ...base,
      side: "HOLD",
      reason: `MACD up ignored: EMA${strategy.pricePeriod} ${fmt(px)} <= EMA${strategy.trendPeriod} ${fmt(trend)}`,
    };
  }
  if (histogram < 0 && downtrend) {
    if (!allowShort) {
      return { ...base, side: "HOLD", reason: `MACD down ignored: long only (${levels})` };
    }
    if (input.perpsFees == null) {
      return { ...base, side: "HOLD", reason: "MACD down ignored: perps fee schedule missing" };
    }
    return { ...base, side: "SELL", reason: `MACD down in downtrend (${levels})` };
  }
  if (histogram < 0) {
    return {
      ...base,
      side: "HOLD",
      reason: `MACD down ignored: EMA${strategy.pricePeriod} ${fmt(px)} >= EMA${strategy.trendPeriod} ${fmt(trend)}`,
    };
  }
  return { ...base, side: "HOLD", reason: `Flat (${levels})` };
}

/** 4h MACD(12, 26, 9). Long above EMA200 with a positive histogram; short below it with a negative histogram. */
export class MacdCrossoverStrategy implements Strategy {
  readonly axes = MACD_CROSSOVER_SEARCH_SPACE.axes;
  private readonly params: MacdCrossoverParams;

  constructor(
    _trend: Trend = "flat",
    _volatility: Volatility = "low",
    params?: MacdCrossoverParams,
  ) {
    this.params = params ?? macdCrossoverParamsFor();
  }

  accept(values: Readonly<Record<string, number>>): boolean {
    return MACD_CROSSOVER_SEARCH_SPACE.accept?.(values) ?? true;
  }

  getSearchDefaults(): Readonly<Record<string, number>> {
    return searchDefaults(this.params);
  }

  paramPatch(values: Readonly<Record<string, number>>): StrategyParamPatch {
    const params = paramsFromSearch(values);
    const knobs: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === "timeframe" || value === undefined) continue;
      knobs[key] = value;
    }
    if (params.timeframe === undefined) return { values: knobs };
    return { timeframe: params.timeframe, values: knobs };
  }

  getDisplayName(): string {
    const { timeframe, fastPeriod, slowPeriod, signalPeriod, pricePeriod, trendPeriod, direction } =
      this.params;
    return `macd-crossover (${timeframe} MACD ${fastPeriod}/${slowPeriod}/${signalPeriod} EMA${pricePeriod}/${trendPeriod} ${directionName(direction)})`;
  }

  getId(): string {
    return "macd-crossover";
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, slowPeriod, signalPeriod, trendPeriod } = this.params;
    const warm = Math.max(trendPeriod * TREND_WARM_MULT, slowPeriod + signalPeriod + slowPeriod);
    return { timeframe, count: warm + 1 };
  }

  evaluateSignal(
    pair: string,
    candles: Candle[],
    _market: MarketIndicators,
    price: number,
    at: Date,
    portfolio?: PortfolioSnapshot,
    perpsFees?: PerpsFees,
  ): Signal {
    const position = portfolio?.position;
    const positioned =
      (position?.side === "long" || position?.side === "short") && position.entryPrice > 0
        ? position
        : undefined;
    return evaluateMacdCrossover({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
      ...(perpsFees !== undefined ? { perpsFees } : {}),
      ...(positioned?.side === "long" || positioned?.side === "short"
        ? { entryPrice: positioned.entryPrice, positionSide: positioned.side }
        : {}),
    });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildMacdCrossoverSvg({ pair, candles, strategy: this.params });
  }
}

function invalidPeriods(strategy: MacdCrossoverParams): string | null {
  const { fastPeriod, slowPeriod, signalPeriod, pricePeriod, trendPeriod } = strategy;
  if (fastPeriod < 1 || slowPeriod < 1 || signalPeriod < 1 || pricePeriod < 1 || trendPeriod < 1) {
    return "MACD periods must be >= 1";
  }
  if (fastPeriod >= slowPeriod) return "MACD fast period must be < slow period";
  if (pricePeriod >= trendPeriod) return "Price EMA must be shorter than the trend EMA";
  if (strategy.direction !== 0 && strategy.direction !== 1 && strategy.direction !== 2) {
    return "Direction must be 0 (both), 1 (long only), or 2 (short only)";
  }
  return null;
}

function directionName(direction: number): string {
  if (direction === 1) return "long";
  if (direction === 2) return "short";
  return "both";
}

function closedSignalCandles(candles: Candle[], at: Date): Candle[] {
  const forming = candles[candles.length - 1];
  if (forming == null || forming.isClosed(at.getTime() / 1000)) return candles;
  return candles.slice(0, -1);
}

function paramsFromSearch(values: Readonly<Record<string, number>>): Partial<MacdCrossoverParams> {
  const patch: Partial<MacdCrossoverParams> = {};
  const timeframe = values["timeframe"];
  const fastPeriod = values["fastPeriod"];
  const slowPeriod = values["slowPeriod"];
  const signalPeriod = values["signalPeriod"];
  const pricePeriod = values["pricePeriod"];
  const trendPeriod = values["trendPeriod"];
  const direction = values["direction"];
  if (timeframe !== undefined) {
    const label = timeframeFromMinutes(timeframe);
    if (label === undefined) throw new Error(`No timeframe for ${timeframe} minutes`);
    patch.timeframe = label;
  }
  if (fastPeriod !== undefined) patch.fastPeriod = fastPeriod;
  if (slowPeriod !== undefined) patch.slowPeriod = slowPeriod;
  if (signalPeriod !== undefined) patch.signalPeriod = signalPeriod;
  if (pricePeriod !== undefined) patch.pricePeriod = pricePeriod;
  if (trendPeriod !== undefined) patch.trendPeriod = trendPeriod;
  if (direction !== undefined) patch.direction = direction;
  return patch;
}

function searchDefaults(params: MacdCrossoverParams): Record<string, number> {
  const source: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "number") source[key] = value;
  }
  source["timeframe"] = candleIntervalSeconds(params.timeframe) / 60;
  return source;
}

function fmt(n: number): string {
  return n.toFixed(4);
}

export const strategyModule: StrategyModule = {
  id: "macd-crossover",
  create(trend, volatility, patch) {
    return new MacdCrossoverStrategy(
      trend,
      volatility,
      applySearchPatch(macdCrossoverParamsFor(), patch),
    );
  },
};
