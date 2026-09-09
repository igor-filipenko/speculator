import type { Candle } from "../../types.js";
import { donchian, sma } from "../indicators.js";
import type { DonchianParams } from "./donchian.js";

export interface DonchianChartInput {
  pair: string;
  candles: Candle[];
  strategy: DonchianParams;
  width?: number;
  height?: number;
}

const PAD = { top: 36, right: 56, bottom: 28, left: 12 };
const GAP = 16;
const PRICE_RATIO = 0.68;

/**
 * Build an SVG string: price candles + Donchian mid/upper/lower + volume SMA subplot.
 */
export function buildDonchianSvg(input: DonchianChartInput): string {
  const width = input.width ?? 900;
  const height = input.height ?? 520;
  const { pair, candles, strategy } = input;

  if (candles.length === 0) {
    throw new Error("Cannot chart empty candle series");
  }

  const bands = donchian(candles, strategy.entryPeriod);
  const volumes = candles.map((c) => c.volume);
  const volumeSma = sma(volumes, strategy.volumeSmaPeriod);

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom - GAP;
  const priceH = plotH * PRICE_RATIO;
  const volH = plotH - priceH;
  const priceTop = PAD.top;
  const volTop = PAD.top + priceH + GAP;

  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of candles) {
    minP = Math.min(minP, c.low);
    maxP = Math.max(maxP, c.high);
  }
  for (const series of [bands.mid, bands.upper, bands.lower]) {
    for (const v of series) {
      if (v != null) {
        minP = Math.min(minP, v);
        maxP = Math.max(maxP, v);
      }
    }
  }
  const closes = candles.map((c) => c.close);
  if (!Number.isFinite(minP) || !Number.isFinite(maxP) || minP === maxP) {
    minP = closes[0]! * 0.99;
    maxP = closes[0]! * 1.01;
  }
  const padP = (maxP - minP) * 0.05;
  minP -= padP;
  maxP += padP;

  let maxVol = 0;
  for (let i = 0; i < volumes.length; i++) {
    maxVol = Math.max(maxVol, volumes[i]!);
    const smaNow = volumeSma[i];
    if (smaNow != null) {
      maxVol = Math.max(maxVol, smaNow);
    }
  }
  if (!(maxVol > 0)) {
    maxVol = 1;
  }

  const n = candles.length;
  const step = plotW / Math.max(n, 1);
  const bodyW = Math.max(1, step * 0.6);

  const xAt = (i: number): number => PAD.left + step * (i + 0.5);
  const yPrice = (p: number): number => priceTop + ((maxP - p) / (maxP - minP)) * priceH;
  const yVol = (v: number): number => volTop + volH - (v / maxVol) * volH;

  const candleParts: string[] = [];
  const volumeParts: string[] = [];
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

    const volY = yVol(c.volume);
    const volBarH = Math.max(1, volTop + volH - volY);
    volumeParts.push(
      `<rect x="${x - bodyW / 2}" y="${volY}" width="${bodyW}" height="${volBarH}" fill="${color}" opacity="0.55"/>`,
    );
  }

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

  const midPath = linePath(bands.mid, yPrice);
  const upperPath = linePath(bands.upper, yPrice);
  const lowerPath = linePath(bands.lower, yPrice);
  const volSmaPath = linePath(volumeSma, yVol);

  const title = `${escapeXml(pair)} · ${strategy.timeframe} · DC(${strategy.entryPeriod}/${strategy.exitPeriod}) · volSMA${strategy.volumeSmaPeriod}×${strategy.volumeSmaMult.toFixed(1)}`;
  const priceLabelHi = formatPrice(maxP);
  const priceLabelLo = formatPrice(minP);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#0f172a"/>
  <text x="${PAD.left}" y="22" fill="#e2e8f0" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14" font-weight="600">${title}</text>
  <text x="${width - PAD.right + 4}" y="${priceTop + 12}" fill="#94a3b8" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">${priceLabelHi}</text>
  <text x="${width - PAD.right + 4}" y="${priceTop + priceH}" fill="#94a3b8" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">${priceLabelLo}</text>
  <rect x="${PAD.left}" y="${priceTop}" width="${plotW}" height="${priceH}" fill="none" stroke="#1e293b"/>
  ${candleParts.join("\n  ")}
  ${upperPath ? `<path d="${upperPath}" fill="none" stroke="#38bdf8" stroke-width="1.25" stroke-dasharray="4 3"/>` : ""}
  ${midPath ? `<path d="${midPath}" fill="none" stroke="#fbbf24" stroke-width="1.5"/>` : ""}
  ${lowerPath ? `<path d="${lowerPath}" fill="none" stroke="#38bdf8" stroke-width="1.25" stroke-dasharray="4 3"/>` : ""}
  <text x="${PAD.left}" y="${priceTop + 14}" fill="#fbbf24" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">Donchian mid</text>
  <text x="${PAD.left + 92}" y="${priceTop + 14}" fill="#38bdf8" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">DC${strategy.entryPeriod}</text>
  <rect x="${PAD.left}" y="${volTop}" width="${plotW}" height="${volH}" fill="none" stroke="#1e293b"/>
  ${volumeParts.join("\n  ")}
  ${volSmaPath ? `<path d="${volSmaPath}" fill="none" stroke="#a78bfa" stroke-width="1.5"/>` : ""}
  <text x="${PAD.left}" y="${volTop + 14}" fill="#a78bfa" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">volume SMA${strategy.volumeSmaPeriod}</text>
</svg>`;
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
