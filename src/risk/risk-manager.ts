import type {
  Candle,
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
 * Trailing peak is max high of OHLCV since {@link Position.openedAt} (plus entry).
 * Policy knobs are fixed at construction ({@link RiskParams}).
 */
export class SimpleRiskManager implements RiskManager {
  constructor(private readonly config: RiskParams) {}

  check(signal: Signal, snapshot: Snapshot, candles: Candle[]): RiskOrCommand {
    const peak = peakSinceOpen(snapshot, candles, signal, timeframeSeconds(this.config.timeframe));
    // HOLD may still carry barLow/atr for display; stops only apply on BUY/SELL.
    const stopExit =
      signal.side === "HOLD" ? null : evaluateProtectiveExit(signal, snapshot, this.config, peak);
    if (stopExit) {
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

/** Max of entry, current bar high, and candle highs overlapping the open hold. */
export function peakSinceOpen(
  snapshot: Snapshot,
  candles: Candle[],
  signal: Signal,
  intervalSec: number,
): number {
  const entry = snapshot.position.entryPrice;
  const barHigh = signal.meta?.barHigh;
  const mark = barHigh != null && barHigh > 0 ? barHigh : signal.price;
  let peak = Math.max(entry, mark);

  const openedAt = snapshot.position.openedAt;
  if (openedAt == null || candles.length === 0 || intervalSec <= 0) {
    return peak;
  }

  const openedSec = openedAt.getTime() / 1000;
  for (const candle of candles) {
    if (candle.time + intervalSec > openedSec) {
      peak = Math.max(peak, candle.high);
    }
  }
  return peak;
}

/** ATR hard stop / trailing exit using strategy-provided ATR and bar low. */
export function evaluateProtectiveExit(
  signal: Signal,
  snapshot: Snapshot,
  config: RiskParams,
  peak?: number,
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
  const peakClose = peak ?? Math.max(position.entryPrice, signal.meta?.barHigh ?? signal.price);
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
