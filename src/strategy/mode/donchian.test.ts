import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle, MarketIndicators, PerpsFees } from "../../types.js";
import {
  DonchianStrategy,
  donchianParamsFor,
  evaluateDonchian,
  type DonchianParams,
} from "./donchian.js";

function baseParams(overrides: Partial<DonchianParams> = {}): DonchianParams {
  return { ...donchianParamsFor(), ...overrides };
}

/** Short windows so fixtures do not need 50+ bars. */
function testParams(overrides: Partial<DonchianParams> = {}): DonchianParams {
  return baseParams({
    entryPeriod: 5,
    exitPeriod: 3,
    volumeSmaPeriod: 5,
    volumeSmaMult: 1.0,
    trendEmaPeriod: 5,
    atrPeriod: 5,
    minBreakAtrMult: 0,
    givebackArmAtrMult: 0,
    maxEntryAgeBars: 0,
    ...overrides,
  });
}

const INTERVAL = 15 * 60;

function bar(time: number, close: number, range = 0.3, volume = 10): Candle {
  return {
    time,
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume,
  };
}

/** Quiet range so the last 5-bar high is well defined, then a close above it. */
function rangeThenBreakout(opts: {
  lastClose: number;
  lastVolume: number;
  lastRange?: number;
}): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const price = 100 + ((i % 4) - 1.5) * 0.1;
    candles.push(bar(start + i * INTERVAL, price, 0.2, 10));
  }
  const t = start + 40 * INTERVAL;
  candles.push(bar(t, opts.lastClose, opts.lastRange ?? 0.4, opts.lastVolume));
  return candles;
}

/** Downtrend then a local 5-bar high break that stays under a slower EMA. */
function breakoutBelowEma(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  let price = 150;
  for (let i = 0; i < 40; i++) {
    price -= 1.2;
    candles.push(bar(start + i * INTERVAL, price, 0.3, 10));
  }
  for (let i = 0; i < 8; i++) {
    const p = 100 + ((i % 4) - 1.5) * 0.1;
    candles.push(bar(start + (40 + i) * INTERVAL, p, 0.2, 10));
  }
  candles.push(bar(start + 48 * INTERVAL, 101.2, 0.5, 40));
  return candles;
}

const perpsFees: PerpsFees = {
  openFeePct: 0.0006,
  closeFeePct: 0.0006,
  borrowFeePctPerHour: 0.000007,
};

/** Quiet range then a close through the prior entry-channel low. */
function rangeThenBreakdown(
  opts: {
    lastClose?: number;
    lastVolume?: number;
    lastRange?: number;
  } = {},
): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const price = 100 + ((i % 4) - 1.5) * 0.1;
    candles.push(bar(start + i * INTERVAL, price, 0.2, 10));
  }
  const t = start + 40 * INTERVAL;
  candles.push(bar(t, opts.lastClose ?? 99.2, opts.lastRange ?? 0.3, opts.lastVolume ?? 10));
  return candles;
}

