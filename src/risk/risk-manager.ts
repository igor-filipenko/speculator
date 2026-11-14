import type {
  Candle,
  ClearRisk,
  Command,
  NoCommand,
  PositionDataCommand,
  ProtectiveCommand,
  RequiredCommand,
  RiskManager,
  RiskOrCommand,
  Signal,
  PortfolioSnapshot,
} from "../types.js";

/**
 * One open position on the book in the snapshot. Opens copy the strategy hard
 * stop and size the USDC budget so a stop-out loses at most this risk percent
 * of that book's equity. An open position closes when price trades through
 * `slPrice`. A signal may close a fraction and attach a new stop for the
 * remainder; the stop still closes whatever size is left. A tighter `slPrice`
 * on a signal that does not open, close, or scale out becomes a position-data
 * update and is not sent to the exchange.
 */
export class GenericRiskManager implements RiskManager {
  constructor(private readonly riskPercent = 2) {}

  getDisplayName(): string {
    return "Generic risk manager";
  }

  check(signal: Signal, snapshot: PortfolioSnapshot, _candles: Candle[]): RiskOrCommand {
    return checkDirected(signal, snapshot, this.riskPercent);
  }
}

function asCommand(command: Command): RequiredCommand {
  return { kind: "command", command };
}

/** Minimum USDC to spend on an opening order. */
export const MIN_OPEN_DEPOSIT_USDC = 10;

/** Attach the signal, and copy its hard stop onto an opening or scale-out command. */
function positionCommand(signal: Signal, command: Command, opening = false): Command {
  const next: Command = { ...command, signal };
  const scaleOut =
    signal.closeFraction != null && signal.closeFraction > 0 && signal.closeFraction < 1;
  if ((opening || scaleOut) && signal.slPrice !== undefined) {
    next.slPrice = signal.slPrice;
  }
  return next;
}

/** Base size to close. A fractional signal leaves the rest open; anything else closes all. */
function signalCloseSize(signal: Signal, positionSize: number): number {
  const fraction = signal.closeFraction;
  if (fraction == null || !(fraction > 0) || fraction >= 1 || !(positionSize > 0)) {
    return positionSize;
  }
  const size = positionSize * fraction;
  if (!(size > 0) || size >= positionSize) return positionSize;
  return size;
}

/**
 * Quote notional that loses `riskPercent` of equity if price trades from
 * `price` to `slPrice`. Null when the stop distance is missing.
 */
function maxDepositUsdc(
  equity: number,
  price: number,
  slPrice: number,
  riskPercent: number,
): number | null {
  const distance = Math.abs(price - slPrice);
  if (!(equity > 0) || !(price > 0) || !(distance > 0) || !(riskPercent > 0)) {
    return null;
  }
  return ((equity * riskPercent) / 100) * (price / distance);
}

/**
 * USDC to spend on an opening order. Caps cash so a stop-out loses at most
 * `riskPercent` of this book's equity. Returns a block reason when the stop
 * distance cannot size a deposit.
 */
function openingQuoteBudget(
  signal: Signal,
  snapshot: PortfolioSnapshot,
  riskPercent: number,
): { usdc: number } | { reason: string } {
  const sl = signal.slPrice;
  if (sl == null || !(sl > 0)) {
    return { usdc: snapshot.cashUsdc };
  }
  const maxDeposit = maxDepositUsdc(snapshot.equity, signal.price, sl, riskPercent);
  if (maxDeposit == null || !(maxDeposit >= MIN_OPEN_DEPOSIT_USDC)) {
    return { reason: "stop is at the entry price" };
  }
  return { usdc: Math.min(snapshot.cashUsdc, maxDeposit) };
}

function asProtectiveCommand(command: Command): ProtectiveCommand {
  return { kind: "protective-command", command };
}

function asPositionData(signal: Signal, slPrice: number): PositionDataCommand {
  return {
    kind: "position-data",
    data: {
      pair: signal.pair,
      at: signal.at,
      reason: signal.reason,
      signal,
      slPrice,
    },
  };
}

/**
 * Next stop when it tightens an open position. Longs only move up.
 * Shorts only move down. A flat book, a non-positive price, or a looser
 * price returns null.
 */
export function tighterStopPrice(
  side: "long" | "short" | "flat",
  size: number,
  current: number,
  next: number | undefined,
): number | null {
  if ((side !== "long" && side !== "short") || !(size > 0)) return null;
  if (next == null || !(next > 0) || !(current > 0)) return null;
  if (side === "long") return next > current ? next : null;
  return next < current ? next : null;
}

function blocked(signal: Signal, reason: string): ClearRisk {
  return { kind: "risk", risk: { signal, reason } };
}

function noCommand(): NoCommand {
  return { kind: "no-command" };
}

/** Close when the bar trades through the stored hard stop. Longs use bar low; shorts use bar high. */
export function evaluateProtectiveExit(
  signal: Signal,
  snapshot: PortfolioSnapshot,
): Command | null {
  const { position } = snapshot;
  if (position.size <= 0 || position.entryPrice <= 0) {
    return null;
  }
  const slExit = exitIfSlPriceReached(signal, snapshot);
  if (slExit) {
    return slExit;
  }
  return null;
}

