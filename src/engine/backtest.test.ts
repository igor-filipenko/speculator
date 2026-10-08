import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useTestDb } from "../db/test-db.js";
import type { AppConfig } from "../config.js";
import { TIER_COSTS, emulateFillPrice } from "../exchange/emulated/emulated-quote.js";
import { PaperPortfolio } from "../portfolio/paper/portfolio.js";
import { GenericRiskManager } from "../strategy/risk-manager.js";
import {
  evaluateMarketIndicators,
  htfParamsFor,
  loadStrategy,
  SimpleStrategyManager,
} from "../strategy/strategy-manager.js";
import type {
  Candle,
  MarketIndicators,
  Order,
  RiskManager,
  Signal,
  SignalSide,
  Strategy,
  StrategyManager,
  Trade,
} from "../types.js";
import {
  countRoundTripsBySide,
  parseBacktestArgs,
  parseBacktestDate,
  runBacktest,
  computeBuyHoldEquity,
  roundTripHoldMs,
} from "./backtest.js";
import { intraBarPrices } from "../backtest/intra-bar.js";

const SOL_USDC_POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";

function makeConfig(cash = 1000): AppConfig {
  return {
    strategy: "bollinger",
    htf: "4h",
    jupiterApiKey: "",
    watchlist: ["SOL/USDC"],
    pollIntervalMs: 60_000,
    paperCashUsdc: cash,
    botId: "test",
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    slippageBps: 50,
    solReserveMin: 0.03,
    solReserveMax: 0.05,
    pairs: [
      {
        symbol: "SOL/USDC",
        baseMint: "So11111111111111111111111111111111111111112",
        quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        baseDecimals: 9,
        quoteDecimals: 6,
        geckoPoolAddress: SOL_USDC_POOL,
      },
    ],
  };
}

function makeRisk(): GenericRiskManager {
  return new GenericRiskManager();
}

function htfAwareManager(strategy: Strategy): StrategyManager {
  const params = htfParamsFor("4h");
  const riskManager: RiskManager = new GenericRiskManager();
  return {
    getActiveStrategy: () => strategy,
    getActiveRiskManager: () => riskManager,
    getRequiredHtfCandles: () => ({ timeframe: "4h", count: 220 }),
    getRequiredMtfCandles: () => ({ timeframe: "1h" as const, count: 120 }),
    evaluate: (pair, htfCandles, mtfCandles, price, at): MarketIndicators =>
      evaluateMarketIndicators({
        pair,
        candles: htfCandles,
        mtfCandles,
        price,
        at,
        params,
      }),
    applyMarketIndicators: (state, prev) => Promise.resolve(prev?.trend !== state.trend),
  };
}

/** Test adapter: wrap a fixture Strategy the same way ticks read StrategyManager. */
function managerFor(strategy: Strategy, riskManager: RiskManager = makeRisk()): StrategyManager {
  return {
    getActiveStrategy: () => strategy,
    getActiveRiskManager: () => riskManager,
    getRequiredHtfCandles: () => ({ timeframe: "4h", count: 220 }),
    getRequiredMtfCandles: () => ({ timeframe: "1h" as const, count: 120 }),
    evaluate: (pair, candles, _mtfCandles, price): MarketIndicators => ({
      pair,
      price,
      trend: "unknown",
      volatility: "unknown",
      htf: { timeframe: "4h", candles },
    }),
    applyMarketIndicators: () => Promise.resolve(false),
  };
}

function scriptedStrategy(opts: {
  buyIndex: number;
  /** Distance below the buy price stored as slPrice when withStop is set. */
  stopDistance?: number;
  withStop?: boolean;
}): Strategy {
  const stopDistance = opts.stopDistance ?? 100;
  return {
    getDisplayName: () => "scripted",
    getId: () => "bollinger",
    getRequiredCandles: () => ({ timeframe: "15m", count: 2 }),
    evaluateSignal: (pair, candles, _market, price, at) => {
      const last = candles[candles.length - 1]!;
      const i = candles.length - 1;
      const side: SignalSide = i === opts.buyIndex ? "BUY" : "HOLD";
      const signal: Signal = {
        pair,
        side,
        reason: side === "BUY" ? "scripted buy" : "hold",
        price,
        at,
        strategyId: "bollinger",
        tpPrices: [],
        minRewardRisk: 0.1,
        meta: { atr: 1, barLow: last.low, barHigh: last.high },
      };
      if (opts.withStop && side === "BUY") {
        signal.slPrice = price - stopDistance;
      }
      return signal;
    },
    buildChartSvg: () => "<svg></svg>",
  };
}