describe("evaluateDonchian", () => {
  it("returns HOLD during warmup", () => {
    const candles = [bar(1, 100), bar(2, 101), bar(3, 102)];
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: 102,
      trend: "flat",
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /warmup/i);
  });

  it("emits BUY on upper-channel breakout when volume and EMA pass", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
      trend: "flat",
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.equal(signal.strategyId, "donchian");
    assert.deepEqual(signal.tpPrices, []);
    assert.equal(signal.minRewardRisk, 0);
    assert.match(signal.reason, /Donchian breakout/i);
    assert.ok(signal.meta?.donchianUpper != null);
    assert.ok(signal.meta?.volumeSma != null);
    assert.ok(signal.meta?.atr != null);
    assert.ok(signal.meta?.barHigh != null);
    assert.ok(signal.slPrice != null && signal.slPrice < signal.price);
  });

  it("places the stop at atrStopMult × ATR and no take-profit", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams({ atrStopMult: 1 }),
      price: candles[candles.length - 1]!.close,
      trend: "flat",
    });
    assert.equal(signal.side, "BUY", signal.reason);
    const atrNow = signal.meta?.atr;
    assert.ok(atrNow != null && atrNow > 0);
    assert.ok(signal.slPrice != null);
    assert.ok(Math.abs(signal.price - signal.slPrice - atrNow) < 1e-8);
    assert.deepEqual(signal.tpPrices, []);
  });

  it("does not BUY a forming breakout (waits for the 15m close)", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    const forming = { ...last, close: last.high };
    const at = new Date((last.time + 7 * 60) * 1000);
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles: [...candles.slice(0, -1), forming],
      strategy: testParams(),
      price: forming.close,
      at,
      trend: "flat",
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /waiting for closed 15m breakout/i);
  });

  it("BUYs on the next bar after a closed breakout", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    const next: Candle = {
      time: last.time + INTERVAL,
      open: last.close,
      high: last.close,
      low: last.close,
      close: last.close,
      volume: 10,
    };
    const at = new Date((next.time + 60) * 1000);
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles: [...candles, next],
      strategy: testParams(),
      price: next.close,
      at,
      trend: "flat",
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /Donchian breakout/i);
  });

  it("holds a breakout when volume is at or below SMA", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 5, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
      trend: "flat",
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /volume/i);
  });

  it("holds a breakout when close is below trend EMA", () => {
    const candles = breakoutBelowEma();
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams({ trendEmaPeriod: 30 }),
      price: candles[candles.length - 1]!.close,
      trend: "flat",
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /trend EMA/i);
  });

  it("does not re-BUY while price stays above the channel", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    candles.push(bar(last.time + INTERVAL, last.close + 0.2, 0.4, 40));
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
      trend: "flat",
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /No Donchian signal/i);
  });

  it("emits SELL when close breaks the prior exit-channel low", () => {
    const candles = rangeThenBreakdown();
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
      entryPrice: 100,
      trend: "flat",
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /Donchian exit/i);
    assert.ok(signal.meta?.donchianLower != null);
  });

  it("ignores a breakout when HTF trend is bearish", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
      trend: "bearish",
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /not bullish/i);
  });

  it("ignores a shallow breakout below minBreakAtrMult × ATR", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams({ minBreakAtrMult: 50 }),
      price: candles[candles.length - 1]!.close,
      trend: "flat",
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /ATR/i);
  });

  it("emits SELL when long and price gives back ATR from the hold peak", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    const dumped: Candle[] = [
      ...candles,
      {
        time: last.time + INTERVAL,
        open: last.close,
        high: last.close,
        low: last.close - 2,
        close: last.close - 1.5,
        volume: 10,
      },
    ];
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles: dumped,
      strategy: testParams({ givebackAtrMult: 1 }),
      price: last.close - 1.5,
      entryPrice: last.close,
      openedAt: new Date(last.time * 1000),
      trend: "flat",
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /Gave back/i);
  });

  it("sells a long that never closes above the breakout follow level within timeStopBars", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const entryBar = candles[candles.length - 1]!;
    const openedAt = new Date((entryBar.time + INTERVAL) * 1000);
    let t = entryBar.time;
    for (let i = 0; i < 4; i++) {
      t += INTERVAL;
      candles.push(bar(t, entryBar.close - 0.2, 0.1, 10));
    }
    const last = candles[candles.length - 1]!;
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams({ timeStopBars: 4, givebackAtrMult: 0 }),
      price: last.close,
      at: new Date((last.time + INTERVAL) * 1000),
      entryPrice: entryBar.close,
      openedAt,
      trend: "flat",
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /Time stop/i);
  });

  it("time-stops when only a wick clears the breakout high (close does not)", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const entryBar = candles[candles.length - 1]!;
    const openedAt = new Date((entryBar.time + INTERVAL) * 1000);
    // Close below breakout high; high wick well above it.
    const wick = {
      time: entryBar.time + INTERVAL,
      open: entryBar.close - 0.1,
      high: entryBar.high + 1.0,
      low: entryBar.close - 0.3,
      close: entryBar.close - 0.1,
      volume: 10,
    };
    let t = wick.time;
    const after = [wick];
    for (let i = 0; i < 3; i++) {
      t += INTERVAL;
      after.push(bar(t, entryBar.close - 0.15, 0.1, 10));
    }
    const last = after[after.length - 1]!;
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles: [...candles, ...after],
      strategy: testParams({ timeStopBars: 4, givebackAtrMult: 0 }),
      price: last.close,
      at: new Date((last.time + INTERVAL) * 1000),
      entryPrice: entryBar.close,
      openedAt,
      trend: "flat",
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /Time stop/i);
  });

  it("holds when a later close clears breakoutHigh − ATR", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const entryBar = candles[candles.length - 1]!;
    const openedAt = new Date((entryBar.time + INTERVAL) * 1000);
    // Close above breakout high (well clear of breakoutHigh − ATR).
    const follow = bar(entryBar.time + INTERVAL, entryBar.high + 0.2, 0.3, 10);
    let t = follow.time;
    const after = [follow];
    for (let i = 0; i < 3; i++) {
      t += INTERVAL;
      after.push(bar(t, entryBar.close - 0.1, 0.1, 10));
    }
    const last = after[after.length - 1]!;
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles: [...candles, ...after],
      strategy: testParams({ timeStopBars: 4, givebackAtrMult: 0 }),
      price: last.close,
      at: new Date((last.time + INTERVAL) * 1000),
      entryPrice: entryBar.close,
      openedAt,
      trend: "flat",
    });
    assert.equal(signal.side, "HOLD", signal.reason);
  });

  it("time-stops when closes stay more than 1×ATR under the breakout high", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const entryBar = candles[candles.length - 1]!;
    const openedAt = new Date((entryBar.time + INTERVAL) * 1000);
    // Close far under the breakout high so even breakoutHigh − ATR is missed.
    const poke = bar(entryBar.time + INTERVAL, entryBar.high - 2.0, 0.1, 10);
    let t = poke.time;
    const after = [poke];
    for (let i = 0; i < 3; i++) {
      t += INTERVAL;
      after.push(bar(t, entryBar.high - 2.0, 0.1, 10));
    }
    const last = after[after.length - 1]!;
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles: [...candles, ...after],
      strategy: testParams({ timeStopBars: 4, givebackAtrMult: 0 }),
      price: last.close,
      at: new Date((last.time + INTERVAL) * 1000),
      entryPrice: entryBar.close,
      openedAt,
      trend: "flat",
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /Time stop/i);
  });

  it("holds when a close sits under the breakout wick but within 1×ATR", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const entryBar = candles[candles.length - 1]!;
    const openedAt = new Date((entryBar.time + INTERVAL) * 1000);
    const under = bar(entryBar.time + INTERVAL, entryBar.high - 0.15, 0.05, 10);
    let t = under.time;
    const after = [under];
    for (let i = 0; i < 3; i++) {
      t += INTERVAL;
      after.push(bar(t, entryBar.high - 0.2, 0.05, 10));
    }
    const last = after[after.length - 1]!;
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles: [...candles, ...after],
      strategy: testParams({ timeStopBars: 4, givebackAtrMult: 0 }),
      price: last.close,
      at: new Date((last.time + INTERVAL) * 1000),
      entryPrice: entryBar.close,
      openedAt,
      trend: "flat",
    });
    assert.equal(signal.side, "HOLD", signal.reason);
  });

  it("does not time-stop before timeStopBars have elapsed", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const entryBar = candles[candles.length - 1]!;
    const openedAt = new Date((entryBar.time + INTERVAL) * 1000);
    const next = bar(entryBar.time + INTERVAL, entryBar.close - 0.2, 0.1, 10);
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles: [...candles, next],
      strategy: testParams({ timeStopBars: 4, givebackAtrMult: 0 }),
      price: next.close,
      at: new Date((next.time + INTERVAL) * 1000),
      entryPrice: entryBar.close,
      openedAt,
      trend: "flat",
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.doesNotMatch(signal.reason, /Time stop/i);
  });

  it("emits SELL on a lower-channel breakdown when volume, EMA, and fees pass", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 40, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
      trend: "bearish",
      perpsFees,
    });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /Donchian breakdown/i);
    assert.ok(signal.meta?.donchianLower != null);
    assert.ok(signal.slPrice != null && signal.slPrice > signal.price);
    assert.ok(signal.meta?.atr != null);
  });

  it("does not SELL a forming breakdown (waits for the 15m close)", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    const forming = { ...last, close: last.low };
    const at = new Date((last.time + 7 * 60) * 1000);
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles: [...candles.slice(0, -1), forming],
      strategy: testParams(),
      price: forming.close,
      at,
      trend: "bearish",
      perpsFees,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /waiting for closed 15m breakout/i);
  });

  it("holds a breakdown when volume is at or below SMA", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 5, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
      trend: "bearish",
      perpsFees,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /volume/i);
  });

  it("holds a breakdown without a perps fee schedule", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 40, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
      trend: "bearish",
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /perps fee/i);
  });

  it("ignores a breakdown when HTF trend is bullish", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 40, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
      trend: "bullish",
      perpsFees,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /not bearish/i);
  });

  it("does not re-SELL while price stays below the channel", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    candles.push(bar(last.time + INTERVAL, last.close - 0.2, 0.4, 40));
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams(),
      price: candles[candles.length - 1]!.close,
      trend: "bearish",
      perpsFees,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /No Donchian signal/i);
  });

  it("covers a short when close breaks the prior exit-channel high", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    candles.push(bar(last.time + INTERVAL, 101.5, 0.3, 10));
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams({ givebackAtrMult: 0, timeStopBars: 0 }),
      price: 101.5,
      entryPrice: last.close,
      positionSide: "short",
      openedAt: new Date(last.time * 1000),
      trend: "bearish",
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /Donchian exit/i);
    assert.equal(signal.slPrice, undefined);
    assert.deepEqual(signal.tpPrices, []);
  });

  it("does not give back before the hold extreme has advanced givebackArmAtrMult × ATR", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    const dumped: Candle[] = [
      ...candles,
      {
        time: last.time + INTERVAL,
        open: last.close,
        high: last.close,
        low: last.close - 2,
        close: last.close - 1.5,
        volume: 10,
      },
    ];
    const input = {
      pair: "SOL/USDC",
      candles: dumped,
      price: last.close - 1.5,
      entryPrice: last.close,
      openedAt: new Date(last.time * 1000),
      trend: "flat" as const,
    };
    const unarmed = evaluateDonchian({
      ...input,
      strategy: testParams({ givebackAtrMult: 1, givebackArmAtrMult: 50, timeStopBars: 0 }),
    });
    assert.doesNotMatch(unarmed.reason, /Gave back/i);
    const armed = evaluateDonchian({
      ...input,
      strategy: testParams({ givebackAtrMult: 1, givebackArmAtrMult: 0, timeStopBars: 0 }),
    });
    assert.match(armed.reason, /Gave back/i);
  });

  it("covers a short when price gives back ATR from the hold trough", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    const squeezed: Candle[] = [
      ...candles,
      {
        time: last.time + INTERVAL,
        open: last.close,
        high: last.close + 2,
        low: last.close,
        close: last.close + 1.5,
        volume: 10,
      },
    ];
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles: squeezed,
      strategy: testParams({ givebackAtrMult: 1 }),
      price: last.close + 1.5,
      entryPrice: last.close,
      positionSide: "short",
      openedAt: new Date(last.time * 1000),
      trend: "bearish",
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /Gave back/i);
    assert.match(signal.reason, /trough/i);
  });

  it("covers a short that never closes below the breakdown follow level within timeStopBars", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 40, lastRange: 0.5 });
    const entryBar = candles[candles.length - 1]!;
    const openedAt = new Date((entryBar.time + INTERVAL) * 1000);
    let t = entryBar.time;
    for (let i = 0; i < 4; i++) {
      t += INTERVAL;
      candles.push(bar(t, entryBar.close + 0.2, 0.1, 10));
    }
    const last = candles[candles.length - 1]!;
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      strategy: testParams({ timeStopBars: 4, givebackAtrMult: 0 }),
      price: last.close,
      at: new Date((last.time + INTERVAL) * 1000),
      entryPrice: entryBar.close,
      positionSide: "short",
      openedAt,
      trend: "bearish",
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.match(signal.reason, /Time stop/i);
  });
});

