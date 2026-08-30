import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candleIntervalSeconds, parsePoolStats } from "./gecko-terminal.js";

describe("candleIntervalSeconds", () => {
  it("maps 15m, 4h, and 1d", () => {
    assert.equal(candleIntervalSeconds("15m"), 15 * 60);
    assert.equal(candleIntervalSeconds("4h"), 4 * 60 * 60);
    assert.equal(candleIntervalSeconds("1d"), 24 * 60 * 60);
  });
});

describe("parsePoolStats", () => {
  it("parses market cap and FDV strings", () => {
    const stats = parsePoolStats({
      data: {
        attributes: {
          market_cap_usd: "1234567.8",
          fdv_usd: "2000000",
        },
      },
    });
    assert.equal(stats.marketCapUsd, 1_234_567.8);
    assert.equal(stats.fdvUsd, 2_000_000);
  });

  it("omits null, empty, and non-positive values", () => {
    const stats = parsePoolStats({
      data: {
        attributes: {
          market_cap_usd: null,
          fdv_usd: "0",
        },
      },
    });
    assert.equal(stats.marketCapUsd, undefined);
    assert.equal(stats.fdvUsd, undefined);
  });
});
