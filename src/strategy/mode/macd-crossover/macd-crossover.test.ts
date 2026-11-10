import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandle } from "../../../market/candle.js";
import type { Candle, PerpsFees } from "../../../types.js";
import { ema, macd } from "../../indicators.js";
import {
  MacdCrossoverStrategy,
  evaluateMacdCrossover,
  macdCrossoverParamsFor,
  strategyModule,
  type MacdCrossoverParams,
} from "./macd-crossover.js";

const START = 1_700_000_000;
const FOUR_HOURS = 4 * 60 * 60;

function bars(closes: number[], timeframe: "4h" | "1h" = "4h"): Candle[] {
  const step = timeframe === "4h" ? FOUR_HOURS : 60 * 60;
  return closes.map((close, index) =>
    createCandle({
      time: START + index * step,
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 10,
      timeframe,
    }),
  );
}

function ramp(count: number, start: number, step: number): number[] {
  return Array.from({ length: count }, (_, index) => start + index * step);
}

/** Compounding rise: the MACD line keeps pulling away from its signal. */
function compoundingRise(): number[] {
  return Array.from({ length: 650 }, (_, index) => 100 * Math.pow(1.003, index));
}

/** Established rise, then a sharp drop that pulls the histogram below zero. */
function reversal(): number[] {
  return [...ramp(500, 100, 0.15), ...ramp(40, 175, -2)];
}

/** Rise, then a dip that flips the histogram while EMA2 is still above EMA200. */
function pullback(): number[] {
  const rise = compoundingRise();
  const last = rise[rise.length - 1]!;
  return [...rise, ...Array.from({ length: 10 }, (_, index) => last * Math.pow(0.985, index + 1))];
}

/** Steady percentage decline. The histogram stays positive while price is under EMA200. */
function compoundingFall(): number[] {
  return Array.from({ length: 650 }, (_, index) => 300 * Math.pow(0.997, index));
}

const perpsFees: PerpsFees = {
  openFeePct: 0.0006,
  closeFeePct: 0.0006,
  borrowFeePctPerHour: 0.000007,
};

function evalAt(
  candles: Candle[],
  strategy: MacdCrossoverParams,
  extra: Partial<Parameters<typeof evaluateMacdCrossover>[0]> = {},
) {
  const last = candles[candles.length - 1]!;
  return evaluateMacdCrossover({
    pair: "SOL/USDC",
    candles,
    strategy,
    price: last.close,
    at: new Date((last.time + last.intervalSeconds) * 1000),
    ...extra,
  });
}

