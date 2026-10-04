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
 */
export class EmulatedExchange implements Exchange {
  private mid = 0;

  setMidPrice(mid: number): void {
    this.mid = mid;
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
    const emulated = emulateFillPrice({
      side: fillSide(command.intent),
      close: this.mid,
      tier,
      ...(perps ? { venue: "perps" as const } : {}),
    });
    const { fillPrice, priorityFeeUsdc, breakdown } = emulated;

    const fillCosts = {
      mid: breakdown.mid,
      slippageUsdcPerBase: breakdown.slippageUsdcPerBase,
      poolFeeUsdcPerBase: breakdown.poolFeeUsdcPerBase,
      ...(breakdown.perps != null ? { perps: breakdown.perps } : {}),
    };

    const opens = command.intent === "open-long" || command.intent === "open-short";
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
    });
  }
}

/** Slippage model still prices a buy and a sell differently. */
function fillSide(intent: OrderIntent): "BUY" | "SELL" {
  return intent === "open-long" || intent === "close-short" ? "BUY" : "SELL";
}