describe("stricter entries", () => {
  it("requires more volume for a short than for a long", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 40, lastRange: 0.5 });
    const input = {
      pair: "SOL/USDC",
      candles,
      price: candles[candles.length - 1]!.close,
      trend: "bearish" as const,
      perpsFees,
    };
    const loose = evaluateDonchian({ ...input, strategy: testParams({ shortVolumeSmaScale: 1 }) });
    assert.equal(loose.side, "SELL", loose.reason);
    const strict = evaluateDonchian({
      ...input,
      strategy: testParams({ shortVolumeSmaScale: 100 }),
    });
    assert.equal(strict.side, "HOLD", strict.reason);
    assert.match(strict.reason, /volume/i);
  });

  it("requires a deeper break for a short than for a long", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 40, lastRange: 0.5 });
    const strict = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      price: candles[candles.length - 1]!.close,
      trend: "bearish",
      perpsFees,
      strategy: testParams({ minBreakAtrMult: 0.1, shortMinBreakScale: 100 }),
    });
    assert.equal(strict.side, "HOLD", strict.reason);
    assert.match(strict.reason, /Breakdown ignored/i);
  });

  it("skips a capitulation short far under the trend EMA", () => {
    const candles = rangeThenBreakdown({ lastClose: 98.8, lastVolume: 40, lastRange: 0.5 });
    const signal = evaluateDonchian({
      pair: "SOL/USDC",
      candles,
      price: candles[candles.length - 1]!.close,
      trend: "bearish",
      perpsFees,
      strategy: testParams({ shortMaxExtendAtrMult: 0.01 }),
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /capitulation/i);
  });

  it("ignores a stale breakout bar for entries but not exits", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    const fresh = new Date((last.time + INTERVAL) * 1000);
    const stale = new Date((last.time + INTERVAL + 0.6 * INTERVAL) * 1000);
    const params = testParams({ maxEntryAgeBars: 0.25 });
    const base = {
      pair: "SOL/USDC",
      candles,
      strategy: params,
      price: last.close,
      trend: "flat" as const,
    };
    assert.equal(evaluateDonchian({ ...base, at: fresh }).side, "BUY");
    const late = evaluateDonchian({ ...base, at: stale });
    assert.equal(late.side, "HOLD", late.reason);
    assert.match(late.reason, /bars ago/i);
  });

  it("locks the fill once the giveback is armed", () => {
    const candles = rangeThenBreakout({ lastClose: 101.2, lastVolume: 40, lastRange: 0.5 });
    const last = candles[candles.length - 1]!;
    const ran: Candle[] = [
      ...candles,
      { time: last.time + INTERVAL, open: 101.2, high: 106, low: 101.2, close: 105, volume: 10 },
      { time: last.time + 2 * INTERVAL, open: 105, high: 105, low: 100.9, close: 101, volume: 10 },
    ];
    const input = {
      pair: "SOL/USDC",
      candles: ran,
      price: 101,
      entryPrice: last.close,
      openedAt: new Date(last.time * 1000),
      trend: "flat" as const,
    };
    const wide = { givebackAtrMult: 50, givebackArmAtrMult: 1, timeStopBars: 0, exitPeriod: 2 };
    const locked = evaluateDonchian({
      ...input,
      strategy: testParams({ ...wide, givebackLockEntry: true, exitPeriod: 40 }),
    });
    assert.equal(locked.side, "SELL", locked.reason);
    assert.match(locked.reason, /Gave back/i);
    const unlocked = evaluateDonchian({
      ...input,
      strategy: testParams({ ...wide, givebackLockEntry: false, exitPeriod: 40 }),
    });
    assert.doesNotMatch(unlocked.reason, /Gave back/i);
  });
});

