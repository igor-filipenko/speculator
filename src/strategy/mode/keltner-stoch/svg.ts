import type { Candle, Timeframe } from "../../../types.js";
import { keltner, stochastic } from "../../indicators.js";

/** Fields the channel chart reads. Strategies pass their own params. */
export interface KeltnerStochChartParams {
  timeframe: Timeframe;
  period: number;
  atrMult: number;
  kPeriod: number;
  kSmooth: number;
  dPeriod: number;
  stochThreshold: number;
}

export interface KeltnerStochChartInput {
  pair: string;
  candles: Candle[];
  strategy: KeltnerStochChartParams;
  width?: number;
  height?: number;
}

const PAD = { top: 36, right: 56, bottom: 28, left: 12 };
const GAP = 16;
const PRICE_RATIO = 0.68;

/**
 * Build an SVG string: price candles + Keltner mid/upper/lower + slow stochastic.
 */
export function buildKeltnerStochSvg(input: KeltnerStochChartInput): string {
  const width = input.width ?? 900;
  const height = input.height ?? 520;
  const { pair, candles, strategy } = input;

  if (candles.length === 0) {
    throw new Error("Cannot chart empty candle series");
  }

  const bands = keltner(candles, strategy.period, strategy.atrMult);
  const stoch = stochastic(candles, strategy.kPeriod, strategy.kSmooth, strategy.dPeriod);

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom - GAP;
  const priceH = plotH * PRICE_RATIO;
  const oscH = plotH - priceH;
  const priceTop = PAD.top;
  const oscTop = PAD.top + priceH + GAP;

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
  if (!Number.isFinite(minP) || !Number.isFinite(maxP) || minP === maxP) {
    minP = candles[0]!.close * 0.99;
    maxP = candles[0]!.close * 1.01;
  }
  const padP = (maxP - minP) * 0.05;
  minP -= padP;
  maxP += padP;

  const n = candles.length;
  const step = plotW / Math.max(n, 1);
  const bodyW = Math.max(1, step * 0.6);

  const xAt = (i: number): number => PAD.left + step * (i + 0.5);
  const yPrice = (p: number): number => priceTop + ((maxP - p) / (maxP - minP)) * priceH;
  const yOsc = (v: number): number => oscTop + ((100 - v) / 100) * oscH;

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
  const kPath = linePath(stoch.k, yOsc);
  const dPath = linePath(stoch.d, yOsc);
  const oversold = yOsc(strategy.stochThreshold).toFixed(2);
  const overbought = yOsc(100 - strategy.stochThreshold).toFixed(2);
  const gate = (y: string): string =>
    `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + plotW}" y2="${y}" stroke="#334155" stroke-width="1" stroke-dasharray="3 3"/>`;

  const title =
    `${escapeXml(pair)} · ${strategy.timeframe} · KC(${strategy.period}, ${strategy.atrMult}) · ` +
    `Stoch(${strategy.kPeriod}, ${strategy.kSmooth}, ${strategy.dPeriod})`;
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
  <text x="${PAD.left}" y="${priceTop + 14}" fill="#fbbf24" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">KC mid</text>
  <text x="${PAD.left + 64}" y="${priceTop + 14}" fill="#38bdf8" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">±${strategy.atrMult} ATR</text>
  <rect x="${PAD.left}" y="${oscTop}" width="${plotW}" height="${oscH}" fill="none" stroke="#1e293b"/>
  ${gate(overbought)}
  ${gate(oversold)}
  ${kPath ? `<path d="${kPath}" fill="none" stroke="#34d399" stroke-width="1.5"/>` : ""}
  ${dPath ? `<path d="${dPath}" fill="none" stroke="#f472b6" stroke-width="1.5"/>` : ""}
  <text x="${PAD.left}" y="${oscTop + 14}" fill="#34d399" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">%K</text>
  <text x="${PAD.left + 28}" y="${oscTop + 14}" fill="#f472b6" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">%D</text>
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
