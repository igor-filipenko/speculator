import { candleIntervalSeconds } from "../market/gecko-terminal.js";
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
  PortfolioSnapshot,
  Trade,
} from "../types.js";

export interface RiskDirection {
  /** New longs from flat. Exits still fire when this is false. */
  allowLong: boolean;
  /** New shorts from flat. Exits still fire when this is false. */
  allowShort: boolean;
  /** Reason when a new entry is refused. */
  blockReason?: string;
}

/**
 * One position per pair (long or short), all-in / all-out, plus ATR stop/trail,
 * post-exit cooldown, and min-hold before discretionary exits.
 *
 * Market data (ATR, bar high/low) comes from {@link Signal.meta} — strategy owns candles.
 * Long trail uses the peak high since open; short trail uses the trough low.
 */
export class GenericRiskManager implements RiskManager {
  constructor(
    private readonly config: RiskParams,
    private readonly direction: RiskDirection = { allowLong: true, allowShort: false },
  ) {}

  getDisplayName(): string {
    return "Generic risk manager";
  }

  check(signal: Signal, snapshot: PortfolioSnapshot, candles: Candle[]): RiskOrCommand {
    return checkDirected(signal, snapshot, candles, this.config, this.direction);
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
  snapshot: PortfolioSnapshot,
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

/** Min of entry, current bar low, and candle lows overlapping the open hold. */
export function troughSinceOpen(
  snapshot: PortfolioSnapshot,
  candles: Candle[],
  signal: Signal,
  intervalSec: number,
): number {
  const entry = snapshot.position.entryPrice;
  const barLow = signal.meta?.barLow;
  const mark = barLow != null && barLow > 0 ? barLow : signal.price;
  let trough = Math.min(entry, mark);

  const openedAt = snapshot.position.openedAt;
  if (openedAt == null || candles.length === 0 || intervalSec <= 0) {
    return trough;
  }

  const openedSec = openedAt.getTime() / 1000;
  for (const candle of candles) {
    if (candle.time + intervalSec > openedSec) {
      trough = Math.min(trough, candle.low);
    }
  }
  return trough;
}

/** ATR hard stop / trailing exit. Longs use bar low; shorts use bar high. */
export function evaluateProtectiveExit(
  signal: Signal,
  snapshot: PortfolioSnapshot,
  config: RiskParams,
  peak?: number,
  trough?: number,
): Command | null {
  const { position } = snapshot;
  if (position.size <= 0 || position.entryPrice <= 0) {
    return null;
  }
  if (position.side === "long") {
    return longProtectiveExit(signal, snapshot, config, peak);
  }
  if (position.side === "short") {
    return shortProtectiveExit(signal, snapshot, config, trough);
  }
  return null;
}

function longProtectiveExit(
  signal: Signal,
  snapshot: PortfolioSnapshot,
  config: RiskParams,
  peak?: number,
): Command | null {
  const { position } = snapshot;
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
    intent: "close-long",
    reason,
    at: signal.at,
    priceHint: exitLevel,
    baseSize: position.size,
  };
}

function shortProtectiveExit(
  signal: Signal,
  snapshot: PortfolioSnapshot,
  config: RiskParams,
  trough?: number,
): Command | null {
  const { position } = snapshot;
  const atrNow = signal.meta?.atr;
  const barHigh = signal.meta?.barHigh;
  if (atrNow == null || !(atrNow > 0) || barHigh == null) {
    return null;
  }

  const stopPrice = position.entryPrice + config.atrStopMult * atrNow;
  const troughClose = trough ?? Math.min(position.entryPrice, signal.meta?.barLow ?? signal.price);
  const trailPrice = troughClose + config.atrTrailMult * atrNow;
  const exitLevel = Math.min(stopPrice, trailPrice);

  if (barHigh < exitLevel) {
    return null;
  }

  const hitStop = barHigh >= stopPrice;
  const hitTrail = barHigh >= trailPrice;
  let reason: string;
  if (hitStop && hitTrail) {
    reason = `ATR stop/trail hit (level ${exitLevel.toFixed(4)}, ATR=${atrNow.toFixed(4)})`;
  } else if (hitStop) {
    reason = `ATR stop hit (${stopPrice.toFixed(4)}; entry ${position.entryPrice.toFixed(4)} + ${config.atrStopMult}×ATR)`;
  } else {
    reason = `ATR trail hit (${trailPrice.toFixed(4)}; trough ${troughClose.toFixed(4)} + ${config.atrTrailMult}×ATR)`;
  }

  return {
    pair: position.pair,
    side: "BUY",
    intent: "close-short",
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
  const lastExit = [...trades].reverse().find((t) => t.realizedPnl != null);
  if (!lastExit) {
    return false;
  }
  const intervalSec = candleIntervalSeconds(config.timeframe);
  const elapsedSec = Math.max(0, (at.getTime() - lastExit.at.getTime()) / 1000);
  const barsSince = Math.floor(elapsedSec / intervalSec);
  return barsSince < config.cooldownBars;
}

function belowMinHold(snapshot: PortfolioSnapshot, at: Date, config: RiskParams): boolean {
  if (config.minHoldBars <= 0) {
    return false;
  }
  const openedAt = snapshot.position.openedAt;
  if (!openedAt) {
    return false;
  }
  const intervalSec = candleIntervalSeconds(config.timeframe);
  const elapsedSec = Math.max(0, (at.getTime() - openedAt.getTime()) / 1000);
  const barsHeld = Math.floor(elapsedSec / intervalSec);
  return barsHeld < config.minHoldBars;
}
/**
 * Blocks new longs. Short entries only when `allowShort` is set (bearish HTF).
 * Exits and ATR stops still fire.
 */
export class HighRiskManager implements RiskManager {
  constructor(
    private readonly message: string,
    private readonly config: RiskParams,
    private readonly allowShort = false,
  ) {}

  getDisplayName(): string {
    return "High risk manager";
  }

  check(signal: Signal, snapshot: PortfolioSnapshot, candles: Candle[]): RiskOrCommand {
    return checkDirected(signal, snapshot, candles, this.config, {
      allowLong: false,
      allowShort: this.allowShort,
      blockReason: `high risk, ${this.message}`,
    });
  }
}

function checkDirected(
  signal: Signal,
  snapshot: PortfolioSnapshot,
  candles: Candle[],
  config: RiskParams,
  direction: RiskDirection,
): RiskOrCommand {
  const interval = candleIntervalSeconds(config.timeframe);
  const peak = peakSinceOpen(snapshot, candles, signal, interval);
  const trough = troughSinceOpen(snapshot, candles, signal, interval);
  const stopExit = evaluateProtectiveExit(signal, snapshot, config, peak, trough);
  if (stopExit) {
    return asCommand(stopExit);
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
      if (belowMinHold(snapshot, signal.at, config)) {
        return blocked(signal, "min hold not reached");
      }
      return asCommand({
        pair: signal.pair,
        side: "BUY",
        intent: "close-short",
        reason: signal.reason,
        at: signal.at,
        priceHint: signal.price,
        baseSize: snapshot.position.size,
      });
    }
    if (!direction.allowLong) {
      return blocked(signal, direction.blockReason ?? "long entries blocked");
    }
    if (snapshot.cashUsdc <= 0 || signal.price <= 0) {
      return blocked(signal, "no cash or invalid price");
    }
    if (inCooldown(snapshot.trades, signal.at, config)) {
      return blocked(signal, "cooldown after last exit");
    }
    return asCommand({
      pair: signal.pair,
      side: "BUY",
      intent: "open-long",
      reason: signal.reason,
      at: signal.at,
      priceHint: signal.price,
      quoteBudgetUsdc: snapshot.cashUsdc,
    });
  }

  if (signal.side === "SELL") {
    if (position === "short") {
      return blocked(signal, "already short");
    }
    if (position === "long") {
      if (snapshot.position.size <= 0) {
        return blocked(signal, "not long");
      }
      if (belowMinHold(snapshot, signal.at, config)) {
        return blocked(signal, "min hold not reached");
      }
      return asCommand({
        pair: signal.pair,
        side: "SELL",
        intent: "close-long",
        reason: signal.reason,
        at: signal.at,
        priceHint: signal.price,
        baseSize: snapshot.position.size,
      });
    }
    if (!direction.allowShort) {
      return blocked(signal, direction.blockReason ?? "short entries blocked");
    }
    if (snapshot.cashUsdc <= 0 || signal.price <= 0) {
      return blocked(signal, "no cash or invalid price");
    }
    if (inCooldown(snapshot.trades, signal.at, config)) {
      return blocked(signal, "cooldown after last exit");
    }
    return asCommand({
      pair: signal.pair,
      side: "SELL",
      intent: "open-short",
      reason: signal.reason,
      at: signal.at,
      priceHint: signal.price,
      quoteBudgetUsdc: snapshot.cashUsdc,
    });
  }

  return noCommand();
}
