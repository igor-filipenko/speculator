/** Shared domain types for signals, paper, backtest, and live trading. */

export type SignalSide = "BUY" | "SELL" | "HOLD";

export type PositionSide = "flat" | "long" | "short";

/** What a command does to the single position. */
export type OrderIntent = "open-long" | "close-long" | "open-short" | "close-short" | "buy-sol";

export type OrderType = "market" | "limit";

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";

/** Higher-timeframe bars used by {@link StrategyManager} (not the signal strategy). */
export type HtfTimeframe = "4h" | "1d";

/** 1h bars used for {@link MarketIndicators} volatility (not the HTF trend). */
export type MtfTimeframe = "1h";

export type Trend = "bullish" | "bearish" | "flat" | "unknown";

export type Volatility = "high" | "low" | "squeeze" | "unknown";

/** Clustered swing high/low used as support or resistance. */
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

/** HTF trend / S/R diagnostics (chart candles live here). */
export interface HtfSnapshot {
  timeframe: HtfTimeframe;
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
  /** Nearest support below price. */
  support?: number;
  /** Nearest resistance above price. */
  resistance?: number;
  /** Key clustered S/R (nearest-first within each side). */
  levels?: PriceLevel[];
  /** HTF OHLCV used to compute this snapshot. */
  candles: Candle[];
}

/** 1h volatility diagnostics (no candle dump). */
export interface MtfSnapshot {
  timeframe: MtfTimeframe;
  atr?: number;
  /** ATR / price on 1h. */
  atrPct?: number;
  bbMid?: number;
  bbUpper?: number;
  bbLower?: number;
  kcMid?: number;
  kcUpper?: number;
  kcLower?: number;
  /** Nearest support below price. */
  support?: number;
  /** Nearest resistance above price. */
  resistance?: number;
  /** Key clustered S/R (nearest-first within each side). */
  levels?: PriceLevel[];
}

