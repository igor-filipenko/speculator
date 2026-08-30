import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MarketIndicators } from "../types.js";
import { formatMarketIndicatorsListMessage, formatMarketMessage } from "./telegram.js";

const sample: MarketIndicators = {
  pair: "SOL/USDC",
  timeframe: "4h",
  at: new Date("2026-01-01T00:00:00.000Z"),
  price: 123.456789,
  trend: "bullish",
  ema200: 120,
  ema50: 122,
  adx: 28.4,
  plusDi: 32.1,
  minusDi: 18.4,
  atr: 4.12,
  atrPct: 0.033,
  distEma200Pct: 0.0288,
  support: 118.5,
  resistance: 130.4,
  levels: [
    { price: 118.5, kind: "support", touches: 3, lastTime: 1_700_000_000, volume: 10 },
    { price: 115.2, kind: "support", touches: 2, lastTime: 1_699_000_000, volume: 8 },
    { price: 130.4, kind: "resistance", touches: 2, lastTime: 1_700_100_000, volume: 9 },
  ],
  marketCapUsd: 12_300_000_000,
  fdvUsd: 14_100_000_000,
  candles: [],
};

describe("formatMarketIndicatorsListMessage", () => {
  it("asks to wait when empty", () => {
    const text = formatMarketIndicatorsListMessage(new Map());
    assert.match(text, /No market indicators yet/);
  });

  it("includes trend and HTF indicators", () => {
    const text = formatMarketIndicatorsListMessage(new Map([[sample.pair, sample]]));
    assert.match(text, /SOL\/USDC/);
    assert.match(text, /4h/);
    assert.match(text, /bullish/);
    assert.match(text, /EMA200/);
    assert.match(text, /ADX/);
    assert.match(text, /ATR/);
    assert.match(text, /Support/);
    assert.match(text, /118\.50/);
    assert.match(text, /Resistance/);
    assert.match(text, /130\.40/);
    assert.match(text, /MCap/);
    assert.doesNotMatch(text, /bollinger/);
    assert.doesNotMatch(text, /env/);
    assert.doesNotMatch(text, /Risk /);
  });
});

describe("formatMarketMessage", () => {
  it("includes previous → next trend", () => {
    const text = formatMarketMessage(sample, "flat");
    assert.match(text, /MARKET/);
    assert.match(text, /flat/);
    assert.match(text, /bullish/);
  });
});