function series(count: number, startPrice: number, delta: number, start = 1_700_000_000): Candle[] {
  const interval = 15 * 60;
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price += delta;
    candles.push({
      time: start + i * interval,
      open: price - delta / 2,
      high: price + 0.5,
      low: price - 0.5,
      close: price,
      volume: 10,
    });
  }
  return candles;
}

function htfSeries(count: number, startPrice: number, delta: number, start: number): Candle[] {
  const interval = 4 * 60 * 60;
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price += delta;
    const close = price;
    candles.push({
      time: start + i * interval,
      open: close - delta / 2,
      high: close + Math.abs(delta) + 0.2,
      low: close - Math.abs(delta) - 0.2,
      close,
      volume: 1,
    });
  }
  return candles;
}

describe("parseBacktestArgs", () => {
  it("parses --force-refresh and --verbose", () => {
    assert.deepEqual(parseBacktestArgs(["--force-refresh"]), {
      forceRefresh: true,
      verbose: false,
    });
    assert.deepEqual(parseBacktestArgs(["--verbose"]), {
      forceRefresh: false,
      verbose: true,
    });
    assert.deepEqual(parseBacktestArgs(["-v"]), {
      forceRefresh: false,
      verbose: true,
    });
    assert.deepEqual(parseBacktestArgs([]), {
      forceRefresh: false,
      verbose: false,
    });
  });

  it("parses --from/--to as DD-MM-YYYY and YYYY-MM-DD", () => {
    const dmy = parseBacktestArgs(["--from", "01-01-2026", "--to", "01-08-2026"]);
    assert.equal(dmy.fromTime, Date.UTC(2026, 0, 1) / 1000);
    // --to is exclusive end of next day after 01-08-2026 → 2026-08-02 00:00 UTC
    assert.equal(dmy.toTime, Date.UTC(2026, 7, 2) / 1000);

    const ymd = parseBacktestArgs(["--from=2026-01-01", "--to=2026-08-01"]);
    assert.equal(ymd.fromTime, Date.UTC(2026, 0, 1) / 1000);
    assert.equal(ymd.toTime, Date.UTC(2026, 7, 2) / 1000);
  });

  it("rejects invalid flags and conflicting window options", () => {
    assert.throws(() => parseBacktestArgs(["--unknown"]), /Unknown/);
    assert.throws(() => parseBacktestArgs(["--days", "7"]), /Unknown/);
    assert.throws(() => parseBacktestArgs(["--to", "2026-08-01"]), /requires --from/);
    assert.throws(
      () => parseBacktestArgs(["--from", "01-08-2026", "--to", "01-01-2026"]),
      /from must be before/,
    );
  });
});

describe("parseBacktestDate", () => {
  it("treats date-only --from as UTC midnight and --to as next-day exclusive", () => {
    assert.equal(parseBacktestDate("2026-01-01", "from"), Date.UTC(2026, 0, 1) / 1000);
    assert.equal(parseBacktestDate("01-01-2026", "from"), Date.UTC(2026, 0, 1) / 1000);
    assert.equal(parseBacktestDate("01-08-2026", "to"), Date.UTC(2026, 7, 2) / 1000);
  });
});

function tradeFill(side: "BUY" | "SELL", at: string, realizedPnl?: number): Trade {
  return {
    pair: "SOL/USDC",
    side,
    price: 100,
    size: 1,
    at: new Date(at),
    simulated: true,
    ...(realizedPnl !== undefined ? { realizedPnl } : {}),
  };
}