/** HTF trend + S/R snapshot; 1h volatility is in {@link MarketIndicators.volatility}. */
export interface MarketIndicators {
  pair: string;
  price: number;
  trend: Trend;
  volatility: Volatility;
  htf?: HtfSnapshot;
  /** 1h volatility diagnostics. */
  mtf?: MtfSnapshot;
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
  /** `strategy.registry.id` of the strategy that produced this signal. */
  strategyId: string;
  /** Hard stop for an opening signal, set by the strategy. */
  slPrice?: number;
  /**
   * Take-profit prices, nearest first.
   * Bollinger sets the middle band. Donchian sets none (empty).
   * The risk manager uses the furthest price for the reward:risk gate.
   */
  tpPrices: number[];
  /**
   * Minimum reward per unit of stop risk for an opening signal.
   * Bollinger is 0.2. Unused when `tpPrices` is empty (Donchian sets 0).
   */
  minRewardRisk: number;
  meta?: {
    emaFast?: number;
    emaSlow?: number;
    trendEma?: number;
    rsi?: number;
    atr?: number;
    adx?: number;
    /** Wilder +DI on the signal timeframe (work-TF trend gate). */
    plusDi?: number;
    /** Wilder −DI on the signal timeframe (work-TF trend gate). */
    minusDi?: number;
    bbMid?: number;
    bbUpper?: number;
    bbLower?: number;
    /** Prior Donchian entry-channel high (long breakout level). */
    donchianUpper?: number;
    /** Prior Donchian entry-channel low (short breakout level). */
    donchianLower?: number;
    /** Prior-bar SMA of volume (breakout filter baseline). */
    volumeSma?: number;
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
  /** `strategy.registry.id` that opened this position. */
  strategyId: string;
  /** Hard stop price from the opening signal. */
  slPrice: number;
  /**
   * Fees paid to open this position, in USDC: the network priority fee plus
   * the perps open fee on a short. Included in `realizedPnl` on close.
   */
  paidFee?: number;
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

export interface Trade {
  pair: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  /** Realized P&L in quote currency (set on a closing fill). */
  realizedPnl?: number;
  /** Jupiter perps open + close + borrow charged on this fill (backtest shorts). */
  perpsFeeUsdc?: number;
  at: Date;
  simulated: boolean;
  /** On-chain transaction signature (live fills only). */
  txSignature?: string;
  /** Strategy / risk reason (e.g. EMA cross or ATR stop). */
  reason?: string;
}

export interface PortfolioSnapshot {
  cashUsdc: number;
  position: Position;
  realizedPnl: number;
  /** Mark-to-market equity = cash + position * markPrice. */
  equity: number;
  trades: Trade[];
  nativeSol: number;
  insufficientSol: number;
  simulated: boolean;
}

/** Intent to trade after risk checks (not yet filled). */
export interface Command {
  pair: string;
  intent: OrderIntent;
  /** Only `market` is executed today. */
  orderType: OrderType;
  reason: string;
  at: Date;
  /** Mid/spot hint from the signal before exchange costs. */
  priceHint: number;
  /** Quote budget for open-long and open-short. */
  quoteBudgetUsdc?: number;
  /** Base size for close-long, close-short, and buy-sol (SOL to buy). */
  baseSize?: number;
  /** Signal that produced this command. */
  signal?: Signal;
  /** Hard stop copied from {@link Signal.slPrice} on an opening command. */
  slPrice?: number;
}

/**
 * Perps fee schedule as fractions of notional.
 * Open and borrow come from the venue's pool-info rates. Close matches the open
 * base fee when the venue publishes one rate for both.
 */
export interface PerpsFees {
  openFeePct: number;
  closeFeePct: number;
  borrowFeePctPerHour: number;
}

/** Fill returned by an exchange (simulated paper/backtest or live on-chain). */
export interface Order {
  pair: string;
  type: OrderType;
  intent: OrderIntent;
  price: number;
  size: number;
  at: Date;
  simulated: boolean;
  /** On-chain transaction signature (live fills only). */
  txSignature?: string;
  reason: string;
  /** Network priority fee in USDC (0 for live paper quotes). */
  priorityFeeUsdc: number;
  /** `strategy.registry.id` for an opening fill. */
  strategyId?: string;
  /** Hard stop price for an opening fill. */
  slPrice?: number;
  /** Present for emulated (backtest) fills. */
  fillCosts?: {
    mid: number;
    slippageUsdcPerBase: number;
    poolFeeUsdcPerBase: number;
    /** Perps schedule. Set on short opens and covers; spot fills omit it. */
    perps?: PerpsFees;
  };
}

export interface BalanceSource {
  nativeSol(): number;
  refresh(mints: readonly string[]): Promise<void>;
  tokenUi(mint: string): number;
}

/**
 * Short-only position (perps)
 */
export interface OpenPosition {
  size: number;
  entryPrice: number;
  collateralUsd: number;
}

export interface PositionSource {
  findOpenPosition(pair: PairConfig): Promise<OpenPosition | null>;
}

export interface Portfolio {
  getSnapshot(markPrice: number): PortfolioSnapshot;
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
  /** `strategy.registry.id` (for example `bollinger`). */
  getId(): string;
  getRequiredCandles(): RequiredCandles;
  evaluateSignal(
    pair: string,
    candles: Candle[],
    market: MarketIndicators,
    price: number,
    at: Date,
    portfolio?: PortfolioSnapshot,
    /** Live perps rates from {@link Exchange.perpsFeeSchedule}. Omitted in unit tests. */
    perpsFees?: PerpsFees,
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

export interface ProtectiveCommand {
  kind: "protective-command";
  command: Command;
}

export interface NoCommand {
  kind: "no-command";
}

/** Tagged result of {@link RiskManager.check}: fill, protective exit, blocked signal, or HOLD / no-op. */
export type RiskOrCommand = ClearRisk | RequiredCommand | ProtectiveCommand | NoCommand;

/** Turns a strategy signal into a trade command using portfolio state. */
export interface RiskManager {
  getDisplayName(): string;
  check(signal: Signal, snapshot: PortfolioSnapshot, candles: Candle[]): RiskOrCommand;
}

/**
 * HTF market indicators plus the active strategy / risk (trend picks the risk manager).
 * Does not fetch candles — callers use {@link getRequiredHtfCandles} /
 * {@link getRequiredMtfCandles} then {@link evaluate}.
 */
export interface StrategyManager {
  getActiveStrategy(): Strategy;
  getActiveRiskManager(): RiskManager;
  getRequiredHtfCandles(): RequiredCandles;
  getRequiredMtfCandles(): RequiredCandles;
  evaluate(
    pair: string,
    htfCandles: Candle[],
    mtfCandles: Candle[],
    price: number,
    at: Date,
  ): MarketIndicators;
  /**
   * Sync risk manager to {@link MarketIndicators.trend}.
   * Returns true when trend or volatility changed.
   */
  applyMarketIndicators(
    indicators: MarketIndicators,
    lastMarketIndicators?: MarketIndicators,
  ): Promise<boolean>;
}

/** Quote + fill venue (Jupiter paper, live swap, or emulated backtest). */
export interface Exchange {
  spotPrice(pair: PairConfig): Promise<number>;
  execute(command: Command, pair: PairConfig): Promise<Order | Error>;
  /**
   * Open, close, and hourly short-borrow rates for this pair.
   * Implementations cache the result; callers may invoke this every tick.
   */
  perpsFeeSchedule(pair: PairConfig): Promise<PerpsFees>;
}

export interface ProgramState {
  readonly strategy: Strategy;
  readonly lastSignals: Map<string, Signal>;
  readonly lastCandles: Map<string, Candle[]>;
  readonly lastMarketIndicators: Map<string, MarketIndicators>;
  readonly portfolios: Map<string, Portfolio>;
}

export interface Error {
  readonly message: string;
}

export function isOrder(result: Order | Error): result is Order {
  return "intent" in result;
}

export type ShutdownCb = (reason: string, exitCode: number) => Promise<void>;
