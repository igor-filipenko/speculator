import { ExchangeError } from "../error.js";
import type {
  Command,
  Error,
  Exchange,
  Order,
  OrderIntent,
  PairConfig,
  PerpsFees,
} from "../../types.js";
import { JUPITER_PERPS_FEES } from "../jupiter/perps-fees.js";
import { emulateFillPrice, liquidityTierForPair } from "./emulated-quote.js";

/**
 * Offline exchange: fills from candle mid + Jupiter-like fee/slippage model.
 * Call {@link setMidPrice} before each tick's spotPrice/execute.
 * Optionally call {@link setCandleVolumeUsdc} once per bar to enable volume-weighted slippage.
 */
export class EmulatedExchange implements Exchange {
  private mid = 0;
  private candleVolumeUsdc = 0;

  setMidPrice(mid: number): void {
    this.mid = mid;
  }

  /**
   * Set the current bar's USDC volume (base token volume × close price).
   * Called once per candle before the intra-bar tick loop in backtest replay.
   * Enables AMM price-impact slippage in {@link execute}.
   */
  setCandleVolumeUsdc(volumeUsdc: number): void {
    this.candleVolumeUsdc = volumeUsdc > 0 ? volumeUsdc : 0;
  }

  /** Offline snapshot. Backtest does not call Jupiter. */
  perpsFeeSchedule(_pair: PairConfig): Promise<PerpsFees> {
    return Promise.resolve(JUPITER_PERPS_FEES);
  }

  spotPrice(_pair: PairConfig): Promise<number> {
    if (!(this.mid > 0)) {
      return Promise.reject(new Error("EmulatedExchange: mid price not set"));
    }
    return Promise.resolve(this.mid);
  }

  execute(command: Command, pair: PairConfig): Promise<Order | Error> {
    if (command.orderType !== "market") {
      return Promise.resolve(
        new ExchangeError(`EmulatedExchange: ${command.orderType} orders are not supported`),
      );
    }
    if (!(this.mid > 0)) {
      return Promise.resolve(new ExchangeError("EmulatedExchange: mid price not set"));
    }

    if (command.intent === "buy-sol") {
      return Promise.resolve(new ExchangeError("EmulatedExchange: buy-sol is live only"));
    }

    const tier = liquidityTierForPair(pair.symbol);
    const perps = command.intent === "open-short" || command.intent === "close-short";
    const opens = command.intent === "open-long" || command.intent === "open-short";

    // Estimate trade size in USDC for volume-impact slippage.
    // Opens: the quote budget; closes: baseSize × current mid.
    const tradeUsdc = opens ? (command.quoteBudgetUsdc ?? 0) : (command.baseSize ?? 0) * this.mid;

    const emulated = emulateFillPrice({
      side: fillSide(command.intent),
      close: this.mid,
      tier,
      tradeUsdc,
      candleVolumeUsdc: this.candleVolumeUsdc,
      ...(perps ? { venue: "perps" as const } : {}),
    });
    const { fillPrice, priorityFeeUsdc, breakdown } = emulated;

    const fillCosts = {
      mid: breakdown.mid,
      slippageUsdcPerBase: breakdown.slippageUsdcPerBase,
      poolFeeUsdcPerBase: breakdown.poolFeeUsdcPerBase,
      ...(breakdown.perps != null ? { perps: breakdown.perps } : {}),
    };

    if (opens) {
      const budget = command.quoteBudgetUsdc ?? 0;
      const spendable = budget - priorityFeeUsdc;
      if (spendable <= 0) {
        return Promise.resolve(
          new ExchangeError("EmulatedExchange: open budget too small after priority fee"),
        );
      }
      return Promise.resolve({
        pair: command.pair,
        type: "market",
        intent: command.intent,
        price: fillPrice,
        size: spendable / fillPrice,
        at: command.at,
        simulated: true,
        reason: command.reason,
        priorityFeeUsdc,
        fillCosts,
        ...orderPosition(command),
      });
    }

    const size = command.baseSize ?? 0;
    if (size <= 0) {
      return Promise.resolve(new ExchangeError("EmulatedExchange: close requires baseSize > 0"));
    }
    return Promise.resolve({
      pair: command.pair,
      type: "market",
      intent: command.intent,
      price: fillPrice,
      size,
      at: command.at,
      simulated: true,
      reason: command.reason,
      priorityFeeUsdc,
      fillCosts,
      ...orderPosition(command),
    });
  }
}

/** Slippage model still prices a buy and a sell differently. */
function fillSide(intent: OrderIntent): "BUY" | "SELL" {
  return intent === "open-long" || intent === "close-short" ? "BUY" : "SELL";
}

/** `strategyId` and `slPrice` carried from a command onto its fill. */
function orderPosition(command: Command): Pick<Order, "strategyId" | "slPrice"> {
  const fields: Pick<Order, "strategyId" | "slPrice"> = {};
  const strategyId = command.signal?.strategyId;
  if (strategyId !== undefined) {
    fields.strategyId = strategyId;
  }
  if (command.slPrice !== undefined) {
    fields.slPrice = command.slPrice;
  }
  return fields;
}