describe("donchianParamsFor", () => {
  it("uses 15m DC40/20 defaults in flat/low", () => {
    const p = donchianParamsFor("flat", "low");
    assert.equal(p.timeframe, "15m");
    assert.equal(p.entryPeriod, 40);
    assert.equal(p.exitPeriod, 20);
    assert.equal(p.volumeSmaPeriod, 20);
    assert.equal(p.trendEmaPeriod, 50);
    assert.equal(p.minBreakAtrMult, 0.7);
    assert.equal(p.givebackAtrMult, 4);
    assert.equal(p.givebackArmAtrMult, 2);
    assert.equal(p.timeStopBars, 3);
    assert.equal(p.volumeSmaMult, 2.6);
    assert.equal(p.shortVolumeSmaScale, 1.4);
    assert.equal(p.shortMinBreakScale, 1.5);
    assert.equal(p.givebackLockEntry, true);
    assert.equal(p.maxEntryAgeBars, 0.25);
    assert.equal(p.atrStopMult, 3);
  });

  it("tightens volume in squeeze and keeps a fixed exit channel", () => {
    assert.equal(donchianParamsFor("bullish", "high").volumeSmaMult, 1.6);
    assert.equal(donchianParamsFor("bullish", "high").exitPeriod, 20);
    assert.equal(donchianParamsFor("bullish", "high").minBreakAtrMult, 0.7);
    assert.equal(donchianParamsFor("bullish", "low").volumeSmaMult, 2.0);
    assert.equal(donchianParamsFor("bullish", "squeeze").volumeSmaMult, 2.1);
    assert.equal(donchianParamsFor("bullish", "squeeze").exitPeriod, 20);
    assert.equal(donchianParamsFor("bullish", "squeeze").minBreakAtrMult, 0.5);
  });
});