/** Close when the bar trades through the stored hard stop. */
function exitIfSlPriceReached(signal: Signal, snapshot: PortfolioSnapshot): Command | null {
  const { position } = snapshot;
  const sl = position.slPrice;
  if (sl == null || !(sl > 0)) {
    return null;
  }
  if (position.side === "long") {
    const mark = signal.meta?.barLow ?? signal.price;
    if (!(mark <= sl)) {
      return null;
    }
    return {
      pair: position.pair,
      intent: "close-long",
      orderType: "market",
      reason: `hard stop hit (${sl.toFixed(4)})`,
      at: signal.at,
      priceHint: sl,
      baseSize: position.size,
    };
  }
  if (position.side === "short") {
    const mark = signal.meta?.barHigh ?? signal.price;
    if (!(mark >= sl)) {
      return null;
    }
    return {
      pair: position.pair,
      intent: "close-short",
      orderType: "market",
      reason: `hard stop hit (${sl.toFixed(4)})`,
      at: signal.at,
      priceHint: sl,
      baseSize: position.size,
    };
  }
  return null;
}

function checkDirected(
  signal: Signal,
  snapshot: PortfolioSnapshot,
  riskPercent: number,
): RiskOrCommand {
  if (snapshot.position.side === "flat" && snapshot.insufficientSol > 0) {
    return asCommand(
      positionCommand(signal, {
        pair: signal.pair,
        intent: "buy-sol",
        orderType: "market",
        reason: "native SOL below reserve minimum",
        at: signal.at,
        priceHint: signal.price,
        baseSize: snapshot.insufficientSol,
      }),
    );
  }

  const { position: open } = snapshot;
  // A repeated entry on the side already open carries a fresh entry stop, not a trail.
  // A fractional exit's stop belongs to the remainder and is copied onto the close.
  const scaleOut =
    signal.closeFraction != null && signal.closeFraction > 0 && signal.closeFraction < 1;
  const candidate =
    scaleOut ||
    (open.side === "long" && signal.side === "BUY") ||
    (open.side === "short" && signal.side === "SELL")
      ? undefined
      : signal.slPrice;
  const nextStop = tighterStopPrice(open.side, open.size, open.slPrice, candidate);
  const book =
    nextStop == null
      ? snapshot
      : { ...snapshot, position: { ...snapshot.position, slPrice: nextStop } };
  const stopExit = evaluateProtectiveExit(signal, book);
  if (stopExit) {
    return asProtectiveCommand(positionCommand(signal, stopExit));
  }

  const position = snapshot.position.side;

  if (signal.side === "BUY") {
    if (position === "long") {
      return nextStop == null ? blocked(signal, "already long") : asPositionData(signal, nextStop);
    }
    if (position === "short") {
      if (snapshot.position.size <= 0) {
        return blocked(signal, "not short");
      }
      return asCommand(
        positionCommand(signal, {
          pair: signal.pair,
          intent: "close-short",
          orderType: "market",
          reason: signal.reason,
          at: signal.at,
          priceHint: signal.price,
          baseSize: signalCloseSize(signal, snapshot.position.size),
        }),
      );
    }
    if (snapshot.cashUsdc <= 0 || signal.price <= 0) {
      return blocked(signal, "no cash or invalid price");
    }
    const budget = openingQuoteBudget(signal, snapshot, riskPercent);
    if ("reason" in budget) {
      return blocked(signal, budget.reason);
    }
    return asCommand(
      positionCommand(
        signal,
        {
          pair: signal.pair,
          intent: "open-long",
          orderType: "market",
          reason: signal.reason,
          at: signal.at,
          priceHint: signal.price,
          quoteBudgetUsdc: budget.usdc,
        },
        true,
      ),
    );
  }

  if (signal.side === "SELL") {
    if (position === "short") {
      return nextStop == null ? blocked(signal, "already short") : asPositionData(signal, nextStop);
    }
    if (position === "long") {
      if (snapshot.position.size <= 0) {
        return blocked(signal, "not long");
      }
      return asCommand(
        positionCommand(signal, {
          pair: signal.pair,
          intent: "close-long",
          orderType: "market",
          reason: signal.reason,
          at: signal.at,
          priceHint: signal.price,
          baseSize: signalCloseSize(signal, snapshot.position.size),
        }),
      );
    }
    if (snapshot.cashUsdc <= 0 || signal.price <= 0) {
      return blocked(signal, "no cash or invalid price");
    }
    const budget = openingQuoteBudget(signal, snapshot, riskPercent);
    if ("reason" in budget) {
      return blocked(signal, budget.reason);
    }
    return asCommand(
      positionCommand(
        signal,
        {
          pair: signal.pair,
          intent: "open-short",
          orderType: "market",
          reason: signal.reason,
          at: signal.at,
          priceHint: signal.price,
          quoteBudgetUsdc: budget.usdc,
        },
        true,
      ),
    );
  }

  if (nextStop != null) return asPositionData(signal, nextStop);
  return noCommand();
}