describe("evaluateMacdCrossover", () => {
  it("buys a closed rise when the histogram is positive and EMA2 is above EMA200", () => {
    const candles = bars(compoundingRise());
    const signal = evalAt(candles, macdCrossoverParamsFor());
    assert.equal(signal.side, "BUY", signal.reason);
    assert.equal(signal.strategyId, "macd-crossover");
    assert.equal(signal.tpPrices.length, 0);
    assert.equal(signal.minRewardRisk, 0);
    assert.equal(signal.slPrice, undefined);
    assert.ok((signal.meta?.macdHist ?? 0) > 0);
    assert.ok((signal.meta?.emaFast ?? 0) > (signal.meta?.emaSlow ?? 0));
  });

  it("holds an open long while the histogram stays positive", () => {
    const candles = bars(compoundingRise());
    const signal = evalAt(candles, macdCrossoverParamsFor(), {
      positionSide: "long",
      entryPrice: 150,
    });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /Long holds/);
  });

  it("sells an open long when the histogram is negative", () => {
    const candles = bars(reversal());
    const open = evalAt(candles, macdCrossoverParamsFor(), {
      positionSide: "long",
      entryPrice: 350,
    });
    assert.equal(open.side, "SELL", open.reason);
    assert.match(open.reason, /crossed down/);
  });

  it("stays flat on a short setup when direction is long only", () => {
    const candles = bars(reversal());
    const signal = evalAt(candles, { ...macdCrossoverParamsFor(), direction: 1 }, { perpsFees });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /long only/);
    const open = evalAt(
      candles,
      { ...macdCrossoverParamsFor(), direction: 1 },
      {
        positionSide: "long",
        entryPrice: 350,
      },
    );
    assert.equal(open.side, "SELL", open.reason);
  });

  it("stays flat on a long setup when direction is short only", () => {
    const candles = bars(compoundingRise());
    const signal = evalAt(candles, { ...macdCrossoverParamsFor(), direction: 2 }, { perpsFees });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /short only/);
    const open = evalAt(
      candles,
      { ...macdCrossoverParamsFor(), direction: 2 },
      {
        positionSide: "short",
        entryPrice: 180,
      },
    );
    assert.equal(open.side, "BUY", open.reason);
  });

  it("sells a downtrend with a negative histogram when perps fees are known", () => {
    const candles = bars(reversal());
    const blocked = evalAt(candles, macdCrossoverParamsFor());
    assert.equal(blocked.side, "HOLD", blocked.reason);
    assert.match(blocked.reason, /perps fee schedule missing/);
    const signal = evalAt(candles, macdCrossoverParamsFor(), { perpsFees });
    assert.equal(signal.side, "SELL", signal.reason);
    assert.match(signal.reason, /downtrend/);
    assert.ok((signal.meta?.macdHist ?? 0) < 0);
    assert.ok((signal.meta?.emaFast ?? 0) < (signal.meta?.emaSlow ?? 0));
  });

  it("ignores a negative histogram while the fast average is still above the trend", () => {
    const candles = bars(pullback());
    const signal = evalAt(candles, macdCrossoverParamsFor(), { perpsFees });
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /MACD down ignored/);
    const open = evalAt(candles, macdCrossoverParamsFor(), {
      positionSide: "long",
      entryPrice: 400,
    });
    assert.equal(open.side, "SELL", open.reason);
  });

  it("ignores a positive histogram while the fast average is still under the trend", () => {
    const strategy: MacdCrossoverParams = {
      ...macdCrossoverParamsFor(),
      fastPeriod: 4,
      slowPeriod: 10,
      signalPeriod: 4,
      pricePeriod: 2,
      trendPeriod: 40,
    };
    const closes = [...ramp(80, 200, -1), ...ramp(8, 120, 0.4)];
    const candles = bars(closes, "1h");
    const last = closes.length - 1;
    const histogram = macd(closes, strategy.fastPeriod, strategy.slowPeriod, strategy.signalPeriod)
      .histogram[last];
    const px = ema(closes, strategy.pricePeriod)[last];
    const trend = ema(closes, strategy.trendPeriod)[last];
    assert.ok(histogram != null && histogram > 0, `histogram ${histogram}`);
    assert.ok(px != null && trend != null && px <= trend, `px ${px} trend ${trend}`);
    const signal = evalAt(candles, strategy);
    assert.equal(signal.side, "HOLD", signal.reason);
    assert.match(signal.reason, /MACD up ignored/);
  });

  it("covers a short when the histogram turns positive and holds it while the histogram stays negative", () => {
    const up = bars(compoundingRise());
    const cover = evalAt(up, macdCrossoverParamsFor(), {
      positionSide: "short",
      entryPrice: 180,
    });
    assert.equal(cover.side, "BUY", cover.reason);
    assert.match(cover.reason, /crossed up/);
    const down = bars(reversal());
    const held = evalAt(down, macdCrossoverParamsFor(), {
      positionSide: "short",
      entryPrice: 250,
    });
    assert.equal(held.side, "HOLD", held.reason);
    assert.match(held.reason, /Short holds/);
    const earlyCover = evalAt(bars(compoundingFall()), macdCrossoverParamsFor(), {
      positionSide: "short",
      entryPrice: 200,
    });
    assert.equal(earlyCover.side, "BUY", earlyCover.reason);
    assert.match(earlyCover.reason, /crossed up/);
  });

  it("waits until the trend EMA and the histogram are warm", () => {
    const signal = evalAt(bars(ramp(50, 100, 0.1)), macdCrossoverParamsFor());
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /not warm/);
  });

  it("ignores a forming bar and reads the last closed one", () => {
    const closed = bars(compoundingRise());
    const last = closed[closed.length - 1]!;
    const forming = createCandle({
      time: last.time + FOUR_HOURS,
      open: 20,
      high: 21,
      low: 10,
      close: 12,
      volume: 10,
      timeframe: "4h",
    });
    const signal = evaluateMacdCrossover({
      pair: "SOL/USDC",
      candles: [...closed, forming],
      strategy: macdCrossoverParamsFor(),
      price: forming.close,
      at: new Date((forming.time + 60) * 1000),
    });
    assert.equal(signal.side, "BUY", signal.reason);
    assert.equal(signal.meta?.barLow, forming.low);
    assert.equal(signal.meta?.barHigh, forming.high);
  });

  it("holds when direction is not 0, 1, or 2", () => {
    const signal = evalAt(bars(ramp(30, 100, 1)), {
      ...macdCrossoverParamsFor(),
      direction: 3,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /Direction must be 0/);
  });

  it("holds when the periods cannot build a MACD", () => {
    const signal = evalAt(bars(ramp(30, 100, 1)), {
      ...macdCrossoverParamsFor(),
      fastPeriod: 20,
      slowPeriod: 10,
    });
    assert.equal(signal.side, "HOLD");
    assert.match(signal.reason, /fast period/);
  });
});

