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

export interface StrategyParams {
  mode: StrategyMode;
  timeframe: "15m" | "4h";
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiBuyMax: number;
  rsiSellMin: number;
}

export interface Trade {
  pair: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  /** Realized P&L in quote currency (set on SELL). */
  realizedPnl?: number;
  at: Date;
  simulated: true;
}

export interface Snapshot {
  cashUsdc: number;
  position: Position;
  realizedPnl: number;
  /** Mark-to-market equity = cash + position * markPrice. */
  equity: number;
  trades: Trade[];
}

export interface Portfolio {
  //cashUsdc: number;
  //position: Position;
  //realizedPnl: number;
  //trades: Trade[];

  getSnapshot(markPrice: number): Snapshot;

  applySignal(signal: Signal): Promise<Trade | null>;
}

export interface ProgramState {
  mode: RunMode;
  strategy: StrategyParams;
  lastSignals: Map<string, Signal>;
  lastCandles: Map<string, Candle[]>;
  portfolios: Map<string, Portfolio>;
}

export type ShutdownCb = (reason: string, exitCode: number) => Promise<void>;
