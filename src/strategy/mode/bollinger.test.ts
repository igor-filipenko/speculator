import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandle } from "../../market/candle.js";
import type { Candle, MarketIndicators, Trend, Volatility } from "../../types.js";
import { TIER_COSTS } from "../../exchange/emulated/emulated-quote.js";
import { shortPositionFeePct } from "../../exchange/jupiter/perps-fees.js";
import {
  adxBlocksEntry,
  evaluateBollinger,
  BollingerStrategy,
  bollingerDecayTarget,
  bollingerNetReward,
  bollingerParamsFor,
  bollingerStopPrice,
  diBlocksEntry,
  trendBlocksEntry,
  type BollingerInput,
  type BollingerParams,
} from "./bollinger.js";

function baseParams(overrides: Partial<BollingerParams> = {}): BollingerParams {
  return { ...bollingerParamsFor(), ...overrides };
}

/** Loose filters so fixtures still fire BUY/SELL without the live DI gate. */
function looseFilters(overrides: Partial<BollingerParams> = {}): BollingerParams {
  return baseParams({
    period: 10,
    stdDev: 2,
    atrPeriod: 5,
    adxPeriod: 5,
    minReclaimDepth: 0,
    maxBreakAtr: 0,
    adxMax: 0,
    diRatio: Number.POSITIVE_INFINITY,
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

/** Depth, breakout width, DI, and reward gates off so a wick can still short. */
function rejectionFilters(overrides: Partial<BollingerParams> = {}): BollingerParams {
  return baseParams({
    adxPeriod: 5,
    minReclaimDepth: 0,
    maxBreakAtr: 0,
    adxMax: 0,
    diRatio: Number.POSITIVE_INFINITY,
    minRewardRisk: 0,
    ...overrides,
  });
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
    assert.ok(signal.meta?.adx != null);
    assert.ok(signal.meta?.plusDi != null);
    assert.ok(signal.meta?.minusDi != null);
    const mid = signal.meta?.bbMid;
    assert.ok(mid != null && mid > signal.price);
    assert.deepEqual(signal.tpPrices, [mid]);
    assert.equal(signal.minRewardRisk, 0);
    assert.equal(bollingerParamsFor().minRewardRisk, 0.3);
    assert.equal(bollingerParamsFor().maxBreakAtr, 2.5);
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

  it("does not short a rising series that never rejects the upper band", () => {
    const start = 1_700_000_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      candles.push(bar(start + i * INTERVAL, 100 + i * 0.15, 0.05));
    }
    const last = candles[candles.length - 1]!;
    const at = new Date((last.time + 15 * 60) * 1000);
    const perpsFees = { openFeePct: 0.0006, closeFeePct: 0.0006, borrowFeePctPerHour: 0.000007 };
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: rejectionFilters(),
      price: last.close,
      at,
      perpsFees,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /no upper rejection/);
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

  it("blocks a lower reclaim when -DI leads +DI", () => {
    const candles = reclaimLowerBand();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ diRatio: 1 }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /-DI .+ > 1× \+DI/);
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

  it("skips an upper rejection while ADX is trending", () => {
    const candles = rejectUpperBand();
    const last = candles[candles.length - 1]!;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ adxMax: 0.01, diRatio: Number.POSITIVE_INFINITY }),
      price: last.close,
      perpsFees: { openFeePct: 0.0006, closeFeePct: 0.0006, borrowFeePctPerHour: 0.000007 },
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /waiting for a range/);
  });

  it("blocks an upper rejection when +DI leads -DI", () => {
    const candles = rejectUpperBand();
    const last = candles[candles.length - 1]!;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ diRatio: 1 }),
      price: last.close,
      perpsFees: { openFeePct: 0.0006, closeFeePct: 0.0006, borrowFeePctPerHour: 0.000007 },
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /\+DI .+ > 1× -DI/);
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

  it("ignores a breakout candle wider than maxBreakAtr", () => {
    const candles = reclaimLowerBand();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy: looseFilters({ maxBreakAtr: 0.01 }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /breakout range/);
  });
});

describe("bollingerStopPrice", () => {
  it("places the hard stop beyond the entry-bar extreme", () => {
    assert.equal(bollingerStopPrice("long", 100, 4, 3), 88);
    assert.equal(bollingerStopPrice("long", 100, 4, 2.5), 90);
    assert.equal(bollingerStopPrice("short", 100, 4, 2.5), 110);
  });
});

