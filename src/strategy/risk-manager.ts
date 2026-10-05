import type {
  Candle,
  ClearRisk,
  Command,
  NoCommand,
  ProtectiveCommand,
  RequiredCommand,
  RiskManager,
  RiskOrCommand,
  Signal,
  PortfolioSnapshot,
} from "../types.js";

/**
 * One position per pair (long or short). Opens copy the strategy hard stop and
 * refuse a deposit that would lose more than {@link MAX_RISK_PERCENT} of equity
 * at that stop. An open position closes when price trades through `slPrice`.
 */
export class GenericRiskManager implements RiskManager {
  getDisplayName(): string {
    return "Generic risk manager";
  }

  check(signal: Signal, snapshot: PortfolioSnapshot, _candles: Candle[]): RiskOrCommand {
    return checkDirected(signal, snapshot);
  }
}

function asCommand(command: Command): RequiredCommand {
  return { kind: "command", command };
}

/** Max loss at the hard stop, as a percent of equity. */
export const MAX_RISK_PERCENT = 2;

/** Attach the signal, and copy its hard stop onto an opening command. */
function positionCommand(signal: Signal, command: Command, opening = false): Command {
  const next: Command = { ...command, signal };
  if (opening && signal.slPrice !== undefined) {
    next.slPrice = signal.slPrice;
  }
  return next;
}

/**
 * Quote notional that loses `MAX_RISK_PERCENT` of equity if price trades from
 * `price` to `slPrice`. Null when the stop distance is missing.
 */
function maxDepositUsdc(equity: number, price: number, slPrice: number): number | null {
  const distance = Math.abs(price - slPrice);
  if (!(equity > 0) || !(price > 0) || !(distance > 0)) {
    return null;
  }
  return ((equity * MAX_RISK_PERCENT) / 100) * (price / distance);
}

/** Block an entry whose cash would lose more than {@link MAX_RISK_PERCENT} at the stop. */
function depositBlock(signal: Signal, snapshot: PortfolioSnapshot): string | null {
  const sl = signal.slPrice;
  if (sl == null || !(sl > 0)) {
    return null;
  }
  const maxDeposit = maxDepositUsdc(snapshot.equity, signal.price, sl);
  if (maxDeposit == null) {
    return "stop is at the entry price";
  }
  if (snapshot.cashUsdc > maxDeposit) {
    return `deposit ${snapshot.cashUsdc.toFixed(2)} USDC exceeds max ${maxDeposit.toFixed(2)} (${MAX_RISK_PERCENT}% of equity at the stop)`;
  }
  return null;
}

function asProtectiveCommand(command: Command): ProtectiveCommand {
  return { kind: "protective-command", command };
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

function checkDirected(signal: Signal, snapshot: PortfolioSnapshot): RiskOrCommand {
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

  const stopExit = evaluateProtectiveExit(signal, snapshot);
  if (stopExit) {
    return asProtectiveCommand(positionCommand(signal, stopExit));
  }

  const position = snapshot.position.side;

  if (signal.side === "BUY") {
    if (position === "long") {
      return blocked(signal, "already long");
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
          baseSize: snapshot.position.size,
        }),
      );
    }
    if (snapshot.cashUsdc <= 0 || signal.price <= 0) {
      return blocked(signal, "no cash or invalid price");
    }
    const overDeposit = depositBlock(signal, snapshot);
    if (overDeposit !== null) {
      return blocked(signal, overDeposit);
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
          quoteBudgetUsdc: snapshot.cashUsdc,
        },
        true,
      ),
    );
  }

  if (signal.side === "SELL") {
    if (position === "short") {
      return blocked(signal, "already short");
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
          baseSize: snapshot.position.size,
        }),
      );
    }
    if (snapshot.cashUsdc <= 0 || signal.price <= 0) {
      return blocked(signal, "no cash or invalid price");
    }
    const overDeposit = depositBlock(signal, snapshot);
    if (overDeposit !== null) {
      return blocked(signal, overDeposit);
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
          quoteBudgetUsdc: snapshot.cashUsdc,
        },
        true,
      ),
    );
  }

  return noCommand();
}
