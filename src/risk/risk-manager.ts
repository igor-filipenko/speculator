import type {
  ClearRisk,
  Command,
  NoCommand,
  RequiredCommand,
  RiskManager,
  RiskOrCommand,
  RiskParams,
  Signal,
  Snapshot,
  Timeframe,
  Trade,
} from "../types.js";

/**
 * v1 risk: one long per pair, all-in / all-out, plus ATR stop/trail,
 * post-SELL cooldown, and min-hold before discretionary cross exits.
 *
 * Market data (ATR, bar high/low) comes from {@link Signal.meta} — strategy owns candles.
 * Policy knobs are fixed at construction ({@link RiskParams}).
 */
export class SimpleRiskManager implements RiskManager {
  /** Peak close/high seen while long, per pair (for trailing stop). */
  private readonly peakByPair = new Map<string, number>();

  constructor(private readonly config: RiskParams) {}

  check(signal: Signal, snapshot: Snapshot): RiskOrCommand {
    this.syncPeak(signal, snapshot);

    const stopExit = evaluateProtectiveExit(signal, snapshot, this.config, this.peakByPair);
    if (stopExit) {
      this.peakByPair.delete(signal.pair);
      return asCommand(stopExit);
    }

    if (signal.side === "BUY") {
      if (snapshot.position.side === "long") {
        return blocked(signal, "already long");
      }
      if (snapshot.cashUsdc <= 0 || signal.price <= 0) {
        return blocked(signal, "no cash or invalid price");
      }
      if (inCooldown(snapshot.trades, signal.at, this.config)) {
        return blocked(signal, "cooldown after last SELL");
      }
      return asCommand({
        pair: signal.pair,
        side: "BUY",
        reason: signal.reason,
        at: signal.at,
        priceHint: signal.price,
        quoteBudgetUsdc: snapshot.cashUsdc,
      });
    }

    if (signal.side === "SELL") {
      if (snapshot.position.side !== "long" || snapshot.position.size <= 0) {
        return blocked(signal, "not long");
      }
      if (belowMinHold(snapshot, signal.at, this.config)) {
        return blocked(signal, "min hold not reached");
      }
      this.peakByPair.delete(signal.pair);
      return asCommand({
        pair: signal.pair,
        side: "SELL",
        reason: signal.reason,
        at: signal.at,
        priceHint: signal.price,
        baseSize: snapshot.position.size,
      });
    }

    return noCommand();
  }

  private syncPeak(signal: Signal, snapshot: Snapshot): void {
    if (snapshot.position.side !== "long" || snapshot.position.size <= 0) {
      this.peakByPair.delete(signal.pair);
      return;
    }
    const barHigh = signal.meta?.barHigh;
    const mark = barHigh != null && barHigh > 0 ? barHigh : signal.price;
    const prev = this.peakByPair.get(signal.pair) ?? snapshot.position.entryPrice;
    this.peakByPair.set(signal.pair, Math.max(prev, mark, snapshot.position.entryPrice));
  }
}

function asCommand(command: Command): RequiredCommand {
  return { kind: "command", command };
}

function blocked(signal: Signal, reason: string): ClearRisk {
  return { kind: "risk", risk: { signal, reason } };
}

function noCommand(): NoCommand {
  return { kind: "no-command" };
}

/** ATR hard stop / trailing exit using strategy-provided ATR and bar low. */
export function evaluateProtectiveExit(
  signal: Signal,
  snapshot: Snapshot,
  config: RiskParams,
  peakByPair?: Map<string, number>,
): Command | null {
  const { position } = snapshot;
  if (position.side !== "long" || position.size <= 0 || position.entryPrice <= 0) {
    return null;
  }

  const atrNow = signal.meta?.atr;
  const barLow = signal.meta?.barLow;
  if (atrNow == null || !(atrNow > 0) || barLow == null) {
    return null;
  }

  const stopPrice = position.entryPrice - config.atrStopMult * atrNow;
  const peakClose =
    peakByPair?.get(position.pair) ??
    Math.max(position.entryPrice, signal.meta?.barHigh ?? signal.price);
  const trailPrice = peakClose - config.atrTrailMult * atrNow;
  const exitLevel = Math.max(stopPrice, trailPrice);

  if (barLow > exitLevel) {
    return null;
  }

  const hitStop = barLow <= stopPrice;
  const hitTrail = barLow <= trailPrice;
  let reason: string;
  if (hitStop && hitTrail) {
    reason = `ATR stop/trail hit (level ${exitLevel.toFixed(4)}, ATR=${atrNow.toFixed(4)})`;
  } else if (hitStop) {
    reason = `ATR stop hit (${stopPrice.toFixed(4)}; entry ${position.entryPrice.toFixed(4)} − ${config.atrStopMult}×ATR)`;
  } else {
    reason = `ATR trail hit (${trailPrice.toFixed(4)}; peak ${peakClose.toFixed(4)} − ${config.atrTrailMult}×ATR)`;
  }

  return {
    pair: position.pair,
    side: "SELL",
    reason,
    at: signal.at,
    priceHint: exitLevel,
    baseSize: position.size,
  };
}

function inCooldown(trades: Trade[], at: Date, config: RiskParams): boolean {
  if (config.cooldownBars <= 0) {
    return false;
  }
  const lastSell = [...trades].reverse().find((t) => t.side === "SELL");
  if (!lastSell) {
    return false;
  }
  const intervalSec = timeframeSeconds(config.timeframe);
  const elapsedSec = Math.max(0, (at.getTime() - lastSell.at.getTime()) / 1000);
  const barsSince = Math.floor(elapsedSec / intervalSec);
  return barsSince < config.cooldownBars;
}

function belowMinHold(snapshot: Snapshot, at: Date, config: RiskParams): boolean {
  if (config.minHoldBars <= 0) {
    return false;
  }
  const openedAt = snapshot.position.openedAt;
  if (!openedAt) {
    return false;
  }
  const intervalSec = timeframeSeconds(config.timeframe);
  const elapsedSec = Math.max(0, (at.getTime() - openedAt.getTime()) / 1000);
  const barsHeld = Math.floor(elapsedSec / intervalSec);
  return barsHeld < config.minHoldBars;
}

function timeframeSeconds(timeframe: Timeframe): number {
  return timeframe === "4h" ? 4 * 60 * 60 : 15 * 60;
}
