import { Resvg } from "@resvg/resvg-js";
import type { Candle, StrategyParams } from "../types.js";
import { buildOhlcvSvg } from "./ohlcv-svg.js";

export interface RenderOhlcvPngInput {
  pair: string;
  candles: Candle[];
  strategy: StrategyParams;
}

/** Render OHLCV + EMA/RSI chart to a PNG buffer for Telegram photos. */
export function renderOhlcvPng(input: RenderOhlcvPngInput): Buffer {
  const svg = buildOhlcvSvg(input);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 900 },
  });
  return Buffer.from(resvg.render().asPng());
}
