import { Resvg } from "@resvg/resvg-js";
import type { Candle, Strategy } from "../types.js";

export interface RenderOhlcvPngInput {
  pair: string;
  candles: Candle[];
  strategy: Strategy;
}

/** Render strategy OHLCV chart (SVG → PNG) for Telegram photos. */
export function renderOhlcvPng(input: RenderOhlcvPngInput): Buffer {
  const svg = input.strategy.buildChartSvg(input.pair, input.candles);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 900 },
  });
  return Buffer.from(resvg.render().asPng());
}
