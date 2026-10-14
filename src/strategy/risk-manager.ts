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
 * size the USDC budget so a stop-out loses at most {@link MAX_RISK_PERCENT} of
 * equity. When the signal lists take-profit prices, the furthest target must
 * pay at least {@link Signal.minRewardRisk}. An open position closes when
 * price trades through `slPrice`.
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

/**
 * Float slack for the reward:risk gate. `(price + 9a - price) / (price - (price - 3a))`
 * can land a few ULPs under an exact 3, which would block a signal sitting on the floor.
 */
const REWARD_RISK_EPSILON = 1e-9;

/** Minimum USDC to spend on an opening order. */
export const MIN_OPEN_DEPOSIT_USDC = 10;

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

/**
 * Distance from `price` to the furthest take-profit in the trade direction.
 * Null when every listed price is on the stop side of the entry.
 */
function bestTpReward(signal: Signal): number | null {
  let best = 0;
  for (const tp of signal.tpPrices) {
    if (!(tp > 0)) continue;
    const reward = signal.side === "BUY" ? tp - signal.price : signal.price - tp;
    if (reward > best) best = reward;
  }
  return best > 0 ? best : null;
}

/**
 * Block when listed take-profits pay less than {@link Signal.minRewardRisk}
 * against the hard stop. Signals with an empty ladder skip this gate.
 */
function rewardRiskReason(signal: Signal): string | null {
  if (signal.tpPrices.length === 0) return null;
  const sl = signal.slPrice;
  if (sl == null || !(sl > 0) || !(signal.price > 0)) return null;
  const risk = Math.abs(signal.price - sl);
  if (!(risk > 0)) return null;
  const reward = bestTpReward(signal);
  if (reward == null || reward / risk < signal.minRewardRisk - REWARD_RISK_EPSILON) {
    return `reward:risk below 1:${signal.minRewardRisk} sl=${sl.toFixed(4)} risk=${risk.toFixed(4)} reward=${reward?.toFixed(4) ?? "null"}`;
  }
  return null;
}

/**
 * USDC to spend on an opening order. Caps cash so a stop-out loses at most
 * {@link MAX_RISK_PERCENT} of equity. Returns a block reason when the stop
 * distance cannot size a deposit, or when take-profits fail {@link Signal.minRewardRisk}.
 */
function openingQuoteBudget(
  signal: Signal,
  snapshot: PortfolioSnapshot,
): { usdc: number } | { reason: string } {
  const rewardRisk = rewardRiskReason(signal);
  if (rewardRisk != null) return { reason: rewardRisk };
  const sl = signal.slPrice;
  if (sl == null || !(sl > 0)) {
    return { usdc: snapshot.cashUsdc };
  }
  const maxDeposit = maxDepositUsdc(snapshot.equity, signal.price, sl);
  if (maxDeposit == null || !(maxDeposit >= MIN_OPEN_DEPOSIT_USDC)) {
    return { reason: "stop is at the entry price" };
  }
  return { usdc: Math.min(snapshot.cashUsdc, maxDeposit) };
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
    const budget = openingQuoteBudget(signal, snapshot);
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
    const budget = openingQuoteBudget(signal, snapshot);
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

  return noCommand();
}
