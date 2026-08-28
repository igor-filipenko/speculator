import { Resvg } from "@resvg/resvg-js";
import type { Candle, MarketIndicators, Strategy } from "../types.js";
import { buildMarketStateSvg } from "../strategy/market-state-svg.js";

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

/** Render HTF MarketIndicators chart (SVG → PNG) for Telegram `/market`. */
export function renderMarketPng(indicators: MarketIndicators): Buffer {
  const svg = buildMarketStateSvg({ state: indicators });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 900 },
  });
  return Buffer.from(resvg.render().asPng());
}