describe("trendFilter", () => {
  const fees = { openFeePct: 0.0006, closeFeePct: 0.0006, borrowFeePctPerHour: 0.000007 };

  it("blocks a lower reclaim in a bearish trend when the filter is 1", () => {
    const candles = reclaimLowerBand();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      trend: "bearish",
      strategy: looseFilters({ trendFilter: 1 }),
      price: candles[candles.length - 1]!.close,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /HTF trend is bearish, against a long/);
  });

  it("lets the same reclaim through when the filter is off or the trend is bullish", () => {
    const candles = reclaimLowerBand();
    for (const [trend, trendFilter] of [
      ["bearish", 0],
      ["bullish", 1],
      ["unknown", 1],
    ] as const) {
      const signal = evalBb({
        pair: "SOL/USDC",
        candles,
        trend,
        strategy: looseFilters({ trendFilter }),
        price: candles[candles.length - 1]!.close,
      });
      assert.equal(signal.side, "BUY", `${trend}/${trendFilter}: ${signal.reason}`);
    }
  });

  it("blocks an upper rejection in a bullish trend when the filter is 1", () => {
    const candles = rejectUpperBand();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      trend: "bullish",
      strategy: looseFilters({ trendFilter: 1 }),
      price: candles[candles.length - 1]!.close,
      perpsFees: fees,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /HTF trend is bullish, against a short/);
  });

  it("trades only in a flat trend when the filter is 2", () => {
    const candles = reclaimLowerBand();
    const price = candles[candles.length - 1]!.close;
    const strategy = looseFilters({ trendFilter: 2 });
    assert.equal(evalBb({ pair: "SOL/USDC", candles, trend: "flat", strategy, price }).side, "BUY");
    const bullish = evalBb({ pair: "SOL/USDC", candles, trend: "bullish", strategy, price });
    assert.equal(bullish.side, "HOLD");
    assert.match(bullish.reason, /entries need flat/);
  });

  it("never gates an exit", () => {
    const candles = reclaimLowerBand();
    const last = candles[candles.length - 1]!;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      trend: "bearish",
      strategy: looseFilters({ trendFilter: 2 }),
      price: last.close + 5,
      entryPrice: last.close,
      positionSide: "long",
    });
    assert.equal(signal.side, "SELL", signal.reason);
  });
});

describe("trendBlocksEntry", () => {
  it("covers every mode and trend", () => {
    assert.equal(trendBlocksEntry("long", "bearish", 0), false);
    assert.equal(trendBlocksEntry("long", "bearish", 1), true);
    assert.equal(trendBlocksEntry("long", "bullish", 1), false);
    assert.equal(trendBlocksEntry("short", "bullish", 1), true);
    assert.equal(trendBlocksEntry("short", "bearish", 1), false);
    assert.equal(trendBlocksEntry("long", "flat", 2), false);
    assert.equal(trendBlocksEntry("short", "bullish", 2), true);
    assert.equal(trendBlocksEntry("long", "unknown", 2), false);
  });
});

describe("adxBlocksEntry", () => {
  it("waits for a range while ADX is at or above the cap", () => {
    assert.equal(adxBlocksEntry(20, 20), true);
    assert.equal(adxBlocksEntry(24.1, 20), true);
    assert.equal(adxBlocksEntry(19.9, 20), false);
  });

  it("stays off when the cap is 0", () => {
    assert.equal(adxBlocksEntry(40, 0), false);
  });
});

describe("diBlocksEntry", () => {
  it("blocks a short when +DI leads -DI by more than diRatio", () => {
    assert.equal(diBlocksEntry("short", 30, 10, 1.5), true);
    assert.equal(diBlocksEntry("long", 30, 10, 1.5), false);
  });

  it("blocks a long when -DI leads +DI by more than diRatio", () => {
    assert.equal(diBlocksEntry("long", 10, 30, 1.5), true);
    assert.equal(diBlocksEntry("short", 10, 30, 1.5), false);
  });

  it("allows both sides when neither DI leads by the ratio", () => {
    assert.equal(diBlocksEntry("long", 20, 18, 1.5), false);
    assert.equal(diBlocksEntry("short", 20, 18, 1.5), false);
    assert.equal(diBlocksEntry("short", 15, 10, 1.5), false);
  });

  it("blocks a short as soon as +DI leads when the ratio is 1", () => {
    assert.equal(diBlocksEntry("short", 23.77, 15.95, 1), true);
    assert.equal(diBlocksEntry("short", 23.77, 15.95, 1.5), false);
  });
});

