/** Shared domain types for signals, paper, backtest, and live trading. */

export type SignalSide = "BUY" | "SELL" | "HOLD";

export type PositionSide = "flat" | "long" | "short";

/** What a command does to the single position. */
export type OrderIntent = "open-long" | "close-long" | "open-short" | "close-short" | "buy-sol";

export type OrderType = "market" | "limit";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/**
 * OHLCV vendors this process can fetch.
 * Postgres `market.candle_source` lists additional vendors so the column type
 * does not change when a new client is added.
 */
export type CandleSource = "gecko-terminal" | "binance" | "birdeye";

export interface Candle {
  /** Unix timestamp in seconds (candle open time). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timeframe: Timeframe;
  intervalSeconds: number;
  source: CandleSource;
  isClosed(atSec: number): boolean;
}

export interface FetchCandlesOptions {
  pair: PairConfig;
  timeframe: Timeframe;
  /** Inclusive lower bound (Unix seconds) for the series returned to the caller. */
  fromTime?: number;
  /**
   * Exclusive upper bound (Unix seconds). Defaults to now.
   * Matches replay windows: a bar is included when `fromTime <= time < toTime`.
   */
  toTime?: number;
  /**
   * Return the cached series without an upstream call when its length matches
   * the window (a 1h window of 15m bars is 4 candles). A short series is still fetched.
   */
  tryUseCache?: boolean;
}

export interface Market {
  readonly source: CandleSource;
  fetchCandles(options: FetchCandlesOptions): Promise<Candle[]>;
}

export interface Signal {
  pair: string;
  side: SignalSide;
  reason: string;
  price: number;
  at: Date;
  /** `strategy.registry.id` of the strategy that produced this signal. */
  strategyId: string;
  /**
   * Hard stop. An opening signal sets the initial stop. A later signal may
   * set a tighter candidate; the risk manager writes it onto the position
   * only when it improves the stored stop.
   */
  slPrice?: number;
  /**
   * Take-profit prices, nearest first.
   * Bollinger sets the middle band. Donchian sets none (empty).
   * The risk manager uses the furthest price for the reward:risk gate.
   */
  tpPrices: number[];
  /**
   * Minimum reward per unit of stop risk for an opening signal.
   * Bollinger holds below 0.2 after round-trip fees. The risk manager applies
   * the same floor to the gross target. Unused when `tpPrices` is empty (Donchian sets 0).
   */
  minRewardRisk: number;
  /**
   * Share of the open position this exit closes. Omitted means the whole position.
   * A protective stop ignores it and closes the full size.
   */
  closeFraction?: number;
  meta?: {
    emaFast?: number;
    emaSlow?: number;
    trendEma?: number;
    /** MACD line (fast EMA minus slow EMA) on the signal bar. */
    macd?: number;
    /** Signal line: EMA of the MACD line. */
    macdSignal?: number;
    /** MACD line minus signal line. Above zero is the long filter. */
    macdHist?: number;
    rsi?: number;
    /** Slow stochastic %K on the signal bar. */
    stochK?: number;
    /** Slow stochastic %D on the signal bar. */
    stochD?: number;
    atr?: number;
    adx?: number;
    /** Wilder +DI on the signal timeframe (work-TF trend gate). */
    plusDi?: number;
    /** Wilder −DI on the signal timeframe (work-TF trend gate). */
    minusDi?: number;
    bbMid?: number;
    bbUpper?: number;
    bbLower?: number;
    /** Keltner mid (EMA of the signal closes). */
    kcMid?: number;
    kcUpper?: number;
    kcLower?: number;
    /** Prior Donchian entry-channel high (long breakout level). */
    donchianUpper?: number;
    /** Prior Donchian entry-channel low (short breakout level). */
    donchianLower?: number;
    /** Prior-bar SMA of volume (breakout / RVOL baseline). */
    volumeSma?: number;
    /** Signal-bar volume divided by the prior volume SMA. */
    rvol?: number;
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
  /** Hard stop. An opening fill sets it; a later book update may only tighten it. */
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
  poolAddress: string;
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

/**
 * Book update for an open position. Not an order: size, side, and entry stay put,
 * and nothing is sent to the exchange.
 */
export interface PositionData {
  pair: string;
  at: Date;
  reason: string;
  signal?: Signal;
  /** Next hard stop. The risk manager only emits a tighter price. */
  slPrice: number;
}

export interface Portfolio {
  getSnapshot(markPrice: number): PortfolioSnapshot;
  applyOrder(order: Order): Promise<Trade | null>;
  /** Refresh on-chain balances before sizing. Paper is a no-op. */
  syncFromChain(markPrice: number): Promise<void>;
  /**
   * Tighten the stored stop and persist the book. No trade row.
   * A price that does not tighten the open position is ignored.
   */
  applyPositionData(data: PositionData): Promise<void>;
}

export interface RequiredCandles {
  timeframe: Timeframe;
  count: number;
}

/** One numeric knob in a {@link SearchSpace}. `timeframe` levels are minutes. */
export interface SearchAxis {
  key: string;
  levels: readonly number[];
}

/**
 * Grid explored by `pnpm tune`.
 * Each {@link Strategy} implements this. An absent `accept` keeps every combination.
 */
export interface SearchSpace {
  axes: readonly SearchAxis[];
  /** Drop a combination. Absent means every combination is valid. */
  accept?: (values: Readonly<Record<string, number>>) => boolean;
}

/**
 * Overrides merged onto a strategy's defaults.
 * A tune sample stores `timeframe` in minutes; {@link Strategy.paramPatch} writes
 * the candle label here. `values` are that strategy's own knobs. Tune reads only
 * `timeframe`.
 */
export interface StrategyParamPatch {
  /** Signal series to replay when the sample names a timeframe. */
  timeframe?: Timeframe;
  /** Knob overrides. Keys belong to the strategy that built the patch. */
  values?: Readonly<Record<string, number | string | boolean>>;
}

/** Copy a tune patch onto strategy defaults. Unknown keys are ignored. */
export function applySearchPatch<T extends object>(
  base: T,
  patch: StrategyParamPatch | undefined,
): T {
  if (patch === undefined) return base;
  const merged = { ...base };
  const record = merged as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch.values ?? {})) {
    if (key in record) record[key] = value;
  }
  if (patch.timeframe !== undefined && "timeframe" in record) {
    record["timeframe"] = patch.timeframe;
  }
  return merged;
}

