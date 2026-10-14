import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandle } from "../../market/candle.js";
import type { Candle, MarketIndicators, Trend, Volatility } from "../../types.js";
import { TIER_COSTS } from "../../exchange/emulated/emulated-quote.js";
import {
  evaluateBollinger,
  BollingerStrategy,
  bollingerNetReward,
  bollingerParamsFor,
  bollingerStopPrice,
  isAdxTrendAgainst,
  type BollingerInput,
  type BollingerParams,
} from "./bollinger.js";
import { rsi } from "../indicators.js";

function baseParams(overrides: Partial<BollingerParams> = {}): BollingerParams {
  return { ...bollingerParamsFor(), ...overrides };
}

/** Loose filters so fixtures still fire BUY/SELL without the live oversold/ADX gates. */
function looseFilters(overrides: Partial<BollingerParams> = {}): BollingerParams {
  return baseParams({
    period: 10,
    stdDev: 2,
    atrPeriod: 5,
    adxPeriod: 5,
    adxMax: 100,
    minReclaimDepth: 0,
    rsiPeriod: 5,
    rsiBuyMax: 100,
    minRewardRisk: 0,
    ...overrides,
  });
}

function bar(time: number, close: number, range = 0.2): Candle {
  return createCandle({
    time,
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume: 10,
  });
}

const INTERVAL = 4 * 60 * 60;

/**
 * Flat range, pierce lower, then reclaim still below a typical mid.
 */
function reclaimLowerBand(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    const price = 100 + ((i % 6) - 2.5) * 0.35;
    candles.push(bar(start + i * INTERVAL, price, 0.25));
  }
  const t = start + 50 * INTERVAL;
  // Pierce lower band hard so std widens, then reclaim below mid (~99.6).
  candles.push(bar(t, 96.5, 0.5));
  candles.push(bar(t + INTERVAL, 99.0, 0.3));
  return candles;
}

/** Same pierce as reclaim fixture but ends still below lower (no reclaim). */
function stuckBelowLower(): Candle[] {
  const candles = reclaimLowerBand();
  candles.pop();
  return candles;
}

/** Flat range, pierce upper, then reject still above a typical mid. */
function rejectUpperBand(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    const price = 100 + ((i % 6) - 2.5) * 0.35;
    candles.push(bar(start + i * INTERVAL, price, 0.25));
  }
  const t = start + 50 * INTERVAL;
  candles.push(bar(t, 103.5, 0.5));
  candles.push(bar(t + INTERVAL, 101.0, 0.3));
  return candles;
}

/** Filters loose enough that only the ADX gate can block this wick. */
function rejectionFilters(overrides: Partial<BollingerParams> = {}): BollingerParams {
  return baseParams({
    minReclaimDepth: 0,
    rsiBuyMax: 100,
    minRewardRisk: 0,
    ...overrides,
  });
}

/**
 * Trend, then a tight range so the band catches price, then a red wick
 * through the upper band with the close still above the mid.
 */
function trendThenUpperWick(direction: "up" | "down"): Candle[] {
  const start = 1_700_000_000;
  const interval = 15 * 60;
  const candles: Candle[] = [];
  let price = direction === "down" ? 150 : 50;
  const step = direction === "down" ? -1.1 : 1.1;
  for (let i = 0; i < 40; i++) {
    const open = price;
    price += step;
    const close = price;
    candles.push(
      createCandle({
        time: start + candles.length * interval,
        open,
        high: Math.max(open, close) + 0.05,
        low: Math.min(open, close) - 0.15,
        close,
        volume: 10,
      }),
    );
  }
  let px = price;
  for (let i = 0; i < 16; i++) {
    const open = px;
    const close = px + (i % 2 === 0 ? -0.35 : 0.35);
    px = close;
    candles.push(
      createCandle({
        time: start + candles.length * interval,
        open,
        high: Math.max(open, close) + 0.05,
        low: Math.min(open, close) - 0.05,
        close,
        volume: 10,
      }),
    );
  }
  const base = candles[candles.length - 1]!.close;
  const t = candles[candles.length - 1]!.time;
  candles.push(
    createCandle({
      time: t + interval,
      open: base + 0.8,
      high: base + 2.5,
      low: base - 0.2,
      close: base,
      volume: 10,
    }),
  );
  return candles;
}

