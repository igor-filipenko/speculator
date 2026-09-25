import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSnapshot, parsePositionsArgs } from "./positions.js";

describe("parsePositionsArgs", () => {
  it("parses list, open, and close", () => {
    assert.deepEqual(parsePositionsArgs(["list"]), { kind: "list" });
    assert.deepEqual(parsePositionsArgs(["open", "long", "10"]), { kind: "open-long", usdc: 10 });
    assert.deepEqual(parsePositionsArgs(["close", "long"]), { kind: "close-long" });
    assert.deepEqual(parsePositionsArgs(["open", "short", "10"]), {
      kind: "open-short",
      usdc: 10,
    });
    assert.deepEqual(parsePositionsArgs(["close", "short"]), { kind: "close-short" });
  });

  it("rejects unknown commands and a non-positive amount", () => {
    assert.throws(() => parsePositionsArgs([]), /Usage/);
    assert.throws(() => parsePositionsArgs(["open", "long", "0"]), /positive USDC/);
    assert.throws(() => parsePositionsArgs(["open", "short"]), /Usage/);
  });
});

describe("formatSnapshot", () => {
  it("prints a flat book and an open long", () => {
    const flat = formatSnapshot(
      "SOL/USDC",
      {
        cashUsdc: 25,
        position: { pair: "SOL/USDC", side: "flat", size: 0, entryPrice: 0 },
        realizedPnl: 0,
        equity: 25,
        trades: [],
        simulated: false,
      },
      140,
    );
    assert.match(flat, /SOL\/USDC flat/);
    const long = formatSnapshot(
      "SOL/USDC",
      {
        cashUsdc: 10,
        position: { pair: "SOL/USDC", side: "long", size: 1.5, entryPrice: 150 },
        realizedPnl: 0,
        equity: 220,
        trades: [],
        simulated: false,
      },
      140,
    );
    assert.match(long, /long size 1.5 @ 150.00 mark 140.00/);
  });
});
