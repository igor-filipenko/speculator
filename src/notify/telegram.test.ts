import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MarketState } from "../types.js";
import { formatMarketStatesMessage } from "./telegram.js";

const sample: MarketState = {
  pair: "SOL/USDC",
  timeframe: "4h",
  at: new Date("2026-01-01T00:00:00.000Z"),
  price: 123.456789,
  trend: "bullish",
  ema200: 120,
  ema50: 122,
  adx: 28.4,
  atr: 4.12,
  atrPct: 0.033,
  distEma200Pct: 0.0288,
  marketCapUsd: 12_300_000_000,
  fdvUsd: 14_100_000_000,
  strategyMode: "ema-rsi",
  candles: [],
};

describe("formatMarketStatesMessage", () => {
  it("asks to wait when empty", () => {
    const text = formatMarketStatesMessage(new Map());
    assert.match(text, /No market state yet/);
  });

  it("includes trend, HTF indicators, and env strategy/risk defaults", () => {
    const text = formatMarketStatesMessage(new Map([[sample.pair, sample]]));
    assert.match(text, /SOL\/USDC/);
    assert.match(text, /4h/);
    assert.match(text, /bullish/);
    assert.match(text, /EMA200/);
    assert.match(text, /ADX/);
    assert.match(text, /ATR/);
    assert.match(text, /MCap/);
    assert.match(text, /ema-rsi/);
    assert.match(text, /env/);
    assert.match(text, /default/);
  });
});