/** Flat series ending near/above the middle of the band. */
function reboundToMid(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const price = 100 + ((i % 4) - 1.5) * 0.2;
    candles.push(bar(start + i * INTERVAL, price, 0.15));
  }
  candles.push(bar(start + 40 * INTERVAL, 100.4, 0.15));
  return candles;
}

/** Same-bar hammer: wick through lower, close back inside (prev close stayed in range). */
function wickReclaimLower(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    const price = 100 + ((i % 6) - 2.5) * 0.35;
    candles.push(bar(start + i * INTERVAL, price, 0.25));
  }
  const t = start + 50 * INTERVAL;
  candles.push(
    createCandle({
      time: t,
      open: 98.9,
      high: 99.3,
      low: 96.6,
      close: 99.2,
      volume: 10,
    }),
  );
  return candles;
}

function marketState(
  trend: MarketIndicators["trend"],
  volatility: MarketIndicators["volatility"],
  price: number,
): MarketIndicators {
  return { pair: "SOL/USDC", price, trend, volatility };
}

function evalBb(
  input: Omit<BollingerInput, "trend" | "volatility"> & {
    trend?: Trend;
    volatility?: Volatility;
  },
) {
  return evaluateBollinger({ trend: "flat", volatility: "low", ...input });
}

describe("evaluateBollinger filters", () => {
  it("emits BUY on lower-band reclaim when filters pass", () => {
    const candles = reclaimLowerBand();
    const strategy = looseFilters();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /Lower BB close reclaim/i);
    assert.ok(signal.meta?.bbLower != null);
    assert.ok(signal.meta?.atr != null);
    assert.ok(signal.meta?.rsi != null);
    const mid = signal.meta?.bbMid;
    assert.ok(mid != null && mid > signal.price);
    assert.deepEqual(signal.tpPrices, [mid]);
    assert.equal(signal.minRewardRisk, 0);
    assert.equal(bollingerParamsFor().minRewardRisk, 0.2);
  });

  it("does not pyramid when already long below mid", () => {
    const candles = reclaimLowerBand();
    const last = candles[candles.length - 1]!;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
      entryPrice: last.close * 0.99,
    });
    assert.ok(signal.meta?.bbMid != null);
    assert.ok(last.close < signal.meta.bbMid);
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /Waiting for profitable price/);
  });

  it("does not BUY while still below lower (no reclaim)", () => {
    const candles = stuckBelowLower();
    const strategy = looseFilters();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD");
  });

  it("ignores reclaim when ADX exceeds adxMax", () => {
    const candles = reclaimLowerBand();
    const strategy = looseFilters({ adxMax: 0 });
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /ADX .+ > 0/);
  });

  it("shorts an upper rejection when ADX is at or below adxMax", () => {
    const candles = trendThenUpperWick("down");
    const last = candles[candles.length - 1]!;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: rejectionFilters({ adxMax: 100 }),
      // The wick closes only a tick above the mid; the quote has to sit further
      // out or round-trip fees consume the reward.
      price: last.close + 0.5,
      at: new Date((last.time + 15 * 60) * 1000),
      perpsFees: { openFeePct: 0.0006, closeFeePct: 0.0006, borrowFeePctPerHour: 0.000007 },
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /ADX .+ <= 100/);
  });

  it("ignores an upper rejection when ADX exceeds adxMax", () => {
    const candles = trendThenUpperWick("up");
    const last = candles[candles.length - 1]!;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: rejectionFilters({ adxMax: 0 }),
      price: last.close,
      at: new Date((last.time + 15 * 60) * 1000),
      perpsFees: { openFeePct: 0.0006, closeFeePct: 0.0006, borrowFeePctPerHour: 0.000007 },
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /Upper rejection ignored: ADX .+ > 0/);
  });

  it("holds a reclaim when fees consume the move to the mid", () => {
    const candles = reclaimLowerBand();
    const last = candles[candles.length - 1]!;
    const probe = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ minRewardRisk: 0 }),
      price: last.close,
    });
    const mid = probe.meta?.bbMid;
    assert.ok(mid != null && mid > last.close);
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ minRewardRisk: 0 }),
      price: mid * (1 - 0.0001),
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /reward .* <= 0 after fees/);
  });

  it("holds a reclaim when fee-adjusted reward:risk is below minRewardRisk", () => {
    const candles = reclaimLowerBand();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ minRewardRisk: 100 }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /reward:risk .* < 100/);
  });

  it("decreases reward by both legs of fees", () => {
    const spot = TIER_COSTS.liquid.slippage + TIER_COSTS.liquid.poolFee;
    const long = bollingerNetReward({ side: "long", price: 100, tp: 101, pair: "SOL/USDC" });
    assert.equal(long, 101 * (1 - spot) - 100 * (1 + spot));

    const slip = TIER_COSTS.liquid.slippage;
    const short = bollingerNetReward({
      side: "short",
      price: 100,
      tp: 99,
      pair: "SOL/USDC",
      perpsFees: { openFeePct: 0.01, closeFeePct: 0.02, borrowFeePctPerHour: 0.5 },
    });
    assert.equal(short, 100 * (1 - slip - 0.01 - 0.02) - 99 * (1 + slip));
    assert.equal(bollingerNetReward({ side: "short", price: 100, tp: 99, pair: "SOL/USDC" }), null);
  });

  it("emits SELL when long and price reaches max(mid, minExit)", () => {
    const candles = reboundToMid();
    const strategy = looseFilters();
    const last = candles[candles.length - 1]!;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: last.close,
      entryPrice: last.close * 0.98,
    });
    assert.ok(signal.meta?.bbMid != null);
    assert.ok(last.close >= signal.meta.bbMid);
    assert.equal(signal.side, "SELL");
    assert.match(signal.reason, /Price .+ profitable price/);
    assert.deepEqual(signal.tpPrices, []);
  });

  it("holds mid when flat (no long)", () => {
    const candles = reboundToMid();
    const last = candles[candles.length - 1]!;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
    });
    assert.ok(signal.meta?.bbMid != null);
    assert.ok(last.close >= signal.meta.bbMid);
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /Above mid, no upper rejection/);
  });

  it("holds a short until price clears Jupiter perps open, close, and borrow", () => {
    const candles = reboundToMid();
    const last = candles[candles.length - 1]!;
    const at = new Date(last.time * 1000);
    const openedAt = new Date(at.getTime() - 2 * 60 * 60 * 1000);
    const perpsFees = {
      openFeePct: 0.01,
      closeFeePct: 0.01,
      borrowFeePctPerHour: 0.005,
    };
    const held = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
      entryPrice: last.close,
      positionSide: "short",
      openedAt,
      at,
      perpsFees,
    });
    assert.equal(held.side, "HOLD");
    assert.match(held.reason, /perpsFee=3\.00%/);

    const covered = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close * 0.96,
      entryPrice: last.close,
      positionSide: "short",
      openedAt,
      at,
      perpsFees,
    });
    assert.equal(covered.side, "BUY", covered.reason);
    assert.match(covered.reason, /profitable price/);
  });

  it("covers a short when the close is at least 1×ATR against the entry after timeStopBars", () => {
    const candles = reboundToMid();
    const last = candles[candles.length - 1]!;
    const at = new Date();
    const openedAt = new Date(at.getTime() - 2 * 15 * 60 * 1000);
    const perpsFees = {
      openFeePct: 0.0006,
      closeFeePct: 0.0006,
      borrowFeePctPerHour: 0.000007,
    };
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
      entryPrice: last.close * 0.9,
      positionSide: "short",
      openedAt,
      at,
      perpsFees,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /Time stop/);
    assert.match(signal.reason, /after 2 bars/);
  });

  it("does not time-stop a short before timeStopBars have elapsed", () => {
    const candles = reboundToMid();
    const last = candles[candles.length - 1]!;
    const at = new Date();
    const openedAt = new Date(at.getTime() - 15 * 60 * 1000);
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
      entryPrice: last.close * 0.9,
      positionSide: "short",
      openedAt,
      at,
      perpsFees: { openFeePct: 0.0006, closeFeePct: 0.0006, borrowFeePctPerHour: 0.000007 },
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /Waiting for profitable price/);
  });

  it("does not time-stop a short whose close is only a tick against the entry", () => {
    const candles = reboundToMid();
    const last = candles[candles.length - 1]!;
    const at = new Date();
    const openedAt = new Date(at.getTime() - 2 * 15 * 60 * 1000);
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ timeStopAtr: 50 }),
      price: last.close,
      entryPrice: last.close * 0.999,
      positionSide: "short",
      openedAt,
      at,
      perpsFees: { openFeePct: 0.0006, closeFeePct: 0.0006, borrowFeePctPerHour: 0.000007 },
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /Waiting for profitable price/);
  });

  it("sells a long when the close is at least 1×ATR against the entry after timeStopBars", () => {
    const candles = reclaimLowerBand();
    const last = candles[candles.length - 1]!;
    const at = new Date();
    const openedAt = new Date(at.getTime() - 2 * 15 * 60 * 1000);
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
      entryPrice: last.close * 1.1,
      openedAt,
      at,
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /Time stop/);
  });

  it("keeps a profitable exit ahead of the time stop", () => {
    const candles = reboundToMid();
    const last = candles[candles.length - 1]!;
    const at = new Date();
    const openedAt = new Date(at.getTime() - 4 * 15 * 60 * 1000);
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close * 1.05,
      entryPrice: last.close * 1.02,
      openedAt,
      at,
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /profitable price/);
  });

  it("holds a short cover when the perps fee schedule is missing", () => {
    const candles = reboundToMid();
    const last = candles[candles.length - 1]!;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close * 0.5,
      entryPrice: last.close,
      positionSide: "short",
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /perps fee schedule missing/);
  });

  it("does not open a short when the perps fee schedule is missing", () => {
    const candles = rejectUpperBand();
    const last = candles[candles.length - 1]!;
    const withFees = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
      perpsFees: { openFeePct: 0.0006, closeFeePct: 0.0006, borrowFeePctPerHour: 0.000007 },
    });
    assert.equal(withFees.side, "SELL", withFees.reason);
    const mid = withFees.meta?.bbMid;
    assert.ok(mid != null && mid < withFees.price);
    assert.deepEqual(withFees.tpPrices, [mid]);
    assert.equal(withFees.minRewardRisk, 0);

    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /perps fee schedule missing/);
  });

  it("holds a mid cross when price is still below minExit", () => {
    const candles = reboundToMid();
    const last = candles[candles.length - 1]!;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
      entryPrice: last.close * 1.02,
    });
    assert.ok(signal.meta?.bbMid != null);
    assert.ok(last.close >= signal.meta.bbMid);
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /Waiting for profitable price/);
    assert.match(signal.reason, /minExit=/);
  });

  it("ignores reclaim when RSI is not oversold", () => {
    const candles = reclaimLowerBand();
    const rsiPeriod = 5;
    const rsiNow = rsi(
      candles.map((c) => c.close),
      rsiPeriod,
    ).at(-1);
    assert.ok(rsiNow != null);
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ rsiPeriod, rsiBuyMax: rsiNow }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /RSI/);
    assert.match(signal.reason, /not oversold/);
  });

  it("emits BUY on a same-bar wick reclaim (green close back inside)", () => {
    const candles = wickReclaimLower();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /wick reclaim/i);
  });

  it("does not BUY a forming wick reclaim (waits for the 15m close)", () => {
    const candles = wickReclaimLower();
    const last = candles[candles.length - 1]!;
    const forming = { ...last, close: last.high };
    const at = new Date((last.time + 7 * 60) * 1000);
    const signal = evalBb({
      pair: "SOL/USDC",
      candles: [...candles.slice(0, -1), forming],
      strategy: looseFilters(),
      price: forming.close,
      at,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /waiting for closed 15m reclaim/i);
  });

  it("BUYs on the next bar after a closed wick reclaim", () => {
    const candles = wickReclaimLower();
    const last = candles[candles.length - 1]!;
    const interval = 15 * 60;
    const next = createCandle({
      time: last.time + interval,
      open: last.close,
      high: last.close,
      low: last.close,
      close: last.close,
      volume: 10,
    });
    const at = new Date((next.time + 60) * 1000);
    const signal = evalBb({
      pair: "SOL/USDC",
      candles: [...candles, next],
      strategy: looseFilters(),
      price: next.close,
      at,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /wick reclaim/i);
  });

  it("BUYs when the reclaim bar is closed by time before the next candle appears", () => {
    const candles = wickReclaimLower();
    const last = candles[candles.length - 1]!;
    const interval = 15 * 60;
    // Gap after close: Gecko has not published the new forming bar yet.
    const at = new Date((last.time + interval + 30) * 1000);
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
      at,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /wick reclaim/i);
  });

  it("still emits BUY on a reclaim when 1h volatility is high", () => {
    const candles = reclaimLowerBand();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: candles[candles.length - 1]!.close,
      volatility: "high",
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /Lower BB .+ reclaim/i);
  });

  it("still emits SELL at mid when long and 1h volatility is high", () => {
    const candles = reboundToMid();
    const last = candles[candles.length - 1]!;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters(),
      price: last.close,
      entryPrice: last.close * 0.98,
      volatility: "high",
    });
    assert.equal(signal.side, "SELL");
    assert.match(signal.reason, /Price .+ profitable price/);
  });

  it("emits BUY when reclaim RSI is below rsiBuyMax", () => {
    const candles = reclaimLowerBand();
    const rsiPeriod = 5;
    const rsiNow = rsi(
      candles.map((c) => c.close),
      rsiPeriod,
    ).at(-1);
    assert.ok(rsiNow != null);
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ rsiPeriod, rsiBuyMax: rsiNow + 1 }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /RSI/);
  });

  it("ignores reclaim when depth is below minReclaimDepth", () => {
    const candles = reclaimLowerBand();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ minReclaimDepth: 0.9 }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /depth/);
  });
});