export interface Strategy extends SearchSpace {
  getDisplayName(): string;
  /** `strategy.registry.id`. */
  getId(): string;
  getRequiredCandles(): RequiredCandles;
  /**
   * Current numeric knobs. `timeframe` is minutes so it matches that search axis.
   * Tune reads this for the default point on {@link SearchSpace.axes}.
   */
  getSearchDefaults(): Readonly<Record<string, number>>;
  /**
   * Tune sample → overrides for this strategy. `timeframe` in `values` is minutes.
   * Other keys match {@link SearchSpace} axes.
   */
  paramPatch(values: Readonly<Record<string, number>>): StrategyParamPatch;
  evaluateSignal(
    pair: string,
    candles: Candle[],
    price: number,
    at: Date,
    portfolio?: PortfolioSnapshot,
    /** Live perps rates from {@link Exchange.perpsFeeSchedule}. Omitted in unit tests. */
    perpsFees?: PerpsFees,
  ): Signal;
  /** Strategy-owned OHLCV chart overlays. */
  buildChartSvg(pair: string, candles: Candle[]): string;
}

/**
 * Public entry of `src/strategy/mode/<id>/`. `index.ts` exports this.
 * `id` is the `strategy.registry` primary key, the directory name, and {@link Strategy.getId}.
 */
export interface StrategyModule {
  id: string;
  create(patch?: StrategyParamPatch): Strategy;
  /** Full knob object from that module's `*ParamsFor()`. Copied onto a new instance. */
  defaults(): object;
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

/** Book update. The engine persists it and does not call the exchange. */
export interface PositionDataCommand {
  kind: "position-data";
  data: PositionData;
}

/** Tagged result of {@link RiskManager.check}: fill, protective exit, book update, blocked signal, or HOLD / no-op. */
export type RiskOrCommand =
  ClearRisk | RequiredCommand | ProtectiveCommand | PositionDataCommand | NoCommand;

/** Turns a strategy signal into a trade command using portfolio state. */
export interface RiskManager {
  getDisplayName(): string;
  check(signal: Signal, snapshot: PortfolioSnapshot, candles: Candle[]): RiskOrCommand;
}

/** Active strategy and risk manager for one process. */
export interface StrategyManager {
  getActiveStrategy(): Strategy;
  getActiveRiskManager(): RiskManager;
}

/** Quote + fill venue (Jupiter paper, live swap, or emulated backtest). */
export interface Exchange {
  spotPrice(pair: PairConfig): Promise<number>;
  execute(command: Command, pair: PairConfig): Promise<Order | Error>;
  /**
   * Open, close, and hourly short-borrow rates for this pair.
   * Resolves `undefined` when Jupiter Perps lists no market for the pair, so it
   * cannot be shorted and strategies stay long-only.
   * Implementations cache the result; callers may invoke this every tick.
   */
  perpsFeeSchedule(pair: PairConfig): Promise<PerpsFees | undefined>;
}

export interface ProgramState {
  readonly strategy: Strategy;
  readonly lastSignals: Map<string, Signal>;
  readonly lastCandles: Map<string, Candle[]>;
  readonly portfolios: Map<string, Portfolio>;
}

export interface Error {
  readonly message: string;
}

export function isOrder(result: Order | Error): result is Order {
  return "intent" in result;
}

export type ShutdownCb = (reason: string, exitCode: number) => Promise<void>;
