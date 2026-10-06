import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle, MarketIndicators } from "../../types.js";
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

/** Quiet range then a close through the prior 3-bar low. */
function rangeThenBreakdown(): Candle[] {
  const start = 1_700_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const price = 100 + ((i % 4) - 1.5) * 0.1;
    candles.push(bar(start + i * INTERVAL, price, 0.2, 10));
  }
  const t = start + 40 * INTERVAL;
  candles.push(bar(t, 99.2, 0.3, 10));
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
    assert.match(signal.reason, /Donchian breakout/i);
    assert.ok(signal.meta?.donchianUpper != null);
    assert.ok(signal.meta?.volumeSma != null);
    assert.ok(signal.meta?.atr != null);
    assert.ok(signal.meta?.barHigh != null);
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

  it("emits SELL when long and price gives back 3×ATR from the hold peak", () => {
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
});

describe("donchianParamsFor", () => {
  it("uses 15m DC20/40 defaults in flat/low", () => {
    const p = donchianParamsFor("flat", "low");
    assert.equal(p.timeframe, "15m");
    assert.equal(p.entryPeriod, 20);
    assert.equal(p.exitPeriod, 40);
    assert.equal(p.volumeSmaPeriod, 20);
    assert.equal(p.trendEmaPeriod, 50);
    assert.equal(p.minBreakAtrMult, 0.35);
    assert.equal(p.givebackAtrMult, 3);
    assert.equal(p.timeStopBars, 1);
    assert.equal(p.volumeSmaMult, 2.0);
    assert.equal(p.minRewardRisk, 2);
  });

  it("tightens volume in squeeze and keeps a fixed exit channel", () => {
    assert.equal(donchianParamsFor("bullish", "high").volumeSmaMult, 1.2);
    assert.equal(donchianParamsFor("bullish", "high").exitPeriod, 40);
    assert.equal(donchianParamsFor("bullish", "high").minBreakAtrMult, 0.35);
    assert.equal(donchianParamsFor("bullish", "low").volumeSmaMult, 1.5);
    assert.equal(donchianParamsFor("bullish", "squeeze").volumeSmaMult, 1.6);
    assert.equal(donchianParamsFor("bullish", "squeeze").exitPeriod, 40);
    assert.equal(donchianParamsFor("bullish", "squeeze").minBreakAtrMult, 0.25);
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
    assert.match(strategy.getDisplayName(), /×1\.2/);
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
  });
});