describe("bollingerDecayTarget", () => {
  const at = new Date("2026-01-01T12:00:00Z");
  const hour = 60 * 60 * 1000;

  it("stays on the strict price when decay is off or the fill time is missing", () => {
    const off = bollingerDecayTarget({
      strict: 100,
      floor: 90,
      decayBars: 0,
      openedAt: new Date(at.getTime() - 10 * hour),
      at,
      timeframe: "1h",
    });
    assert.equal(off.target, 100);
    assert.equal(off.barsHeld, 0);
    assert.equal(off.flatten, false);

    const missing = bollingerDecayTarget({
      strict: 100,
      floor: 90,
      decayBars: 4,
      at,
      timeframe: "1h",
    });
    assert.equal(missing.target, 100);
    assert.equal(missing.flatten, false);
  });

  it("slides halfway and flattens once decayBars have elapsed", () => {
    const down = bollingerDecayTarget({
      strict: 100,
      floor: 90,
      decayBars: 4,
      openedAt: new Date(at.getTime() - 2 * hour),
      at,
      timeframe: "1h",
    });
    assert.equal(down.barsHeld, 2);
    assert.equal(down.target, 95);
    assert.equal(down.flatten, false);

    const up = bollingerDecayTarget({
      strict: 90,
      floor: 100,
      decayBars: 4,
      openedAt: new Date(at.getTime() - 2 * hour),
      at,
      timeframe: "1h",
    });
    assert.equal(up.target, 95);

    const done = bollingerDecayTarget({
      strict: 100,
      floor: 90,
      decayBars: 4,
      openedAt: new Date(at.getTime() - 5 * hour),
      at,
      timeframe: "1h",
    });
    assert.equal(done.barsHeld, 5);
    assert.equal(done.target, 90);
    assert.equal(done.flatten, true);
  });
});

