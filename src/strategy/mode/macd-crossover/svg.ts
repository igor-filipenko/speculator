import type { Candle, Timeframe } from "../../../types.js";
import { ema, macd } from "../../indicators.js";

/** Fields the MACD chart reads. Strategies pass their own params. */
export interface MacdCrossoverChartParams {
  timeframe: Timeframe;
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
  pricePeriod: number;
  trendPeriod: number;
}

export interface MacdCrossoverChartInput {
  pair: string;
  candles: Candle[];
  strategy: MacdCrossoverChartParams;
  width?: number;
  height?: number;
}

const PAD = { top: 36, right: 64, bottom: 28, left: 12 };
const GAP = 16;
const PRICE_RATIO = 0.68;

/** Price candles, price and trend EMAs, and the MACD histogram. */
export function buildMacdCrossoverSvg(input: MacdCrossoverChartInput): string {
  const width = input.width ?? 900;
  const height = input.height ?? 520;
  const { pair, candles, strategy } = input;
  if (candles.length === 0) {
    throw new Error("Cannot chart empty candle series");
  }

  const closes = candles.map((candle) => candle.close);
  const priceEma = ema(closes, strategy.pricePeriod);
  const trendEma = ema(closes, strategy.trendPeriod);
  const histogram = macd(
    closes,
    strategy.fastPeriod,
    strategy.slowPeriod,
    strategy.signalPeriod,
  ).histogram;

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom - GAP;
  const priceH = plotH * PRICE_RATIO;
  const histH = plotH - priceH;
  const priceTop = PAD.top;
  const histTop = PAD.top + priceH + GAP;

  let minP = Infinity;
  let maxP = -Infinity;
  for (const candle of candles) {
    minP = Math.min(minP, candle.low);
    maxP = Math.max(maxP, candle.high);
  }
  for (const series of [priceEma, trendEma]) {
    for (const value of series) {
      if (value != null) {
        minP = Math.min(minP, value);
        maxP = Math.max(maxP, value);
      }
    }
  }
  if (!Number.isFinite(minP) || !Number.isFinite(maxP) || minP === maxP) {
    minP = closes[0]! * 0.99;
    maxP = closes[0]! * 1.01;
  }
  const padP = (maxP - minP) * 0.05;
  minP -= padP;
  maxP += padP;

  let histExtreme = 0;
  for (const value of histogram) {
    if (value != null) histExtreme = Math.max(histExtreme, Math.abs(value));
  }
  if (!(histExtreme > 0)) histExtreme = 1;

  const n = candles.length;
  const step = plotW / Math.max(n, 1);
  const bodyW = Math.max(1, step * 0.6);
  const xAt = (index: number): number => PAD.left + step * (index + 0.5);
  const yPrice = (value: number): number => priceTop + ((maxP - value) / (maxP - minP)) * priceH;
  const yHist = (value: number): number =>
    histTop + ((histExtreme - value) / (2 * histExtreme)) * histH;

  const candleParts: string[] = [];
  const histParts: string[] = [];
  for (let index = 0; index < n; index++) {
    const candle = candles[index]!;
    const x = xAt(index);
    const up = candle.close >= candle.open;
    const color = up ? "#16a34a" : "#dc2626";
    const yTop = Math.min(yPrice(candle.open), yPrice(candle.close));
    const bodyH = Math.max(1, Math.abs(yPrice(candle.close) - yPrice(candle.open)));
    candleParts.push(
      `<line x1="${x}" y1="${yPrice(candle.high)}" x2="${x}" y2="${yPrice(candle.low)}" stroke="${color}" stroke-width="1"/>`,
      `<rect x="${x - bodyW / 2}" y="${yTop}" width="${bodyW}" height="${bodyH}" fill="${color}"/>`,
    );
    const bar = histogram[index];
    if (bar == null) continue;
    const yZero = yHist(0);
    const yBar = yHist(bar);
    const histColor = bar >= 0 ? "#34d399" : "#f472b6";
    histParts.push(
      `<rect x="${x - bodyW / 2}" y="${Math.min(yZero, yBar)}" width="${bodyW}" height="${Math.max(1, Math.abs(yBar - yZero))}" fill="${histColor}"/>`,
    );
  }

  const linePath = (series: (number | null)[]): string => {
    const parts: string[] = [];
    for (let index = 0; index < series.length; index++) {
      const value = series[index];
      if (value == null) continue;
      const cmd = parts.length === 0 ? "M" : "L";
      parts.push(`${cmd}${xAt(index).toFixed(2)},${yPrice(value).toFixed(2)}`);
    }
    return parts.join(" ");
  };

  const title = `${escapeXml(pair)} · ${strategy.timeframe} · MACD ${strategy.fastPeriod}/${strategy.slowPeriod}/${strategy.signalPeriod} · EMA${strategy.pricePeriod}/${strategy.trendPeriod}`;
  const pricePath = linePath(priceEma);
  const trendPath = linePath(trendEma);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#0f172a"/>
  <text x="${PAD.left}" y="22" fill="#e2e8f0" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14" font-weight="600">${title}</text>
  <text x="${width - PAD.right + 4}" y="${priceTop + 12}" fill="#94a3b8" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">${formatPrice(maxP)}</text>
  <text x="${width - PAD.right + 4}" y="${priceTop + priceH}" fill="#94a3b8" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">${formatPrice(minP)}</text>
  <rect x="${PAD.left}" y="${priceTop}" width="${plotW}" height="${priceH}" fill="none" stroke="#1e293b"/>
  ${candleParts.join("\n  ")}
  ${pricePath ? `<path d="${pricePath}" fill="none" stroke="#38bdf8" stroke-width="1.5"/>` : ""}
  ${trendPath ? `<path d="${trendPath}" fill="none" stroke="#fbbf24" stroke-width="1.5"/>` : ""}
  <text x="${PAD.left}" y="${priceTop + 14}" fill="#38bdf8" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">EMA${strategy.pricePeriod}</text>
  <text x="${PAD.left + 52}" y="${priceTop + 14}" fill="#fbbf24" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">EMA${strategy.trendPeriod}</text>
  <rect x="${PAD.left}" y="${histTop}" width="${plotW}" height="${histH}" fill="none" stroke="#1e293b"/>
  <line x1="${PAD.left}" y1="${yHist(0)}" x2="${PAD.left + plotW}" y2="${yHist(0)}" stroke="#334155" stroke-width="1"/>
  ${histParts.join("\n  ")}
  <text x="${PAD.left}" y="${histTop + 14}" fill="#e2e8f0" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">MACD histogram</text>
</svg>`;
}

function formatPrice(n: number): string {
  if (n >= 1000) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
