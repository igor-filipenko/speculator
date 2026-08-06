import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../config.js";
import { DEFAULT_SOL_USDC_POOL, strategyParams } from "../config.js";
import { TIER_COSTS, emulateFillPrice } from "../jupiter/emulated-quote.js";
import { PaperPortfolio } from "../paper/portfolio.js";
import type { Candle } from "../types.js";
import { parseBacktestArgs, parseBacktestDate, runBacktest } from "./backtest.js";

function makeConfig(cash = 1000): AppConfig {
  return {
    mode: "signal",
    strategy: "intraday",
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
        geckoPoolAddress: DEFAULT_SOL_USDC_POOL,
      },
    ],
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
    const [result] = await runBacktest({
      config: makeConfig(startingCash),
      candles,
      days: 30,
    });

    assert.ok(result);
    assert.equal(result.metrics.pair, "SOL/USDC");
    assert.equal(result.metrics.candleCount, candles.length);
    assert.equal(result.metrics.strategy.mode, "intraday");
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

  it("keeps flat equity when indicators never fire", async () => {
    const strategy = strategyParams("intraday");
    const start = 1_700_000_000;
    const interval = 15 * 60;
    const n = strategy.emaSlow + strategy.rsiPeriod + 10;
    const candles: Candle[] = Array.from({ length: n }, (_, i) => ({
      time: start + i * interval,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
    }));

    const [result] = await runBacktest({
      config: makeConfig(500),
      candles,
    });

    assert.ok(result);
    assert.equal(result.trades.length, 0);
    assert.equal(result.metrics.endingEquity, 500);
    assert.equal(result.metrics.totalReturnPct, 0);
  });
});

describe("PaperPortfolio priority fee", () => {
  it("deducts priority fee on BUY and SELL without persisting", () => {
    const portfolio = new PaperPortfolio("SOL/USDC", 1000);
    const buy = portfolio.applySignalSync(
      {
        pair: "SOL/USDC",
        side: "BUY",
        reason: "test",
        price: 100,
        at: new Date("2026-01-01T00:00:00.000Z"),
      },
      { priorityFeeUsdc: 10 },
    );
    assert.ok(buy);
    assert.equal(buy.size, 9.9);

    const sell = portfolio.applySignalSync(
      {
        pair: "SOL/USDC",
        side: "SELL",
        reason: "test",
        price: 110,
        at: new Date("2026-01-01T01:00:00.000Z"),
      },
      { priorityFeeUsdc: 5 },
    );
    assert.ok(sell);
    assert.equal(sell.realizedPnl, 9.9 * 110 - 5 - 9.9 * 100);
  });
});
