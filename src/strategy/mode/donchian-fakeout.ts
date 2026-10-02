import { candleIntervalSeconds, isCandleClosed } from "../../market/gecko-terminal.js";
import type {
  Candle,
  MarketIndicators,
  PortfolioSnapshot,
  Position,
  RequiredCandles,
  RiskParams,
  Signal,
  SignalSide,
  Strategy,
  Timeframe,
  Trend,
  Volatility,
} from "../../types.js";
import { atr, donchian, sma } from "../indicators.js";
import { buildDonchianSvg } from "./donchian-svg.js";

export interface DonchianFakeoutParams {
  timeframe: Timeframe;
  /** N-bar Donchian channel whose prior upper band is the breakout level. */
  entryPeriod: number;
  /** SMA lookback on volume (bars before the breakout bar). */
  volumeSmaPeriod: number;
  /** Breakout bar volume must exceed this × volume SMA (a real push that traps longs). */
  breakoutVolumeSmaMult: number;
  /** Rejection bar volume must be at least this × volume SMA (sellers stepped in). */
  rejectVolumeSmaMult: number;
  /** Wilder ATR period (stop sizing and risk trail). */
  atrPeriod: number;
  /** Stop sits this many ATR above the breakout's local high. */
  stopBufferAtrMult: number;
  /** Skip setups whose stop is closer than this many ATR to the entry (noise stops). */
  minStopAtrMult: number;
  /** Skip setups whose stop is farther than this many ATR from the entry (poor risk). */
  maxStopAtrMult: number;
  /** Cover when price returns to the Donchian midline. */
  exitAtMid: boolean;
  /** Cover after this many bars without a stop or target. 0 = off. */
  maxHoldBars: number;
}

/** Signal-side params for HTF `trend` × 1h `volatility` (defaults: flat / low). */
export function donchianFakeoutParamsFor(
  _trend: Trend = "flat",
  _volatility: Volatility = "low",
): DonchianFakeoutParams {
  return {
    timeframe: "15m",
    entryPeriod: 20,
    volumeSmaPeriod: 20,
    breakoutVolumeSmaMult: 1.0,
    rejectVolumeSmaMult: 1.0,
    atrPeriod: 14,
    stopBufferAtrMult: 0.1,
    minStopAtrMult: 0.3,
    maxStopAtrMult: 2,
    exitAtMid: true,
    maxHoldBars: 16,
  };
}

function riskParamsFor(): RiskParams {
  return {
    timeframe: "15m",
    /** Fallback only; the structure stop above the breakout high replaces it. */
    atrStopMult: 3,
    /** Locks in the reversion once price has dropped away from the entry. */
    atrTrailMult: 2.5,
    cooldownBars: 8,
    minHoldBars: 0,
  };
}

export interface DonchianFakeoutInput {
  pair: string;
  candles: Candle[];
  strategy: DonchianFakeoutParams;
  /** Spot price used in the signal (usually exchange quote). */
  price: number;
  at?: Date;
  /** Current position; the strategy only opens shorts and covers them. */
  position?: Pick<Position, "side" | "openedAt">;
}

interface SetupAnchor {
  /** Entry-channel high before the breakout bar. */
  level: number;
  /** Entry-channel midline before the breakout bar (take-profit target). */
  target: number;
  /** Local max of the breakout (highs of bars B and C). */
  breakoutHigh: number;
  /** Wilder ATR at the rejection bar C. */
  atr: number;
  /** Volume SMA before the breakout bar. */
  volumeSma: number;
}

/**
 * Counter-trend Donchian fakeout (short only).
 *
 * Setup on two **closed** bars: bar B closes above the prior entry-period high on
 * volume > k × SMA, then bar C closes back under that level with volume at least
 * m × SMA. SELL opens a short at the next tick (a forming bar is ignored).
 *
 * The stop sits above the breakout's local high (max of B and C highs plus a small ATR
 * buffer) and is passed to the risk manager as `meta.shortStopPrice`. The short is
 * covered (BUY) at the pre-breakout channel midline or after `maxHoldBars`. While a
 * short is open the setup is rebuilt from `openedAt`, so stop and target do not drift.
 */