describe("bollingerStopPrice", () => {
  it("places the hard stop beyond the entry-bar extreme", () => {
    assert.equal(bollingerStopPrice("long", 100, 4, 3), 88);
    assert.equal(bollingerStopPrice("long", 100, 4, 2.5), 90);
    assert.equal(bollingerStopPrice("short", 100, 4, 2.5), 110);
  });
});

describe("isAdxTrendAgainst", () => {
  it("blocks only when ADX is above adxMax", () => {
    assert.equal(isAdxTrendAgainst({ adxNow: 62, adxMax: 39 }), true);
    assert.equal(isAdxTrendAgainst({ adxNow: 39, adxMax: 39 }), false);
    assert.equal(isAdxTrendAgainst({ adxNow: 20, adxMax: 39 }), false);
  });
});

describe("BollingerStrategy", () => {
  it("does not gate entries on 1h volatility", () => {
    const candles = reclaimLowerBand();
    const last = candles[candles.length - 1]!;
    const price = last.close;
    const at = new Date((last.time + 15 * 60) * 1000);
    const strategy = new BollingerStrategy("bullish", "low");
    const low = strategy.evaluateSignal(
      "SOL/USDC",
      candles,
      marketState("bullish", "low", price),
      price,
      at,
    );
    const high = strategy.evaluateSignal(
      "SOL/USDC",
      candles,
      marketState("bullish", "high", price),
      price,
      at,
    );
    assert.equal(high.side, low.side);
    assert.equal(high.reason, low.reason);
    assert.doesNotMatch(high.reason, /volatility high/);
  });

  it("names BB params in the display name", () => {
    assert.match(new BollingerStrategy("flat", "low").getDisplayName(), /^bollinger \(/);
    assert.match(new BollingerStrategy("flat", "low").getDisplayName(), /BB14/);
    assert.match(new BollingerStrategy("bearish", "low").getDisplayName(), /bollinger/);
    assert.match(new BollingerStrategy("bullish", "high").getDisplayName(), /bollinger/);
  });
});
