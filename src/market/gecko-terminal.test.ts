import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candleIntervalSeconds } from "./gecko-terminal.js";

describe("candleIntervalSeconds", () => {
  it("maps 15m, 4h, and 1d", () => {
    assert.equal(candleIntervalSeconds("15m"), 15 * 60);
    assert.equal(candleIntervalSeconds("4h"), 4 * 60 * 60);
    assert.equal(candleIntervalSeconds("1d"), 24 * 60 * 60);
  });
});
