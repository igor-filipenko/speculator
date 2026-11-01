import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PairConfig } from "../../types.js";
import { BirdeyeMarket } from "./market.js";

const API_KEY = "test-birdeye-key";

const pair: PairConfig = {
  symbol: "SOL/USDC",
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  baseDecimals: 9,
  quoteDecimals: 6,
  poolAddress: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
};

function item(openSec: number, close: number, volume = 12.5): Record<string, unknown> {
  return {
    address: pair.poolAddress,
    unix_time: openSec,
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
    type: "5m",
    v: volume,
    v_usd: 9999,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("BirdeyeMarket", () => {
  it("maps unix seconds and base volume for the pool", async () => {
    const open = 1_700_000_000;
    let seenUrl: URL | undefined;
    let seenKey: string | null = null;
    const fetchImpl: typeof fetch = (input, init) => {
      seenUrl =
        input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
      seenKey = new Headers(init?.headers).get("X-API-KEY");
      return Promise.resolve(
        jsonResponse({
          success: true,
          data: { items: [item(open, 100)] },
        }),
      );
    };
    const market = new BirdeyeMarket(API_KEY, fetchImpl);
    const candles = await market.fetchCandles({
      pair,
      timeframe: "5m",
      fromTime: open,
      toTime: open + 300,
    });

    assert.equal(seenUrl?.searchParams.get("address"), pair.poolAddress);
    assert.equal(seenUrl?.searchParams.get("type"), "5m");
    assert.equal(seenUrl?.searchParams.get("mode"), "count");
    assert.equal(seenUrl?.searchParams.get("time_from"), String(open));
    assert.equal(seenUrl?.searchParams.get("count_limit"), "5000");
    assert.equal(seenKey, API_KEY);
    assert.equal(seenUrl?.href.includes(API_KEY), false);
    assert.equal(candles.length, 1);
    assert.equal(candles[0]?.time, open);
    assert.equal(candles[0]?.open, 100);
    assert.equal(candles[0]?.high, 101);
    assert.equal(candles[0]?.low, 99);
    assert.equal(candles[0]?.close, 100);
    assert.equal(candles[0]?.volume, 12.5);
    assert.equal(candles[0]?.source, "birdeye");
    assert.equal(candles[0]?.timeframe, "5m");
    assert.equal(candles[0]?.intervalSeconds, 300);
    assert.equal(candles[0]?.isClosed(open + 299), false);
    assert.equal(candles[0]?.isClosed(open + 300), true);
  });

  it("requests Birdeye hour and day interval names", async () => {
    const types: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url =
        input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
      types.push(url.searchParams.get("type") ?? "");
      return Promise.resolve(jsonResponse({ success: true, data: { items: [] } }));
    };
    const market = new BirdeyeMarket(API_KEY, fetchImpl);
    const open = 1_700_000_000;
    await market.fetchCandles({ pair, timeframe: "1h", fromTime: open, toTime: open + 3600 });
    await market.fetchCandles({ pair, timeframe: "4h", fromTime: open, toTime: open + 14_400 });
    await market.fetchCandles({ pair, timeframe: "1d", fromTime: open, toTime: open + 86_400 });
    assert.deepEqual(types, ["1H", "4H", "1D"]);
  });

  it("pages forward when the window is longer than 5000 bars", async () => {
    const start = 1_700_000_000;
    const interval = 300;
    const count = 5001;
    const requests: number[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url =
        input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
      const timeFrom = Number(url.searchParams.get("time_from"));
      requests.push(timeFrom);
      const remaining = count - Math.round((timeFrom - start) / interval);
      const n = Math.min(5000, Math.max(0, remaining));
      const items = Array.from({ length: n }, (_, i) => item(timeFrom + i * interval, 1, 3));
      return Promise.resolve(jsonResponse({ success: true, data: { items } }));
    };

    const market = new BirdeyeMarket(API_KEY, fetchImpl);
    const candles = await market.fetchCandles({
      pair,
      timeframe: "5m",
      fromTime: start,
      toTime: start + count * interval,
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[1], start + 5000 * interval);
    assert.equal(candles.length, 5001);
    assert.equal(candles[0]?.time, start);
    assert.equal(candles[5000]?.time, start + 5000 * interval);
    assert.equal(candles[5000]?.volume, 3);
    assert.equal(candles[5000]?.source, "birdeye");
  });

  it("names the pair on 401 and does not include the API key", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ success: false, message: `bad key ${API_KEY}` }, 401));
    };
    const market = new BirdeyeMarket(API_KEY, fetchImpl);
    await assert.rejects(
      () => market.fetchCandles({ pair, timeframe: "1h", fromTime: 1, toTime: 3_600 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /SOL\/USDC/);
        assert.match(err.message, /\(401\)/);
        assert.equal(err.message.includes(API_KEY), false);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
});
