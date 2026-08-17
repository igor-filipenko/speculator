import type { Candle } from "../types.js";
import type { GridParams } from "./grid.js";
import { atr, ema } from "./indicators.js";

export interface GridChartInput {
  pair: string;
  candles: Candle[];
  strategy: GridParams;
  width?: number;
  height?: number;
}

const PAD = { top: 36, right: 56, bottom: 28, left: 12 };

/**
 * Build an SVG string: price candles + ATR-based grid levels + trend EMA overlay.
 */
export function buildGridSvg(input: GridChartInput): string {
  const width = input.width ?? 900;
  const height = input.height ?? 520;
  const { pair, candles, strategy } = input;

  if (candles.length === 0) {
    throw new Error("Cannot chart empty candle series");
  }

  const closes = candles.map((c) => c.close);
  const trendEmaSeries = ema(closes, strategy.trendEmaPeriod);
  const atrSeries = atr(candles, strategy.atrPeriod);

  const lastAtr = atrSeries[atrSeries.length - 1];
  const gridSpacing = lastAtr != null ? lastAtr * strategy.gridMult : 0;

  const anchorSlice = closes.slice(-strategy.reanchorBars);
  const referencePrice = anchorSlice.reduce((s, v) => s + v, 0) / anchorSlice.length;

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const priceTop = PAD.top;

  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of candles) {
    minP = Math.min(minP, c.low);
    maxP = Math.max(maxP, c.high);
  }
  for (const v of trendEmaSeries) {
    if (v != null) {
      minP = Math.min(minP, v);
      maxP = Math.max(maxP, v);
    }
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
  const yPrice = (p: number): number => priceTop + ((maxP - p) / (maxP - minP)) * plotH;

  const candleParts: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    const x = xAt(i);
    const up = c.close >= c.open;
    const color = up ? "#16a34a" : "#dc2626";
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

  const gridLines: string[] = [];
  if (gridSpacing > 0) {
    const levels = computeVisibleGridLevels(referencePrice, gridSpacing, minP, maxP);
    for (const level of levels) {
      const y = yPrice(level);
      gridLines.push(
        `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + plotW}" y2="${y}" stroke="#6366f1" stroke-width="0.75" stroke-dasharray="6 4" opacity="0.6"/>`,
        `<text x="${width - PAD.right + 4}" y="${y + 4}" fill="#6366f1" font-family="ui-sans-serif,system-ui,sans-serif" font-size="9">${formatPrice(level)}</text>`,
      );
    }
  }

  const linePath = (series: (number | null)[]): string => {
    const parts: string[] = [];
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (v == null) continue;
      const cmd = parts.length === 0 ? "M" : "L";
      parts.push(`${cmd}${xAt(i).toFixed(2)},${yPrice(v).toFixed(2)}`);
    }
    return parts.join(" ");
  };

  const trendEmaPath = linePath(trendEmaSeries);
  const title = `${escapeXml(pair)} · ${strategy.timeframe} · Grid(ATR${strategy.atrPeriod}×${strategy.gridMult})`;
  const priceLabelHi = formatPrice(maxP);
  const priceLabelLo = formatPrice(minP);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#0f172a"/>
  <text x="${PAD.left}" y="22" fill="#e2e8f0" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14" font-weight="600">${title}</text>
  <text x="${width - PAD.right + 4}" y="${priceTop + 12}" fill="#94a3b8" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">${priceLabelHi}</text>
  <text x="${width - PAD.right + 4}" y="${priceTop + plotH}" fill="#94a3b8" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">${priceLabelLo}</text>
  <rect x="${PAD.left}" y="${priceTop}" width="${plotW}" height="${plotH}" fill="none" stroke="#1e293b"/>
  ${gridLines.join("\n  ")}
  ${candleParts.join("\n  ")}
  ${trendEmaPath ? `<path d="${trendEmaPath}" fill="none" stroke="#fbbf24" stroke-width="1.5"/>` : ""}
  <text x="${PAD.left}" y="${priceTop + 14}" fill="#fbbf24" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">EMA${strategy.trendEmaPeriod}</text>
  <text x="${PAD.left + 64}" y="${priceTop + 14}" fill="#6366f1" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">grid ×${strategy.gridMult}</text>
</svg>`;
}

function computeVisibleGridLevels(
  reference: number,
  spacing: number,
  minVisible: number,
  maxVisible: number,
): number[] {
  const levels: number[] = [];
  const minLevel = Math.ceil((minVisible - reference) / spacing);
  const maxLevel = Math.floor((maxVisible - reference) / spacing);
  for (let k = minLevel; k <= maxLevel; k++) {
    levels.push(reference + k * spacing);
  }
  return levels;
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