export function evaluateDonchianFakeout(input: DonchianFakeoutInput): Signal {
  const { pair, candles, strategy, price } = input;
  const at = input.at ?? new Date();
  const forming = candles[candles.length - 1];
  const lastIsClosed =
    forming != null && isCandleClosed(forming, at.getTime() / 1000, strategy.timeframe);
  const signalCandles = lastIsClosed || forming == null ? candles : candles.slice(0, -1);
  const volumes = signalCandles.map((c) => c.volume);

  const channel = donchian(signalCandles, strategy.entryPeriod);
  const volumeSmaSeries = sma(volumes, strategy.volumeSmaPeriod);
  const atrSeries = atr(signalCandles, strategy.atrPeriod);

  const anchorAt = (c: number): SetupAnchor | null => {
    const barB = signalCandles[c - 1];
    const barC = signalCandles[c];
    const level = c >= 2 ? channel.upper[c - 2] : null;
    const target = c >= 2 ? channel.mid[c - 2] : null;
    const volumeSma = c >= 2 ? volumeSmaSeries[c - 2] : null;
    const atrC = c >= 0 ? atrSeries[c] : null;
    if (
      barB == null ||
      barC == null ||
      level == null ||
      target == null ||
      volumeSma == null ||
      atrC == null ||
      !(atrC > 0)
    ) {
      return null;
    }
    return {
      level,
      target,
      breakoutHigh: Math.max(barB.high, barC.high),
      atr: atrC,
      volumeSma,
    };
  };

  const i = signalCandles.length - 1;
  const barC = signalCandles[i];
  const atrNow = i >= 0 ? atrSeries[i] : null;

  const meta: NonNullable<Signal["meta"]> = {};
  if (atrNow != null) meta.atr = atrNow;
  const rangeBar = forming ?? barC;
  if (rangeBar != null) {
    meta.barLow = rangeBar.low;
    meta.barHigh = rangeBar.high;
  }

  const base = { pair, price, at, meta };
  const hold = (reason: string): Signal => ({ ...base, side: "HOLD", reason });
  const position = input.position;

  if (position?.side === "short") {
    const anchor = anchorAt(openedSetupIndex(signalCandles, position.openedAt, strategy));
    if (anchor != null) {
      meta.donchianUpper = anchor.level;
      meta.donchianMid = anchor.target;
      meta.shortStopPrice = anchor.breakoutHigh + strategy.stopBufferAtrMult * anchor.atr;
    }
    return coverSignal({ base, strategy, position, target: anchor?.target ?? null, hold });
  }
  if (position != null && position.side !== "flat") {
    return hold("Long open: fakeout strategy only trades shorts");
  }

  const anchor = anchorAt(i);
  if (anchor == null || barC == null || atrNow == null) {
    return hold("Indicators not warm yet (warmup, need more candles)");
  }
  meta.donchianUpper = anchor.level;
  meta.donchianMid = anchor.target;
  meta.volumeSma = anchor.volumeSma;

  const barB = signalCandles[i - 1]!;
  const setup = detectFakeout({ barB, barC, anchor, price, strategy });
  if (setup.kind === "none") {
    return hold(setup.reason);
  }

  meta.shortStopPrice = setup.stop;
  return {
    ...base,
    side: "SELL",
    reason:
      `Donchian fakeout: bar closed ${fmt(barB.close)} > ${fmt(anchor.level)} (vol ${fmt(barB.volume)} > ` +
      `${fmt(strategy.breakoutVolumeSmaMult * anchor.volumeSma)}), next closed ${fmt(barC.close)} < ${fmt(anchor.level)} ` +
      `(vol ${fmt(barC.volume)} ≥ ${fmt(strategy.rejectVolumeSmaMult * anchor.volumeSma)}); ` +
      `stop ${fmt(setup.stop)} (breakout high ${fmt(anchor.breakoutHigh)} + ${strategy.stopBufferAtrMult}×ATR), ` +
      `target ${fmt(anchor.target)}`,
  };
}

type Setup = { kind: "none"; reason: string } | { kind: "short"; stop: number };

function detectFakeout(input: {
  barB: Candle;
  barC: Candle;
  anchor: SetupAnchor;
  price: number;
  strategy: DonchianFakeoutParams;
}): Setup {
  const { barB, barC, anchor, price, strategy } = input;
  const { level, volumeSma, atr: atrC } = anchor;
  const none = (reason: string): Setup => ({ kind: "none", reason });

  if (!(barB.close > level)) {
    return none(`No fakeout: prior bar close ${fmt(barB.close)} did not break ${fmt(level)}`);
  }
  if (!(barC.close < level)) {
    return none(`No fakeout: close ${fmt(barC.close)} did not return under ${fmt(level)}`);
  }
  const breakoutVolumeMin = strategy.breakoutVolumeSmaMult * volumeSma;
  if (!(barB.volume > breakoutVolumeMin)) {
    return none(
      `Fakeout ignored: breakout volume ${fmt(barB.volume)} <= ${fmt(breakoutVolumeMin)} ` +
        `(${strategy.breakoutVolumeSmaMult}× SMA ${fmt(volumeSma)})`,
    );
  }
  const rejectVolumeMin = strategy.rejectVolumeSmaMult * volumeSma;
  if (!(barC.volume >= rejectVolumeMin)) {
    return none(
      `Fakeout ignored: rejection volume ${fmt(barC.volume)} < ${fmt(rejectVolumeMin)} ` +
        `(${strategy.rejectVolumeSmaMult}× SMA ${fmt(volumeSma)})`,
    );
  }
  if (!(price < level)) {
    return none(`Fakeout ignored: price ${fmt(price)} is back above level ${fmt(level)}`);
  }
  if (strategy.exitAtMid && !(price > anchor.target)) {
    return none(`Fakeout ignored: price ${fmt(price)} already at target ${fmt(anchor.target)}`);
  }

  const stop = anchor.breakoutHigh + strategy.stopBufferAtrMult * atrC;
  const stopDistance = stop - price;
  const minDistance = strategy.minStopAtrMult * atrC;
  const maxDistance = strategy.maxStopAtrMult * atrC;
  if (stopDistance < minDistance) {
    return none(
      `Fakeout ignored: stop distance ${fmt(stopDistance)} < ${fmt(minDistance)} (${strategy.minStopAtrMult}×ATR)`,
    );
  }
  if (stopDistance > maxDistance) {
    return none(
      `Fakeout ignored: stop distance ${fmt(stopDistance)} > ${fmt(maxDistance)} (${strategy.maxStopAtrMult}×ATR)`,
    );
  }
  return { kind: "short", stop };
}

