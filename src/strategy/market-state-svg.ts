import type { MarketIndicators, PriceLevel } from "../types.js";
import { adx, ema } from "./indicators.js";
import { htfParamsFor, type HtfParams } from "./strategy-manager.js";

export interface MarketStateChartInput {
  state: MarketIndicators;
  params?: HtfParams;
  width?: number;
  height?: number;
}

const PAD = { top: 36, right: 56, bottom: 28, left: 12 };
const GAP = 16;
const PRICE_RATIO = 0.68;

const COLOR = {
  support: "limegreen",
  resistance: "tomato",
  up: "limegreen",
  down: "tomato",
  emaFast: "skyblue",
  emaSlow: "gold",
  adx: "mediumpurple",
  label: "silver",
  title: "whitesmoke",
  muted: "gray",
} as const;

/**
 * HTF MarketIndicators chart: candles + EMA50/200, S/R levels, ADX subplot.
 */
export function buildMarketStateSvg(input: MarketStateChartInput): string {
  const width = input.width ?? 900;
  const height = input.height ?? 520;
  const { state } = input;
  const candles = state.candles;
  const params = input.params ?? htfParamsFor(state.timeframe);

  if (candles.length === 0) {
    throw new Error("Cannot chart empty candle series");
  }

  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes, params.emaFast);
  const emaSlow = ema(closes, params.emaSlow);
  const adxSeries = adx(candles, params.adxPeriod);
  const levels = state.levels ?? [];

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom - GAP;
  const priceH = plotH * PRICE_RATIO;
  const adxH = plotH - priceH;
  const priceTop = PAD.top;
  const adxTop = PAD.top + priceH + GAP;

  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of candles) {
    minP = Math.min(minP, c.low);
    maxP = Math.max(maxP, c.high);
  }
  for (const v of emaFast) {
    if (v != null) {
      minP = Math.min(minP, v);
      maxP = Math.max(maxP, v);
    }
  }
  for (const v of emaSlow) {
    if (v != null) {
      minP = Math.min(minP, v);
      maxP = Math.max(maxP, v);
    }
  }
  for (const level of levels) {
    minP = Math.min(minP, level.price);
    maxP = Math.max(maxP, level.price);
  }
  if (!Number.isFinite(minP) || !Number.isFinite(maxP) || minP === maxP) {
    minP = closes[0]! * 0.99;
    maxP = closes[0]! * 1.01;
  }
  const padP = (maxP - minP) * 0.05;
  minP -= padP;
  maxP += padP;

  const n = candles.length;
  const step = plotW / Math.max(n, 1);
  const bodyW = Math.max(1, step * 0.6);

  const xAt = (i: number): number => PAD.left + step * (i + 0.5);
  const yPrice = (p: number): number => priceTop + ((maxP - p) / (maxP - minP)) * priceH;
  const yAdx = (v: number): number => adxTop + ((100 - v) / 100) * adxH;

  const candleParts: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    const x = xAt(i);
    const up = c.close >= c.open;
    const color = up ? COLOR.up : COLOR.down;
    const yHigh = yPrice(c.high);
    const yLow = yPrice(c.low);
    const yOpen = yPrice(c.open);
    const yClose = yPrice(c.close);
    const yTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    candleParts.push(
      `<line x1="${x}" y1="${yHigh}" x2="${x}" y2="${yLow}" stroke="${color}" stroke-width="1"/>`,
      `<rect x="${x - bodyW / 2}" y="${yTop}" width="${bodyW}" height="${bodyH}" fill="${color}"/>`,
    );
  }

  const levelParts = levels.map((level) => levelLine(level, yPrice, plotW, width, state));

  const linePath = (series: (number | null)[], yMap: (v: number) => number): string => {
    const parts: string[] = [];
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (v == null) continue;
      const cmd = parts.length === 0 ? "M" : "L";
      parts.push(`${cmd}${xAt(i).toFixed(2)},${yMap(v).toFixed(2)}`);
    }
    return parts.join(" ");
  };

  const emaFastPath = linePath(emaFast, yPrice);
  const emaSlowPath = linePath(emaSlow, yPrice);
  const adxPath = linePath(adxSeries, yAdx);

  const title = `${escapeXml(state.pair)} · ${escapeXml(state.timeframe)} · ${escapeXml(state.trend)} · EMA${params.emaFast}/${params.emaSlow}`;
  const priceLabelHi = formatPrice(maxP);
  const priceLabelLo = formatPrice(minP);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#0f172a"/>
  <text x="${PAD.left}" y="22" fill="${COLOR.title}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14" font-weight="600">${title}</text>
  <text x="${width - PAD.right + 4}" y="${priceTop + 12}" fill="${COLOR.label}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">${priceLabelHi}</text>
  <text x="${width - PAD.right + 4}" y="${priceTop + priceH}" fill="${COLOR.label}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">${priceLabelLo}</text>
  <rect x="${PAD.left}" y="${priceTop}" width="${plotW}" height="${priceH}" fill="none" stroke="#1e293b"/>
  ${candleParts.join("\n  ")}
  ${levelParts.join("\n  ")}
  ${emaFastPath ? `<path d="${emaFastPath}" fill="none" stroke="${COLOR.emaFast}" stroke-width="1.5"/>` : ""}
  ${emaSlowPath ? `<path d="${emaSlowPath}" fill="none" stroke="${COLOR.emaSlow}" stroke-width="1.5"/>` : ""}
  <text x="${PAD.left}" y="${priceTop + 14}" fill="${COLOR.emaFast}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">EMA${params.emaFast}</text>
  <text x="${PAD.left + 64}" y="${priceTop + 14}" fill="${COLOR.emaSlow}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">EMA${params.emaSlow}</text>
  <rect x="${PAD.left}" y="${adxTop}" width="${plotW}" height="${adxH}" fill="none" stroke="#1e293b"/>
  <line x1="${PAD.left}" y1="${yAdx(params.adxFlatMax)}" x2="${PAD.left + plotW}" y2="${yAdx(params.adxFlatMax)}" stroke="${COLOR.muted}" stroke-dasharray="4 3"/>
  ${adxPath ? `<path d="${adxPath}" fill="none" stroke="${COLOR.adx}" stroke-width="1.5"/>` : ""}
  <text x="${PAD.left}" y="${adxTop + 14}" fill="${COLOR.adx}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">ADX${params.adxPeriod}</text>
  <text x="${width - PAD.right + 4}" y="${yAdx(params.adxFlatMax) + 4}" fill="${COLOR.label}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10">${params.adxFlatMax}</text>
</svg>`;
}

function levelLine(
  level: PriceLevel,
  yPrice: (p: number) => number,
  plotW: number,
  width: number,
  state: MarketIndicators,
): string {
  const y = yPrice(level.price);
  const color = level.kind === "support" ? COLOR.support : COLOR.resistance;
  const nearest = level.kind === "support" ? state.support : state.resistance;
  const thick = nearest != null && nearest === level.price;
  const strokeWidth = thick ? 1.5 : 0.75;
  return [
    `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + plotW}" y2="${y}" stroke="${color}" stroke-width="${strokeWidth}" stroke-dasharray="6 4" opacity="0.85"/>`,
    `<text x="${width - PAD.right + 4}" y="${y + 4}" fill="${color}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="9">${formatPrice(level.price)}</text>`,
  ].join("\n  ");
}

function formatPrice(n: number): string {
  if (n >= 1000) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
