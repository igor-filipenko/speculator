import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../config.js";
import { SimpleStrategyManager } from "../strategy/strategy-manager.js";
import type { Candle } from "../types.js";
import { parseRegimeArgs, runRegime, segmentsFromChanges } from "./regime.js";

const SOL_USDC_POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
const START = 1_700_000_000;

function makeConfig(): AppConfig {
  return {
    strategy: "grid",
    htf: "4h",
    jupiterApiKey: "",
    watchlist: ["SOL/USDC"],
    pollIntervalMs: 60_000,
    paperCashUsdc: 1000,
    botId: "test",
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

function bar(time: number, close: number, range: number): Candle {
  return {
    time,
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume: 1,
  };
}

function htfSeries(count: number, startPrice: number, delta: number): Candle[] {
  const interval = 4 * 60 * 60;
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price += delta;
    candles.push(bar(START + i * interval, price, Math.abs(delta) + 0.2));
  }
  return candles;
}

/** Tight ranges so 1h vol classifies as low after warmup. */
function lowThenHighMtf(lowCount: number, highCount: number): Candle[] {
  const interval = 60 * 60;
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < lowCount; i++) {
    price += 1.5;
    candles.push(bar(START + i * interval, price, 0.4));
  }
  for (let i = 0; i < highCount; i++) {
    price += 12;
    candles.push(bar(START + (lowCount + i) * interval, price, 25));
  }
  return candles;
}

describe("parseRegimeArgs", () => {
  it("parses --days and --force-refresh", () => {
    assert.deepEqual(parseRegimeArgs(["--days", "14", "--force-refresh"]), {
      days: 14,
      forceRefresh: true,
    });
    assert.deepEqual(parseRegimeArgs([]), {
      days: 0,
      forceRefresh: false,
    });
  });

  it("parses --from/--to", () => {
    const flags = parseRegimeArgs(["--from", "01-01-2026", "--to", "01-08-2026"]);
    assert.equal(flags.fromTime, Date.UTC(2026, 0, 1) / 1000);
    assert.equal(flags.toTime, Date.UTC(2026, 7, 2) / 1000);
  });

  it("rejects unknown flags and --ignore-trend", () => {
    assert.throws(() => parseRegimeArgs(["--unknown"]), /Unknown regime/);
    assert.throws(() => parseRegimeArgs(["--strategy", "grid"]), /Unknown regime/);
    assert.throws(() => parseRegimeArgs(["--ignore-trend"]), /Unknown regime/);
    assert.throws(() => parseRegimeArgs(["--to", "2026-08-01"]), /requires --from/);
  });
});

describe("segmentsFromChanges", () => {
  it("closes the last segment at endTime", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const segments = segmentsFromChanges(
      [
        {
          at,
          price: 100,
          market: { pair: "SOL/USDC", price: 100, trend: "bullish", volatility: "low" },
          strategyName: "grid",
          riskName: "generic",
        },
      ],
      at.getTime() / 1000 + 3600,
    );
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.trend, "bullish");
    assert.equal(segments[0]!.toTime - segments[0]!.fromTime, 3600);
  });
});

describe("runRegime", () => {
  it("records trend and volatility switches on HTF/1h closes", async () => {
    const htf = htfSeries(250, 50, 0.8);
    const mtf = lowThenHighMtf(900, 20);
    const fromTime = START;
    const toTime = mtf[mtf.length - 1]!.time + 1;
    const [result] = await runRegime({
      config: makeConfig(),
      strategyManager: new SimpleStrategyManager({ strategyMode: "grid", htf: "4h" }),
      fromTime,
      toTime,
      htfCandles: htf,
      mtfCandles: mtf,
    });
    assert.ok(result);
    assert.equal(result.pair, "SOL/USDC");
    assert.ok(result.changes.length >= 2);
    assert.ok(result.changes.some((c) => c.market.trend === "bullish"));
    assert.ok(result.changes.some((c) => c.market.volatility === "high"));
    const keys = result.changes.map((c) => `${c.market.trend}/${c.market.volatility}`);
    for (let i = 1; i < keys.length; i++) {
      assert.notEqual(keys[i], keys[i - 1]);
    }
    assert.ok(result.samples.length >= result.changes.length);
    assert.ok(result.chartCandles.length > 0);
    assert.ok(result.changes.every((c) => c.strategyName.length > 0 && c.riskName.length > 0));
  });
});