describe("MacdCrossoverStrategy", () => {
  it("uses registry id macd-crossover and the 4h MACD 12/26/9 defaults", () => {
    const strategy = new MacdCrossoverStrategy();
    const params = macdCrossoverParamsFor();
    assert.equal(strategy.getId(), "macd-crossover");
    assert.equal(strategyModule.id, strategy.getId());
    assert.equal(
      strategy.getDisplayName(),
      `macd-crossover (${params.timeframe} MACD ${params.fastPeriod}/${params.slowPeriod}/${params.signalPeriod} EMA${params.pricePeriod}/${params.trendPeriod} both)`,
    );
    assert.equal(strategy.getRequiredCandles().timeframe, "4h");
    assert.equal(strategy.getRequiredCandles().count, params.trendPeriod * 3 + 1);
    const defaults = strategy.getSearchDefaults();
    for (const axis of strategy.axes) {
      assert.ok(axis.levels.includes(defaults[axis.key]!));
    }
    assert.equal(strategy.accept({ fastPeriod: 12, slowPeriod: 26, direction: 0 }), true);
    assert.equal(strategy.accept({ fastPeriod: 26, slowPeriod: 12 }), false);
    assert.equal(strategy.accept({ direction: 3 }), false);
    const patch = strategy.paramPatch({ direction: 2, timeframe: 1440 });
    assert.equal(patch.values?.["direction"], 2);
    assert.equal(patch.timeframe, "1d");
  });

  it("passes perps fees through to a new short", () => {
    const strategy = new MacdCrossoverStrategy();
    const candles = bars(reversal());
    const last = candles[candles.length - 1]!;
    const signal = strategy.evaluateSignal(
      "SOL/USDC",
      candles,
      { pair: "SOL/USDC", price: last.close, trend: "bearish", volatility: "high" },
      last.close,
      new Date((last.time + last.intervalSeconds) * 1000),
      undefined,
      perpsFees,
    );
    assert.equal(signal.side, "SELL", signal.reason);
  });

  it("renders the price EMAs and the histogram", () => {
    const strategy = new MacdCrossoverStrategy();
    const svg = strategy.buildChartSvg("SOL/USDC", bars(ramp(30, 100, 1)));
    assert.match(svg, /<svg/);
    assert.match(svg, /EMA2/);
    assert.match(svg, /EMA200/);
    assert.match(svg, /MACD histogram/);
  });

  it("rejects an empty chart", () => {
    assert.throws(() => new MacdCrossoverStrategy().buildChartSvg("SOL/USDC", []), /empty/);
  });
});