describe("DonchianStrategy", () => {
  it("exposes a 3×ATR hard stop and required candles on 15m", () => {
    const strategy = new DonchianStrategy("flat", "low");
    assert.equal(strategy.getId(), "donchian");
    assert.match(strategy.getDisplayName(), /flat/);
    assert.equal(strategy.hardStopLoss("long", 100, 4), 88);
    assert.equal(strategy.hardStopLoss("short", 100, 4), 112);
    const required = strategy.getRequiredCandles();
    assert.equal(required.timeframe, "15m");
    assert.ok(required.count <= 100);
    assert.ok(required.count >= 70);
  });

  it("names the volume mult in bullish high vol", () => {
    const strategy = new DonchianStrategy("bullish", "high");
    assert.match(strategy.getDisplayName(), /×1\.6/);
    assert.match(strategy.getDisplayName(), /bull/);
    assert.equal(strategy.hardStopLoss("long", 100, 4), 88);
  });

  it("sets doNotBuy from MarketIndicators.trend, not from constructor params", () => {
    const start = 1_700_000_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 80; i++) {
      const price = 100 + ((i % 4) - 1.5) * 0.1;
      candles.push(bar(start + i * INTERVAL, price, 0.2, 10));
    }
    candles.push(bar(start + 80 * INTERVAL, 101.2, 0.5, 40));
    const last = candles[candles.length - 1]!;
    const price = last.close;
    const at = new Date((last.time + INTERVAL) * 1000);
    const strategy = new DonchianStrategy("bullish", "high");
    const base: MarketIndicators = {
      pair: "SOL/USDC",
      price,
      trend: "bearish",
      volatility: "high",
    };
    const blocked = strategy.evaluateSignal("SOL/USDC", candles, base, price, at);
    assert.equal(blocked.side, "HOLD", blocked.reason);
    assert.match(blocked.reason, /not bullish/i);

    const bullish: MarketIndicators = { ...base, trend: "bullish" };
    const allowed = strategy.evaluateSignal("SOL/USDC", candles, bullish, price, at);
    assert.equal(allowed.side, "BUY", allowed.reason);

    const flat: MarketIndicators = { ...base, trend: "flat" };
    const flatAllowed = strategy.evaluateSignal("SOL/USDC", candles, flat, price, at);
    assert.equal(flatAllowed.side, "BUY", flatAllowed.reason);
    assert.equal(flatAllowed.strategyId, "donchian");
    assert.deepEqual(flatAllowed.tpPrices, []);
  });

  it("opens a short on a downside break only when HTF is bearish", () => {
    const start = 1_700_000_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 80; i++) {
      const price = 100 + ((i % 4) - 1.5) * 0.1;
      candles.push(bar(start + i * INTERVAL, price, 0.2, 10));
    }
    candles.push(bar(start + 80 * INTERVAL, 98.8, 0.5, 40));
    const last = candles[candles.length - 1]!;
    const price = last.close;
    const at = new Date((last.time + INTERVAL) * 1000);
    const strategy = new DonchianStrategy("bearish", "low");
    const market = {
      pair: "SOL/USDC",
      price,
      trend: "bearish" as const,
      volatility: "low" as const,
    };
    const blocked = strategy.evaluateSignal("SOL/USDC", candles, market, price, at);
    assert.equal(blocked.side, "HOLD", blocked.reason);
    assert.match(blocked.reason, /perps fee/i);

    const opened = strategy.evaluateSignal(
      "SOL/USDC",
      candles,
      market,
      price,
      at,
      undefined,
      perpsFees,
    );
    assert.equal(opened.side, "SELL", opened.reason);
    assert.match(opened.reason, /Donchian breakdown/i);
    assert.ok(opened.slPrice != null && opened.slPrice > opened.price);
    assert.deepEqual(opened.tpPrices, []);

    const flat = strategy.evaluateSignal(
      "SOL/USDC",
      candles,
      { ...market, trend: "flat" },
      price,
      at,
      undefined,
      perpsFees,
    );
    assert.equal(flat.side, "HOLD", flat.reason);
    assert.match(flat.reason, /not bearish/i);

    const bullish = strategy.evaluateSignal(
      "SOL/USDC",
      candles,
      { ...market, trend: "bullish" },
      price,
      at,
      undefined,
      perpsFees,
    );
    assert.equal(bullish.side, "HOLD", bullish.reason);
    assert.match(bullish.reason, /not bearish/i);
  });
});
