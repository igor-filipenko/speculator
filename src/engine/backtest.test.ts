import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../config.js";
import { TIER_COSTS, emulateFillPrice } from "../exchange/emulated-quote.js";
import { PaperPortfolio } from "../paper/portfolio.js";
import { GenericRiskManager, HighRiskManager } from "../risk/risk-manager.js";
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
  RiskParams,
  SignalSide,
  Strategy,
  StrategyManager,
} from "../types.js";
import {
  parseBacktestArgs,
  parseBacktestDate,
  runBacktest,
  computeBuyHoldEquity,
} from "./backtest.js";

const SOL_USDC_POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";

function makeConfig(cash = 1000): AppConfig {
  return {
    strategy: "bollinger",
    htf: "4h",
    jupiterApiKey: "",
    watchlist: ["SOL/USDC"],
    pollIntervalMs: 60_000,
    paperCashUsdc: cash,
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    slippageBps: 50,
    liveSolReserveSol: 0.05,
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

function makeRisk(strategy: Strategy): GenericRiskManager {
  return new GenericRiskManager(strategy.getRiskParams());
}

function htfAwareManager(strategy: Strategy): StrategyManager {
  const params = htfParamsFor("4h");
  let riskManager: RiskManager = new GenericRiskManager(strategy.getRiskParams());
  return {
    getActiveStrategy: () => strategy,
    getActiveRiskManager: () => riskManager,
    getRequiredCandles: () => ({ timeframe: "4h", count: 220 }),
    evaluate: (pair, candles, price, at): MarketIndicators =>
      evaluateMarketIndicators({
        pair,
        candles,
        price,
        at,
        params,
      }),
    applyMarketIndicators: (state, prev) => {
      riskManager =
        state.trend === "bullish"
          ? new GenericRiskManager(strategy.getRiskParams())
          : new HighRiskManager(`trend is ${state.trend}`, strategy.getRiskParams());
      return prev?.trend !== state.trend;
    },
  };
}

/** Test adapter: wrap a fixture Strategy the same way ticks read StrategyManager. */
function managerFor(
  strategy: Strategy,
  riskManager: RiskManager = makeRisk(strategy),
): StrategyManager {
  return {
    getActiveStrategy: () => strategy,
    getActiveRiskManager: () => riskManager,
    getRequiredCandles: () => ({ timeframe: "4h", count: 220 }),
    evaluate: (pair, candles, price, at): MarketIndicators => ({
      pair,
      timeframe: "4h",
      at,
      price,
      trend: "unknown",
      candles,
    }),
    applyMarketIndicators: () => false,
  };
}

function scriptedStrategy(opts: { buyIndex: number; risk?: Partial<RiskParams> }): Strategy {
  const risk: RiskParams = {
    timeframe: "15m",
    atrStopMult: 100,
    atrTrailMult: 100,
    cooldownBars: 0,
    minHoldBars: 0,
    ...opts.risk,
  };
  return {
    getDisplayName: () => "scripted",
    getMode: () => "bollinger",
    getRiskParams: () => risk,
    getRequiredCandles: () => ({ timeframe: "15m", count: 2 }),
    evaluateSignal: (pair, candles, price, at) => {
      const last = candles[candles.length - 1]!;
      const i = candles.length - 1;
      const side: SignalSide = i === opts.buyIndex ? "BUY" : "HOLD";
      return {
        pair,
        side,
        reason: side === "BUY" ? "scripted buy" : "hold",
        price,
        at,
        meta: { atr: 1, barLow: last.low, barHigh: last.high },
      };
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
  it("parses --days and --force-refresh", () => {
    assert.deepEqual(parseBacktestArgs(["--days", "14", "--force-refresh"]), {
      days: 14,
      forceRefresh: true,
      ignoreTrend: false,
    });
    assert.deepEqual(parseBacktestArgs(["--days=7"]), {
      days: 7,
      forceRefresh: false,
      ignoreTrend: false,
    });
    assert.deepEqual(parseBacktestArgs([]), {
      days: 0,
      forceRefresh: false,
      ignoreTrend: false,
    });
    assert.deepEqual(parseBacktestArgs(["--ignore-trend"]), {
      days: 0,
      forceRefresh: false,
      ignoreTrend: true,
    });
  });

  it("parses --from/--to as DD-MM-YYYY and YYYY-MM-DD", () => {
    const dmy = parseBacktestArgs(["--from", "01-01-2026", "--to", "01-08-2026"]);
    assert.equal(dmy.days, 0);
    assert.equal(dmy.fromTime, Date.UTC(2026, 0, 1) / 1000);
    // --to is exclusive end of next day after 01-08-2026 → 2026-08-02 00:00 UTC
    assert.equal(dmy.toTime, Date.UTC(2026, 7, 2) / 1000);

    const ymd = parseBacktestArgs(["--from=2026-01-01", "--to=2026-08-01"]);
    assert.equal(ymd.fromTime, Date.UTC(2026, 0, 1) / 1000);
    assert.equal(ymd.toTime, Date.UTC(2026, 7, 2) / 1000);
  });

  it("rejects invalid flags and conflicting window options", () => {
    assert.throws(() => parseBacktestArgs(["--days"]), /requires/);
    assert.throws(() => parseBacktestArgs(["--unknown"]), /Unknown/);
    assert.throws(() => parseBacktestArgs(["--to", "2026-08-01"]), /requires --from/);
    assert.throws(
      () => parseBacktestArgs(["--days", "7", "--from", "2026-01-01"]),
      /either --days or --from/,
    );
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
      days: 30,
    });

    assert.ok(result);
    assert.equal(result.metrics.pair, "SOL/USDC");
    assert.equal(result.metrics.candleCount, candles.length);
    assert.equal(result.candles.length, candles.length);
    assert.equal(result.metrics.strategy.getMode(), "bollinger");
    assert.ok(result.equityCurve.length === candles.length);

    assert.ok(result.trades.length >= 1);
    const buy = result.trades[0];
    assert.ok(buy);
    assert.equal(buy.side, "BUY");
    assert.equal(buy.simulated, true);

    const buyBar = candles.find((c) => c.time === Math.floor(buy.at.getTime() / 1000));
    assert.ok(buyBar);
    const emulated = emulateFillPrice({ side: "BUY", close: buyBar.close, tier: "liquid" });
    assert.ok(Math.abs(buy.price - emulated.fillPrice) < 1e-9);

    const midSize = startingCash / buyBar.close;
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
      risk: { atrStopMult: 1.5, atrTrailMult: 50 },
    });

    const [result] = await runBacktest({
      config: makeConfig(1000),
      strategyManager: managerFor(strategy),
      candles,
    });
    assert.ok(result);
    assert.ok(result.trades.some((t) => t.side === "BUY"));
    const stopSell = result.trades.find((t) => t.side === "SELL" && t.reason?.includes("ATR"));
    assert.ok(stopSell);
    assert.match(stopSell.reason ?? "", /ATR stop/);
  });

  it("keeps flat equity when indicators never fire", async () => {
    const strategy = loadStrategy("bollinger");
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
      strategyManager: new SimpleStrategyManager({ strategyMode: "bollinger", htf: "4h" }),
      candles,
    });

    assert.ok(result);
    assert.equal(result.trades.length, 0);
    assert.equal(result.metrics.endingEquity, 500);
    assert.equal(result.metrics.totalReturnPct, 0);
    assert.ok(result.metrics.holdEquity < 500);
    assert.ok(result.metrics.vsHoldUsdc > 0);
    assert.ok(result.metrics.vsHoldReturnPct > 0);
  });

  it("evaluates HTF market state and blocks BUY when trend is not bullish", async () => {
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
    assert.equal(result.trades.filter((t) => t.side === "BUY").length, 0);
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

  it("skips HTF apply and log when ignoreTrend is set", async () => {
    const intervalHtf = 4 * 60 * 60;
    const ltfStart = 1_700_000_000;
    const htf = htfSeries(250, 250, -0.8, ltfStart - 250 * intervalHtf);
    const ltf = series(20, 100, 0.1);
    const [result] = await runBacktest({
      config: makeConfig(1000),
      strategyManager: htfAwareManager(scriptedStrategy({ buyIndex: 5 })),
      candles: ltf,
      htfCandles: htf,
      ignoreTrend: true,
    });
    assert.ok(result);
    assert.ok(result.trades.some((t) => t.side === "BUY"));
  });
});

describe("PaperPortfolio applyOrder", () => {
  it("applies BUY/SELL orders with priority fee already sized by exchange", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const buyOrder: Order = {
      pair: "SOL/USDC",
      side: "BUY",
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
      side: "SELL",
      reason: "test",
      price: 110,
      size: 9.9,
      at: new Date("2026-01-01T01:00:00.000Z"),
      simulated: true,
      priorityFeeUsdc: 5,
    };
    const sell = portfolio.applyOrderSync(sellOrder);
    assert.ok(sell);
    assert.equal(sell.realizedPnl, 9.9 * 110 - 5 - 9.9 * 100);
  });
});
