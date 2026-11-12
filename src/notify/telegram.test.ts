import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatErrorMessage } from "./telegram.js";

describe("formatErrorMessage", () => {
  it("includes the pair and the exchange error", () => {
    const text = formatErrorMessage("SOL/USDC", "jupiter spot cannot short");
    assert.match(text, /ERROR/);
    assert.match(text, /SOL\/USDC/);
    assert.match(text, /cannot short/);
  });
});
