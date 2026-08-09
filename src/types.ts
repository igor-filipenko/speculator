/** Shared domain types for signals and paper trading. */

export type SignalSide = "BUY" | "SELL" | "HOLD";

export type PositionSide = "flat" | "long";

export type StrategyMode = "intraday" | "swing";

export type Timeframe = "15m" | "4h";

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
  timeframe: Timeframe;
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

/** Intent to trade after risk checks (not yet filled). */
export interface Command {
  pair: string;
  side: "BUY" | "SELL";
  reason: string;
  at: Date;
  /** Mid/spot hint from the signal before exchange costs. */
  priceHint: number;
  /** Quote (USDC) budget to spend on BUY. */
  quoteBudgetUsdc?: number;
  /** Base size to sell on SELL. */
  baseSize?: number;
}

/** Simulated fill returned by an exchange. */
export interface Order {
  pair: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  at: Date;
  simulated: true;
  reason: string;
  /** Network priority fee in USDC (0 for live paper quotes). */
  priorityFeeUsdc: number;
  /** Present for emulated (backtest) fills. */
  fillCosts?: {
    mid: number;
    slippageUsdcPerBase: number;
    poolFeeUsdcPerBase: number;
  };
}

export interface Portfolio {
  getSnapshot(markPrice: number): Snapshot;
  applyOrder(order: Order): Promise<Trade | null>;
}

export interface RequiredCandles {
  timeframe: Timeframe;
  count: number;
}

export interface Strategy {
  getParams(): StrategyParams;
  getRequiredCandles(): RequiredCandles;
  evaluateSignal(pair: string, candles: Candle[], price: number, at: Date): Signal;
}

/** Turns a strategy signal into a trade command using portfolio state. */
export interface RiskManager {
  toCommand(signal: Signal, snapshot: Snapshot): Command | null;
}

/** Quote + simulated fill venue (live Jupiter or emulated backtest). */
export interface Exchange {
  spotPrice(pair: PairConfig): Promise<number>;
  execute(command: Command, pair: PairConfig): Promise<Order>;
}

export interface ProgramState {
  readonly mode: RunMode;
  readonly strategy: Strategy;
  readonly lastSignals: Map<string, Signal>;
  readonly lastCandles: Map<string, Candle[]>;
  readonly portfolios: Map<string, Portfolio>;
}

export type ShutdownCb = (reason: string, exitCode: number) => Promise<void>;
