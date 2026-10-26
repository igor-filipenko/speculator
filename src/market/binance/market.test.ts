import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PairConfig } from "../../types.js";
import { BinanceMarket } from "./market.js";

const pair: PairConfig = {
  symbol: "SOL/USDC",
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  baseDecimals: 9,
  quoteDecimals: 6,
  poolAddress: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
};

/** One Binance kline. Index 5 is base volume; index 7 is quote volume. */
function kline(openSec: number, close: number): unknown[] {
  return [
    openSec * 1000,
    String(close),
    String(close + 1),
    String(close - 1),
    String(close),
    "12.5",
    (openSec + 300) * 1000 - 1,
    "999",
    3,
    "1",
    "1",
    "0",
  ];
}

describe("BinanceMarket", () => {
  it("maps open time to seconds and uses base volume", async () => {
    const open = 1_700_000_000;
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify([kline(open, 100)]), { status: 200 }));
    const market = new BinanceMarket(fetchImpl);
    const candles = await market.fetchCandles({
      pair,
      timeframe: "5m",
      fromTime: open,
      toTime: open + 300,
    });

    assert.equal(candles.length, 1);
    assert.equal(candles[0]?.time, open);
    assert.equal(candles[0]?.open, 100);
    assert.equal(candles[0]?.volume, 12.5);
    assert.equal(candles[0]?.source, "binance");
    assert.equal(candles[0]?.timeframe, "5m");
    assert.equal(candles[0]?.intervalSeconds, 300);
    assert.equal(candles[0]?.isClosed(open + 299), false);
    assert.equal(candles[0]?.isClosed(open + 300), true);
  });

  it("pages forward when the window is longer than 1000 bars", async () => {
    const start = 1_700_000_000;
    const interval = 300;
    const count = 1001;
    const requests: number[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url =
        input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
      const startMs = Number(url.searchParams.get("startTime"));
      requests.push(startMs);
      const startSec = Math.floor(startMs / 1000);
      const remaining = count - Math.round((startSec - start) / interval);
      const n = Math.min(1000, Math.max(0, remaining));
      const rows = Array.from({ length: n }, (_, i) => kline(startSec + i * interval, 1));
      return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
    };

    const market = new BinanceMarket(fetchImpl);
    const candles = await market.fetchCandles({
      pair,
      timeframe: "5m",
      fromTime: start,
      toTime: start + count * interval,
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[1], (start + 1000 * interval) * 1000);
    assert.equal(candles.length, 1001);
    assert.equal(candles[0]?.time, start);
    assert.equal(candles[1000]?.time, start + 1000 * interval);
    assert.equal(candles[1000]?.source, "binance");
  });

  it("names the pair when Binance rejects the symbol", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 }),
      );
    const market = new BinanceMarket(fetchImpl);
    await assert.rejects(
      () => market.fetchCandles({ pair, timeframe: "1h", fromTime: 1, toTime: 3_600 }),
      /SOL\/USDC/,
    );
  });
});
