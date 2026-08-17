import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../config.js";
import { TIER_COSTS, emulateFillPrice } from "../exchange/emulated-quote.js";
import { PaperPortfolio } from "../paper/portfolio.js";
import { SimpleRiskManager } from "../risk/risk-manager.js";
import { evaluateEmaRsi, emaRsiParamsFor, type EmaRsiParams } from "../strategy/ema-rsi.js";
import { buildOhlcvSvg } from "../strategy/ema-rsi-svg.js";
import { loadStrategy } from "../strategy/strategy.js";
import type { Candle, Order, RiskParams, Strategy } from "../types.js";
import { parseBacktestArgs, parseBacktestDate, runBacktest } from "./backtest.js";

const SOL_USDC_POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";

function makeConfig(cash = 1000): AppConfig {
  return {
    strategy: "ema-rsi",
    jupiterApiKey: "",
    watchlist: ["SOL/USDC"],
    pollIntervalMs: 60_000,
    paperCashUsdc: cash,
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

function makeRisk(strategy: Strategy): SimpleRiskManager {
  return new SimpleRiskManager(strategy.getRiskParams());
}

function makeStrategy(
  signalOverrides: Partial<EmaRsiParams> = {},
  riskOverrides: Partial<RiskParams> = {},
): Strategy {
  const params: EmaRsiParams = { ...emaRsiParamsFor(), ...signalOverrides };
  const risk: RiskParams = { ...loadStrategy("ema-rsi").getRiskParams(), ...riskOverrides };
  return {
    getDisplayName: () => `ema-rsi (${params.timeframe})`,
    getMode: () => "ema-rsi",
    getRiskParams: () => risk,
    getRequiredCandles: () => ({
      timeframe: params.timeframe,
      count:
        Math.max(params.emaSlow, params.trendEmaPeriod, params.atrPeriod, params.adxPeriod * 2) +
        params.rsiPeriod +
        5,
    }),
    evaluateSignal: (pair, candles, price, at) =>
      evaluateEmaRsi({ pair, candles, strategy: params, price, at }),
    buildChartSvg: (pair, candles) => buildOhlcvSvg({ pair, candles, strategy: params }),
  };
}

/** Build a long downtrend then sharp uptrend to force a bullish EMA cross. */
function crossoverCandles(): Candle[] {
  const start = 1_700_000_000;
  const interval = 15 * 60;
  const candles: Candle[] = [];
  let price = 200;
  // Decline long enough to warm indicators with fast below slow.
  for (let i = 0; i < 80; i++) {
    price -= 0.8;
    candles.push({
      time: start + i * interval,
      open: price + 0.4,
      high: price + 0.5,
      low: price - 0.5,
      close: price,
      volume: 10,
    });
  }
  // Sharp rally to cross fast above slow while RSI is not maxed out.
  for (let i = 0; i < 25; i++) {
    price += 4;
    const t = start + (80 + i) * interval;
    candles.push({
      time: t,
      open: price - 2,
      high: price + 1,
      low: price - 3,
      close: price,
      volume: 20,
    });
  }
  return candles;
}

describe("parseBacktestArgs", () => {
  it("parses --days and --force-refresh", () => {
    assert.deepEqual(parseBacktestArgs(["--days", "14", "--force-refresh"]), {
      days: 14,
      forceRefresh: true,
    });
    assert.deepEqual(parseBacktestArgs(["--days=7"]), {
      days: 7,
      forceRefresh: false,
    });
    assert.deepEqual(parseBacktestArgs([]), {
      days: 0,
      forceRefresh: false,
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

describe("runBacktest", () => {
  it("replays fixture candles with emulated costs and no paper-state writes", async () => {
    const candles = crossoverCandles();
    const startingCash = 1000;
    // Loose filters so the classic cross fixture still fires a BUY (cost-model smoke).
    const strategy = makeStrategy(
      {
        rsiBuyMin: 0,
        rsiBuyMax: 100,
        trendEmaPeriod: 5,
        adxMin: 0,
      },
      {
        cooldownBars: 0,
        minHoldBars: 0,
        atrStopMult: 100,
        atrTrailMult: 100,
      },
    );
    const [result] = await runBacktest({
      config: makeConfig(startingCash),
      strategy,
      risk: makeRisk(strategy),
      candles,
      days: 30,
    });

    assert.ok(result);
    assert.equal(result.metrics.pair, "SOL/USDC");
    assert.equal(result.metrics.candleCount, candles.length);
    assert.equal(result.candles.length, candles.length);
    assert.equal(result.metrics.strategy.getMode(), "ema-rsi");
    assert.ok(result.equityCurve.length === candles.length);

    // With a forced bullish cross we expect at least one simulated BUY.
    assert.ok(result.trades.length >= 1);
    const buy = result.trades[0];
    assert.ok(buy);
    assert.equal(buy.side, "BUY");
    assert.equal(buy.simulated, true);

    const buyBar = candles.find((c) => c.time === Math.floor(buy.at.getTime() / 1000));
    assert.ok(buyBar);
    const emulated = emulateFillPrice({ side: "BUY", close: buyBar.close, tier: "liquid" });
    assert.ok(Math.abs(buy.price - emulated.fillPrice) < 1e-9);

    // Priority fee + adverse price → size below cash/mid.
    const midSize = startingCash / buyBar.close;
    assert.ok(buy.size < midSize);

    assert.ok(result.metrics.costs.slippageUsdc > 0);
    assert.ok(result.metrics.costs.poolFeeUsdc > 0);
    assert.ok(result.metrics.costs.priorityFeeUsdc > 0);

    const adverse = TIER_COSTS.liquid.slippage + TIER_COSTS.liquid.poolFee;
    assert.ok(adverse > 0);
  });

  it("exits via ATR stop after entry when price crashes", async () => {
    const start = 1_700_000_000;
    const interval = 15 * 60;
    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < 40; i++) {
      price += 0.2;
      candles.push({
        time: start + i * interval,
        open: price - 0.1,
        high: price + 0.3,
        low: price - 0.3,
        close: price,
        volume: 5,
      });
    }
    for (let i = 0; i < 6; i++) {
      price -= 0.4;
      candles.push({
        time: start + (40 + i) * interval,
        open: price + 0.2,
        high: price + 0.3,
        low: price - 0.3,
        close: price,
        volume: 5,
      });
    }
    for (let i = 0; i < 8; i++) {
      price += 0.5;
      candles.push({
        time: start + (46 + i) * interval,
        open: price - 0.2,
        high: price + 0.3,
        low: price - 0.3,
        close: price,
        volume: 5,
      });
    }
    candles.push({
      time: start + 54 * interval,
      open: price,
      high: price,
      low: price - 20,
      close: price - 15,
      volume: 5,
    });

    const strategy = makeStrategy(
      {
        emaFast: 5,
        emaSlow: 12,
        trendEmaPeriod: 20,
        rsiPeriod: 14,
        rsiBuyMin: 20,
        rsiBuyMax: 90,
        atrPeriod: 5,
        adxPeriod: 5,
        adxMin: 0,
      },
      {
        atrStopMult: 1.5,
        atrTrailMult: 50,
        cooldownBars: 0,
        minHoldBars: 0,
      },
    );

    const [result] = await runBacktest({
      config: makeConfig(1000),
      strategy,
      risk: makeRisk(strategy),
      candles,
    });
    assert.ok(result);
    assert.ok(result.trades.some((t) => t.side === "BUY"));
    const stopSell = result.trades.find((t) => t.side === "SELL" && t.reason?.includes("ATR"));
    assert.ok(stopSell);
  });

  it("keeps flat equity when indicators never fire", async () => {
    const strategy = loadStrategy("ema-rsi");
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
      strategy,
      risk: makeRisk(strategy),
      candles,
    });

    assert.ok(result);
    assert.equal(result.trades.length, 0);
    assert.equal(result.metrics.endingEquity, 500);
    assert.equal(result.metrics.totalReturnPct, 0);
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
