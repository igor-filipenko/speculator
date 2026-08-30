/** Shared domain types for signals, paper, backtest, and live trading. */

export type SignalSide = "BUY" | "SELL" | "HOLD";

export type PositionSide = "flat" | "long";

export type StrategyMode = "bollinger" | "grid";

export type Timeframe = "15m" | "4h" | "1d";

/** Higher-timeframe bars used by {@link StrategyManager} (not the signal strategy). */
export type HtfTimeframe = "4h" | "1d";

export type Trend = "bullish" | "bearish" | "flat" | "unknown";

/** Clustered HTF swing high/low used as support or resistance. */
export interface PriceLevel {
  price: number;
  kind: "support" | "resistance";
  /** Confirmed swing pivots in this cluster. */
  touches: number;
  /** Sum of volume in each pivot's confirmation window. */
  volume: number;
  /** Last pivot time (Unix seconds). */
  lastTime: number;
}

/** HTF regime + Gecko pool stats. Does not pick trades (yet). */
export interface MarketIndicators {
  pair: string;
  timeframe: HtfTimeframe;
  at: Date;
  price: number;
  trend: Trend;
  ema200?: number;
  ema50?: number;
  adx?: number;
  /** Wilder +DI at the last HTF bar. */
  plusDi?: number;
  /** Wilder −DI at the last HTF bar. */
  minusDi?: number;
  atr?: number;
  /** ATR / price. */
  atrPct?: number;
  /** (price − EMA200) / EMA200. */
  distEma200Pct?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  /** Nearest support below price. */
  support?: number;
  /** Nearest resistance above price. */
  resistance?: number;
  /** Key clustered S/R (nearest-first within each side). */
  levels?: PriceLevel[];
  /** HTF OHLCV used to compute this snapshot. */
  candles: Candle[];
}

/** Optional Gecko pool overview passed into {@link StrategyManager.evaluate}. */
export interface PoolStats {
  marketCapUsd?: number;
  fdvUsd?: number;
}

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
    trendEma?: number;
    rsi?: number;
    atr?: number;
    adx?: number;
    bbMid?: number;
    bbUpper?: number;
    bbLower?: number;
    /** Last bar low (for ATR stop checks in risk). */
    barLow?: number;
    /** Last bar high (for trailing peak updates in risk). */
    barHigh?: number;
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

/** Position / exit policy used by {@link RiskManager} (independent of signal indicators). */
export interface RiskParams {
  /** Bar size for cooldown / min-hold (usually matches strategy timeframe). */
  timeframe: Timeframe;
  /** Hard stop distance: entry − atrStopMult × ATR. */
  atrStopMult: number;
  /** Trailing stop from peak: peak − atrTrailMult × ATR. */
  atrTrailMult: number;
  /** Bars to wait after a SELL before allowing a new BUY. */
  cooldownBars: number;
  /** Bars to hold before allowing a discretionary (cross) SELL; stops still fire. */
  minHoldBars: number;
}

export interface Trade {
  pair: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  /** Realized P&L in quote currency (set on SELL). */
  realizedPnl?: number;
  at: Date;
  simulated: boolean;
  /** On-chain transaction signature (live fills only). */
  txSignature?: string;
  /** Strategy / risk reason (e.g. EMA cross or ATR stop). */
  reason?: string;
}

export interface Snapshot {
  cashUsdc: number;
  position: Position;
  realizedPnl: number;
  /** Mark-to-market equity = cash + position * markPrice. */
  equity: number;
  trades: Trade[];
  simulated: boolean;
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

/** Fill returned by an exchange (simulated paper/backtest or live on-chain). */
export interface Order {
  pair: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  at: Date;
  simulated: boolean;
  /** On-chain transaction signature (live fills only). */
  txSignature?: string;
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
  /** Refresh on-chain balances before sizing. Paper is a no-op. */
  syncFromChain(markPrice: number): Promise<void>;
}

export interface RequiredCandles {
  timeframe: Timeframe;
  count: number;
}

export interface Strategy {
  getDisplayName(): string;
  getMode(): StrategyMode;
  getRiskParams(): RiskParams;
  getRequiredCandles(): RequiredCandles;
  evaluateSignal(
    pair: string,
    candles: Candle[],
    price: number,
    at: Date,
    snapshot?: Snapshot,
  ): Signal;
  /** Strategy-owned OHLCV chart overlays. */
  buildChartSvg(pair: string, candles: Candle[]): string;
}

export interface Risk {
  signal: Signal;
  reason: string;
}

export interface ClearRisk {
  kind: "risk";
  risk: Risk;
}

export interface RequiredCommand {
  kind: "command";
  command: Command;
}

export interface NoCommand {
  kind: "no-command";
}

/** Tagged result of {@link RiskManager.check}: fill, blocked signal, or HOLD / no-op. */
export type RiskOrCommand = ClearRisk | RequiredCommand | NoCommand;

/** Turns a strategy signal into a trade command using portfolio state. */
export interface RiskManager {
  getDisplayName(): string;
  check(signal: Signal, snapshot: Snapshot, candles: Candle[]): RiskOrCommand;
}

/**
 * HTF market indicators plus the active strategy / risk (trend picks the risk manager).
 * Does not fetch candles — callers use {@link getRequiredCandles} then {@link evaluate}.
 */
export interface StrategyManager {
  getActiveStrategy(): Strategy;
  getActiveRiskManager(): RiskManager;
  getRequiredCandles(): RequiredCandles;
  evaluate(
    pair: string,
    candles: Candle[],
    price: number,
    at: Date,
    poolStats?: PoolStats,
  ): MarketIndicators;
  /** Sync risk manager to {@link MarketIndicators.trend}. Returns true when the trend changed. */
  applyMarketIndicators(
    indicators: MarketIndicators,
    lastMarketIndicators?: MarketIndicators,
  ): boolean;
}

/** Quote + fill venue (Jupiter paper, live swap, or emulated backtest). */
export interface Exchange {
  spotPrice(pair: PairConfig): Promise<number>;
  execute(command: Command, pair: PairConfig): Promise<Order | null>;
}

export interface ProgramState {
  readonly strategy: Strategy;
  readonly lastSignals: Map<string, Signal>;
  readonly lastCandles: Map<string, Candle[]>;
  readonly lastMarketIndicators: Map<string, MarketIndicators>;
  readonly portfolios: Map<string, Portfolio>;
}

export type ShutdownCb = (reason: string, exitCode: number) => Promise<void>;