function coverSignal(input: {
  base: { pair: string; price: number; at: Date; meta: NonNullable<Signal["meta"]> };
  strategy: DonchianFakeoutParams;
  position: Pick<Position, "side" | "openedAt">;
  target: number | null;
  hold: (reason: string) => Signal;
}): Signal {
  const { base, strategy, position, target } = input;
  const { price } = base;

  if (strategy.exitAtMid && target != null && price <= target) {
    // A resting target fills at the midline, not at a lower tick (conservative in replay).
    return cover(
      { ...base, price: target },
      `Take profit: price ${fmt(price)} reached channel mid ${fmt(target)}`,
    );
  }

  const intervalSec = candleIntervalSeconds(strategy.timeframe);
  if (strategy.maxHoldBars > 0 && position.openedAt != null && intervalSec > 0) {
    const elapsedSec = Math.max(0, (base.at.getTime() - position.openedAt.getTime()) / 1000);
    const barsHeld = Math.floor(elapsedSec / intervalSec);
    if (barsHeld >= strategy.maxHoldBars) {
      return cover(base, `Time stop: short held ${barsHeld} bars (max ${strategy.maxHoldBars})`);
    }
  }

  return input.hold("Short open (waiting for target, stop or time stop)");
}

function cover(
  base: { pair: string; price: number; at: Date; meta: NonNullable<Signal["meta"]> },
  reason: string,
): Signal {
  const side: SignalSide = "BUY";
  return { ...base, side, reason };
}

/** Index of the rejection bar C: the last candle that closed at or before the fill. */
function openedSetupIndex(
  candles: Candle[],
  openedAt: Date | undefined,
  strategy: DonchianFakeoutParams,
): number {
  const intervalSec = candleIntervalSeconds(strategy.timeframe);
  if (openedAt == null || !(intervalSec > 0)) {
    return -1;
  }
  const openedSec = openedAt.getTime() / 1000;
  for (let k = candles.length - 1; k >= 0; k--) {
    if (candles[k]!.time + intervalSec <= openedSec) {
      return k;
    }
  }
  return -1;
}

/** 15m counter-trend Donchian fakeout: short after a volume breakout closes back under the level; stop above the breakout high. */
export class DonchianFakeoutStrategy implements Strategy {
  private readonly params: DonchianFakeoutParams;
  private readonly risk: RiskParams;

  constructor(_trend: Trend = "flat", _volatility: Volatility = "low") {
    this.params = donchianFakeoutParamsFor(_trend, _volatility);
    this.risk = riskParamsFor();
  }

  getDisplayName(): string {
    const {
      timeframe,
      entryPeriod,
      volumeSmaPeriod,
      breakoutVolumeSmaMult,
      rejectVolumeSmaMult,
      stopBufferAtrMult,
      maxHoldBars,
    } = this.params;
    return (
      `donchian-fakeout (${timeframe} DC${entryPeriod} brkVol×${breakoutVolumeSmaMult.toFixed(1)} ` +
      `rejVol×${rejectVolumeSmaMult.toFixed(1)} SMA${volumeSmaPeriod} stop hi+${stopBufferAtrMult}ATR ` +
      `tStop${maxHoldBars})`
    );
  }

  getMode(): "donchian-fakeout" {
    return "donchian-fakeout";
  }

  getRiskParams(): RiskParams {
    return this.risk;
  }

  getRequiredCandles(): RequiredCandles {
    const { timeframe, entryPeriod, volumeSmaPeriod, atrPeriod } = this.params;
    const warm = Math.max(entryPeriod + 2, volumeSmaPeriod + 2, atrPeriod + 2) + 20;
    return { timeframe, count: Math.min(warm, 100) };
  }

  evaluateSignal(
    pair: string,
    candles: Candle[],
    _market: MarketIndicators,
    price: number,
    at: Date,
    snapshot?: PortfolioSnapshot,
  ): Signal {
    const position = snapshot?.position;
    return evaluateDonchianFakeout({
      pair,
      candles,
      strategy: this.params,
      price,
      at,
      ...(position != null ? { position } : {}),
    });
  }

  buildChartSvg(pair: string, candles: Candle[]): string {
    return buildDonchianSvg({
      pair,
      candles,
      strategy: {
        timeframe: this.params.timeframe,
        entryPeriod: this.params.entryPeriod,
        exitPeriod: this.params.entryPeriod,
        volumeSmaPeriod: this.params.volumeSmaPeriod,
        volumeSmaMult: this.params.breakoutVolumeSmaMult,
      },
    });
  }
}

function fmt(n: number): string {
  return n.toFixed(4);
}
