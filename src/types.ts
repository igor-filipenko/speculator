/** Shared domain types for signals and paper trading. */

export type SignalSide = "BUY" | "SELL" | "HOLD";

export type PositionSide = "flat" | "long";

export type StrategyMode = "intraday" | "swing";

export type RunMode = "signal" | "paper";

export interface Candle {
  /** Unix timestamp in seconds (candle open time). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  pair: string;
  side: SignalSide;
  reason: string;
  price: number;
  at: Date;
  meta?: {
    emaFast?: number;
    emaSlow?: number;
    rsi?: number;
  };
}

export interface Position {
  pair: string;
  side: PositionSide;
  /** Base asset size (e.g. SOL). Zero when flat. */
  size: number;
  /** Average entry price in quote (USDC). */
  entryPrice: number;
  openedAt?: Date;
}

export interface PairConfig {
  symbol: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** GeckoTerminal pool used for OHLCV. */
  geckoPoolAddress: string;
}