describe("decayBars", () => {
  const at = new Date("2026-01-01T12:00:00Z");
  const hour = 60 * 60 * 1000;
  const perpsFees = { openFeePct: 0.01, closeFeePct: 0.01, borrowFeePctPerHour: 0.001 };

  function longBook() {
    const candles = reclaimLowerBand();
    const strategy = looseFilters({ decayBars: 4, timeframe: "1h" });
    const probe = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: candles[candles.length - 1]!.close,
      at,
    });
    const mid = probe.meta?.bbMid;
    assert.ok(mid != null && mid > 0);
    const entry = mid * 0.97;
    const spotFee = TIER_COSTS.liquid.slippage + TIER_COSTS.liquid.poolFee;
    const floor = entry / (1 - spotFee);
    assert.ok(floor < mid);
    return { candles, strategy, entry, mid, floor };
  }

  function shortBook() {
    const candles = reboundToMid();
    const strategy = looseFilters({ decayBars: 4, timeframe: "1h" });
    const probe = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: candles[candles.length - 1]!.close,
      at,
      perpsFees,
    });
    const mid = probe.meta?.bbMid;
    assert.ok(mid != null && mid > 0);
    const entry = mid * 1.03;
    const slip = TIER_COSTS.liquid.slippage;
    const heldFee = shortPositionFeePct({ ...perpsFees, heldMs: 2 * hour });
    const openFee = shortPositionFeePct({ ...perpsFees, heldMs: 0 });
    const minExit = (entry * (1 - heldFee)) / (1 + slip);
    const floor = (entry * (1 - openFee)) / (1 + slip);
    const strict = Math.min(mid, minExit);
    assert.equal(strict, mid);
    assert.ok(floor > mid);
    const halfway = bollingerDecayTarget({
      strict,
      floor,
      decayBars: 4,
      openedAt: new Date(at.getTime() - 2 * hour),
      at,
      timeframe: "1h",
    });
    assert.ok(halfway.target > mid && halfway.target < floor);
    return { candles, strategy, entry, mid, floor, halfway };
  }

  it("sells a long once the decayed target slides through the quote", () => {
    const { candles, strategy, entry, mid, floor } = longBook();
    const halfway = bollingerDecayTarget({
      strict: mid,
      floor,
      decayBars: 4,
      openedAt: new Date(at.getTime() - 2 * hour),
      at,
      timeframe: "1h",
    });
    const price = (halfway.target + mid) / 2;
    assert.ok(price > halfway.target && price < mid);

    const slid = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price,
      entryPrice: entry,
      openedAt: new Date(at.getTime() - 2 * hour),
      at,
    });
    assert.equal(slid.side, "SELL", slid.reason);
    assert.match(slid.reason, /profitable price/);

    const fresh = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price,
      entryPrice: entry,
      openedAt: at,
      at,
    });
    assert.equal(fresh.side, "HOLD", fresh.reason);
    assert.match(fresh.reason, new RegExp(`Waiting for profitable price at ${mid.toFixed(4)}`));
  });

  it("holds a long still below the slid target and names that target", () => {
    const { candles, strategy, entry, mid, floor } = longBook();
    const openedAt = new Date(at.getTime() - 2 * hour);
    const halfway = bollingerDecayTarget({
      strict: mid,
      floor,
      decayBars: 4,
      openedAt,
      at,
      timeframe: "1h",
    });
    const price = (floor + halfway.target) / 2;
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price,
      entryPrice: entry,
      openedAt,
      at,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, new RegExp(`at ${halfway.target.toFixed(4)}`));
  });

  it("flattens a long at the horizon even below breakeven", () => {
    const { candles, strategy, entry, floor } = longBook();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: floor * 0.99,
      entryPrice: entry,
      openedAt: new Date(at.getTime() - 4 * hour),
      at,
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /Time decay: 4 bars/);
    assert.match(signal.reason, new RegExp(`floor ${floor.toFixed(4)}`));
  });

  it("does not flatten a long without openedAt", () => {
    const { candles, strategy, entry, mid } = longBook();
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: mid * 0.99,
      entryPrice: entry,
      at,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, new RegExp(`Waiting for profitable price at ${mid.toFixed(4)}`));
    assert.doesNotMatch(signal.reason, /Time decay/);
  });

  it("covers a short once the decayed target rises through the quote", () => {
    const { candles, strategy, entry, mid, halfway } = shortBook();
    const price = (mid + halfway.target) / 2;
    const openedAt = new Date(at.getTime() - 2 * hour);

    const slid = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price,
      entryPrice: entry,
      positionSide: "short",
      openedAt,
      at,
      perpsFees,
    });
    assert.equal(slid.side, "BUY", slid.reason);
    assert.match(slid.reason, /profitable price/);

    const fresh = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price,
      entryPrice: entry,
      positionSide: "short",
      openedAt: at,
      at,
      perpsFees,
    });
    assert.equal(fresh.side, "HOLD", fresh.reason);
    assert.match(fresh.reason, new RegExp(`Waiting for profitable price at ${mid.toFixed(4)}`));
  });

  it("flattens a short at the horizon above the no-borrow floor", () => {
    const { candles, strategy, entry, floor } = shortBook();
    assert.ok(entry > floor);
    const signal = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: entry,
      entryPrice: entry,
      positionSide: "short",
      openedAt: new Date(at.getTime() - 4 * hour),
      at,
      perpsFees,
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /Time decay: 4 bars/);
    assert.match(signal.reason, new RegExp(`floor ${floor.toFixed(4)}`));
  });

  it("does not flatten a short without openedAt or a perps fee schedule", () => {
    const { candles, strategy, entry, mid } = shortBook();
    const above = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: entry,
      entryPrice: entry,
      positionSide: "short",
      at,
      perpsFees,
    });
    assert.equal(above.side, "HOLD", above.reason);
    assert.match(above.reason, new RegExp(`Waiting for profitable price at ${mid.toFixed(4)}`));
    assert.doesNotMatch(above.reason, /Time decay/);

    const missingFees = evalBb({
      pair: "SOL/USDC",
      candles,
      strategy,
      price: entry * 0.5,
      entryPrice: entry,
      positionSide: "short",
      openedAt: new Date(at.getTime() - 4 * hour),
      at,
    });
    assert.equal(missingFees.side, "HOLD", missingFees.reason);
    assert.match(missingFees.reason, /perps fee schedule missing/);
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
    assert.match(new BollingerStrategy("flat", "low").getDisplayName(), /BB20/);
    assert.match(new BollingerStrategy("flat", "low").getDisplayName(), /DI1 ADX<20/);
    assert.doesNotMatch(new BollingerStrategy("flat", "low").getDisplayName(), /tStop|decay/);
    assert.match(
      new BollingerStrategy("flat", "low", baseParams({ decayBars: 12 })).getDisplayName(),
      /decay12/,
    );
    assert.match(new BollingerStrategy("bearish", "low").getDisplayName(), /bollinger/);
    assert.match(new BollingerStrategy("bullish", "high").getDisplayName(), /bollinger/);
  });
});