describe("roundTripHoldMs", () => {
  it("measures close minus open for each completed trip", () => {
    const holds = roundTripHoldMs([
      tradeFill("BUY", "2026-01-01T00:00:00.000Z"),
      tradeFill("SELL", "2026-01-01T01:30:00.000Z", 1),
      tradeFill("SELL", "2026-01-02T00:00:00.000Z"),
      tradeFill("BUY", "2026-01-02T00:15:00.000Z", -0.5),
    ]);
    assert.deepEqual(holds, [90 * 60 * 1000, 15 * 60 * 1000]);
  });

  it("ignores an open that never closes", () => {
    assert.deepEqual(roundTripHoldMs([tradeFill("BUY", "2026-01-01T00:00:00.000Z")]), []);
  });
});

describe("countRoundTripsBySide", () => {
  it("counts long and short completed trips", () => {
    assert.deepEqual(
      countRoundTripsBySide([
        tradeFill("BUY", "2026-01-01T00:00:00.000Z"),
        tradeFill("SELL", "2026-01-01T01:30:00.000Z", 1),
        tradeFill("SELL", "2026-01-02T00:00:00.000Z"),
        tradeFill("BUY", "2026-01-02T00:15:00.000Z", -0.5),
        tradeFill("BUY", "2026-01-03T00:00:00.000Z"),
      ]),
      { longs: 1, shorts: 1 },
    );
  });
});

describe("computeBuyHoldEquity", () => {
  it("applies round-trip emulated costs on flat price", () => {
    const hold = computeBuyHoldEquity(500, 100, 100, "SOL/USDC");
    assert.ok(hold < 500);
    assert.ok(hold > 490);
  });

  it("tracks price appreciation minus costs", () => {
    const hold = computeBuyHoldEquity(1000, 100, 120, "SOL/USDC");
    assert.ok(hold > 1000);
    const naive = 1000 * (120 / 100);
    assert.ok(hold < naive);
  });
});

