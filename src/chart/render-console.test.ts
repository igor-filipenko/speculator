import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle, Trade } from "../types.js";
import {
  bucketCandlesForWidth,
  buildTimeAxisRow,
  buildTradeMarkerRow,
  formatAxisTime,
  inferCandleLeftPad,
  tradeColumnIndexes,
  visibleCandleColumns,
} from "./render-console.js";

function candle(time: number, close: number): Candle {
  return {
    time,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
  };
}

function trade(side: "BUY" | "SELL", timeSec: number): Trade {
  return {
    pair: "SOL/USDC",
    side,
    price: 100,
    size: 1,
    at: new Date(timeSec * 1000),
    simulated: true,
  };
}

describe("bucketCandlesForWidth", () => {
  it("keeps 1:1 mapping when under width", () => {
    const candles = [candle(100, 1), candle(200, 2), candle(300, 3)];
    const buckets = bucketCandlesForWidth(candles, 10);
    assert.equal(buckets.length, 3);
    assert.deepEqual(
      buckets.map((b) => [b.sourceFrom, b.sourceTo]),
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );
  });

  it("aggregates OHLC across buckets", () => {
    const candles = [
      candle(100, 10),
      { time: 200, open: 10, high: 15, low: 9, close: 12, volume: 5 },
      candle(300, 11),
      candle(400, 8),
    ];
    const buckets = bucketCandlesForWidth(candles, 2);
    assert.equal(buckets.length, 2);
    assert.equal(buckets[0]!.open, candles[0]!.open);
    assert.equal(buckets[0]!.high, 15);
    assert.equal(buckets[0]!.low, 9);
    assert.equal(buckets[0]!.close, candles[1]!.close);
    assert.equal(buckets[0]!.sourceFrom, 0);
    assert.equal(buckets[0]!.sourceTo, 2);
  });
});

describe("tradeColumnIndexes", () => {
  it("maps BUY/SELL times onto bucket columns", () => {
    const candles = [candle(1000, 1), candle(2000, 2), candle(3000, 3), candle(4000, 4)];
    const buckets = bucketCandlesForWidth(candles, 2);
    const markers = tradeColumnIndexes(buckets, [trade("BUY", 1000), trade("SELL", 4000)], candles);
    assert.deepEqual(markers, [
      { side: "BUY", column: 0 },
      { side: "SELL", column: 1 },
    ]);
  });
});

describe("buildTradeMarkerRow", () => {
  it("places B and S with left pad", () => {
    const row = buildTradeMarkerRow(
      5,
      [
        { side: "BUY", column: 1 },
        { side: "SELL", column: 3 },
      ],
      3,
      false,
    );
    assert.equal(row, "    B S ");
  });

  it("marks both sides in one column as *", () => {
    const row = buildTradeMarkerRow(
      3,
      [
        { side: "BUY", column: 1 },
        { side: "SELL", column: 1 },
      ],
      0,
      false,
    );
    assert.equal(row, " * ");
  });
});

describe("inferCandleLeftPad", () => {
  it("uses tick + MARGIN_RIGHT and does not skip candle voids", () => {
    // Candle voids are spaces; walking past ┤ would overshoot. Pad = index(┤)+1+2.
    const pad = inferCandleLeftPad("\n101,00 ┤          \n");
    assert.equal(pad, "101,00 ┤".length + 2);
  });

  it("matches a line that starts with a filled candle", () => {
    const pad = inferCandleLeftPad("\n 98,50 ┤  │││\n");
    assert.equal(pad, " 98,50 ┤".length + 2);
  });
});

describe("buildTimeAxisRow", () => {
  it("emits a rule and start/end labels under columns", () => {
    const start = Date.UTC(2026, 0, 1) / 1000;
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      candles.push(candle(start + i * 86400, 1 + i));
    }
    const buckets = bucketCandlesForWidth(candles, 40);
    const axis = buildTimeAxisRow(buckets, 4);
    const lines = axis.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^ {4}─{40}$/);
    assert.match(lines[1]!, /01-01-2026/);
    assert.match(lines[1]!, /09-02-2026/);
  });
});

describe("formatAxisTime", () => {
  it("uses clock time for short spans", () => {
    assert.equal(formatAxisTime(Date.UTC(2026, 0, 2, 14, 30) / 1000, 3600), "02-01 14:30");
  });
});

describe("visibleCandleColumns", () => {
  it("returns a positive column budget", () => {
    assert.ok(visibleCandleColumns(120) > 50);
  });
});
