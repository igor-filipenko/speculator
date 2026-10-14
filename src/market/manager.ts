import type { CandleSource, Market } from "../types.js";
import { BinanceMarket } from "./binance/market.js";
import { CachedMarket } from "./cached/market.js";
import { GeckoTerminalMarket } from "./gecko/market.js";

/** Build the cached market for a vendor this process can fetch. */
export function createMarket(source: CandleSource): Market {
  return new CachedMarket(createInner(source));
}

function createInner(source: CandleSource): Market {
  switch (source) {
    case "gecko-terminal":
      return new GeckoTerminalMarket();
    case "binance":
      return new BinanceMarket();
  }
}