describe("runBacktest", () => {
  it("replays fixture candles with emulated costs and no paper-state writes", async () => {
    const candles = series(20, 100, 0.2);
    const startingCash = 1000;
    const buyIndex = 5;
    const strategy = scriptedStrategy({ buyIndex });
    const [result] = await runBacktest({
      config: makeConfig(startingCash),
      strategyManager: managerFor(strategy),
      candles,
    });

    assert.ok(result);
    assert.equal(result.metrics.pair, "SOL/USDC");
    assert.equal(result.metrics.candleCount, candles.length);
    assert.equal(result.candles.length, candles.length);
    assert.equal(result.metrics.strategy.getId(), "bollinger");
    assert.ok(result.equityCurve.length === candles.length);

    assert.ok(result.trades.length >= 1);
    const buy = result.trades[0];
    assert.ok(buy);
    assert.equal(buy.side, "BUY");
    assert.equal(buy.simulated, true);

    const buyBar = candles[buyIndex];
    assert.ok(buyBar);
    assert.equal(Math.floor(buy.at.getTime() / 1000), buyBar.time);
    const firstTick = intraBarPrices(buyBar)[0];
    assert.ok(firstTick);
    const emulated = emulateFillPrice({ side: "BUY", close: firstTick, tier: "liquid" });
    assert.ok(Math.abs(buy.price - emulated.fillPrice) < 1e-9);

    const midSize = startingCash / firstTick;
    assert.ok(buy.size < midSize);

    assert.ok(result.metrics.costs.slippageUsdc > 0);
    assert.ok(result.metrics.costs.poolFeeUsdc > 0);
    assert.ok(result.metrics.costs.priorityFeeUsdc > 0);

    const adverse = TIER_COSTS.liquid.slippage + TIER_COSTS.liquid.poolFee;
    assert.ok(adverse > 0);
  });

  it("ATR-exits on HOLD when stop level is hit after price crashes", async () => {
    const candles = series(40, 100, 0.2);
    const last = candles[candles.length - 1]!;
    candles.push({
      time: last.time + 15 * 60,
      open: last.close,
      high: last.close,
      low: last.close - 20,
      close: last.close - 15,
      volume: 5,
    });

    const strategy = scriptedStrategy({
      buyIndex: 20,
      withStop: true,
      stopDistance: 0.5,
    });

    const [result] = await runBacktest({
      config: makeConfig(1000),
      strategyManager: managerFor(strategy),
      candles,
    });
    assert.ok(result);
    assert.ok(result.trades.some((t) => t.side === "BUY"));
    const stopSell = result.trades.find(
      (t) => t.side === "SELL" && t.reason?.includes("hard stop"),
    );
    assert.ok(stopSell);
    assert.match(stopSell.reason ?? "", /hard stop hit/);
    assert.ok(result.metrics.roundTripMinMs > 0);
    assert.equal(result.metrics.roundTripMinMs, result.metrics.roundTripMaxMs);
    assert.equal(result.metrics.roundTripAvgMs, result.metrics.roundTripMinMs);
  });

  it("keeps flat equity when indicators never fire", async () => {
    await useTestDb();
    const strategy = await loadStrategy("bollinger", "flat", "low");
    const needed = strategy.getRequiredCandles().count + 10;
    const start = 1_700_000_000;
    const interval = 15 * 60;
    const candles: Candle[] = Array.from({ length: needed }, (_, i) => ({
      time: start + i * interval,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
    }));

    const [result] = await runBacktest({
      config: makeConfig(500),
      strategyManager: await SimpleStrategyManager.create({ strategyId: "bollinger", htf: "4h" }),
      candles,
    });

    assert.ok(result);
    assert.equal(result.trades.length, 0);
    assert.equal(result.metrics.roundTripMinMs, 0);
    assert.equal(result.metrics.roundTripMaxMs, 0);
    assert.equal(result.metrics.roundTripAvgMs, 0);
    assert.equal(result.metrics.endingEquity, 500);
    assert.equal(result.metrics.totalReturnPct, 0);
    assert.ok(result.metrics.holdEquity < 500);
    assert.ok(result.metrics.vsHoldUsdc > 0);
    assert.ok(result.metrics.vsHoldReturnPct > 0);
  });

  it("fills a scripted BUY when HTF trend is bearish", async () => {
    const intervalHtf = 4 * 60 * 60;
    const ltfStart = 1_700_000_000;
    const htf = htfSeries(250, 250, -0.8, ltfStart - 250 * intervalHtf);
    const ltf = series(20, 100, 0.1);
    const [result] = await runBacktest({
      config: makeConfig(1000),
      strategyManager: htfAwareManager(scriptedStrategy({ buyIndex: 5 })),
      candles: ltf,
      htfCandles: htf,
    });
    assert.ok(result);
    assert.ok(result.trades.some((t) => t.side === "BUY"));
  });

  it("allows BUY when HTF trend is bullish", async () => {
    const intervalHtf = 4 * 60 * 60;
    const ltfStart = 1_700_000_000;
    const htf = htfSeries(250, 50, 0.8, ltfStart - 250 * intervalHtf);
    const ltf = series(20, 100, 0.1);
    const [result] = await runBacktest({
      config: makeConfig(1000),
      strategyManager: htfAwareManager(scriptedStrategy({ buyIndex: 5 })),
      candles: ltf,
      htfCandles: htf,
    });
    assert.ok(result);
    assert.ok(result.trades.some((t) => t.side === "BUY"));
  });

  it("evaluates a forming last candle along the green/red OHLC path", async () => {
    const start = 1_700_000_000;
    const interval = 15 * 60;
    const green: Candle = {
      time: start,
      open: 100,
      high: 104,
      low: 98,
      close: 103,
      volume: 5,
    };
    const red: Candle = {
      time: start + interval,
      open: 103,
      high: 105,
      low: 97,
      close: 99,
      volume: 5,
    };
    const calls: { price: number; last: Candle }[] = [];
    const strategy: Strategy = {
      getDisplayName: () => "recorder",
      getId: () => "bollinger",
      getRequiredCandles: () => ({ timeframe: "15m", count: 2 }),
      evaluateSignal: (pair, window, _market, price, at) => {
        calls.push({ price, last: window[window.length - 1]! });
        return {
          pair,
          strategyId: "bollinger",
          side: "HOLD" as const,
          reason: "record",
          price,
          at,
          tpPrices: [],
          minRewardRisk: 0.1,
        };
      },
      buildChartSvg: () => "<svg></svg>",
    };

    await runBacktest({
      config: makeConfig(1000),
      strategyManager: managerFor(strategy),
      candles: [green, red],
    });

    const greenCalls = calls.filter((c) => c.last.time === green.time);
    assert.deepEqual(
      greenCalls.map((c) => c.price),
      [100, 98, 101, 104, 103],
    );
    assert.deepEqual(greenCalls[0]!.last, { ...green, high: 100, low: 100, close: 100 });
    assert.deepEqual(greenCalls[1]!.last, { ...green, high: 100, low: 98, close: 98 });
    assert.deepEqual(greenCalls[2]!.last, { ...green, high: 101, low: 98, close: 101 });
    assert.deepEqual(greenCalls[3]!.last, { ...green, high: 104, low: 98, close: 104 });
    assert.deepEqual(greenCalls[4]!.last, green);

    const redCalls = calls.filter((c) => c.last.time === red.time);
    assert.deepEqual(
      redCalls.map((c) => c.price),
      [103, 105, 101, 97, 99],
    );
    assert.deepEqual(redCalls[0]!.last, { ...red, high: 103, low: 103, close: 103 });
    assert.deepEqual(redCalls[1]!.last, { ...red, high: 105, low: 103, close: 105 });
    assert.deepEqual(redCalls[2]!.last, { ...red, high: 105, low: 101, close: 101 });
    assert.deepEqual(redCalls[3]!.last, { ...red, high: 105, low: 97, close: 97 });
    assert.deepEqual(redCalls[4]!.last, red);
  });

  it("fills a wick BUY at the intra-bar low, not the close", async () => {
    const start = 1_700_000_000;
    const interval = 15 * 60;
    const warmup: Candle[] = Array.from({ length: 3 }, (_, i) => ({
      time: start + i * interval,
      open: 100,
      high: 100.2,
      low: 99.8,
      close: 100,
      volume: 1,
    }));
    const wickBar: Candle = {
      time: start + 3 * interval,
      open: 100,
      high: 101,
      low: 95,
      close: 100.5,
      volume: 1,
    };
    const strategy: Strategy = {
      getDisplayName: () => "wick-buy",
      getId: () => "bollinger",
      getRequiredCandles: () => ({ timeframe: "15m", count: 2 }),
      evaluateSignal: (pair, window, _market, price, at) => {
        const last = window[window.length - 1]!;
        const side: SignalSide =
          last.time === wickBar.time && price === last.low && last.low < last.open ? "BUY" : "HOLD";
        return {
          pair,
          strategyId: "bollinger",
          side,
          reason: side === "BUY" ? "wick" : "hold",
          price,
          at,
          tpPrices: [],
          minRewardRisk: 0.1,
          meta: { atr: 1, barLow: last.low, barHigh: last.high },
        };
      },
      buildChartSvg: () => "<svg></svg>",
    };

    const [result] = await runBacktest({
      config: makeConfig(1000),
      strategyManager: managerFor(strategy),
      candles: [...warmup, wickBar],
    });
    assert.ok(result);
    const buy = result.trades.find((t) => t.side === "BUY");
    assert.ok(buy);
    const emulated = emulateFillPrice({ side: "BUY", close: wickBar.low, tier: "liquid" });
    assert.ok(Math.abs(buy.price - emulated.fillPrice) < 1e-9);
    assert.ok(buy.price < wickBar.close);
  });
});

describe("PaperPortfolio applyOrder", () => {
  it("applies BUY/SELL orders with priority fee already sized by exchange", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const buyOrder: Order = {
      pair: "SOL/USDC",
      type: "market",
      intent: "open-long",
      reason: "test",
      price: 100,
      size: 9.9,
      at: new Date("2026-01-01T00:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 10,
    };
    const buy = portfolio.applyOrderSync(buyOrder);
    assert.ok(buy);
    assert.equal(buy.size, 9.9);

    const sellOrder: Order = {
      pair: "SOL/USDC",
      type: "market",
      intent: "close-long",
      reason: "test",
      price: 110,
      size: 9.9,
      at: new Date("2026-01-01T01:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 5,
    };
    const sell = portfolio.applyOrderSync(sellOrder);
    assert.ok(sell);
    assert.equal(sell.realizedPnl, 9.9 * 110 - 5 - 9.9 * 100 - 10);
  });
});
