import { ExchangeError } from "../error.js";
import type { Command, Error, Exchange, Order, PairConfig } from "../../types.js";
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

  spotPrice(_pair: PairConfig): Promise<number> {
    if (!(this.mid > 0)) {
      return Promise.reject(new Error("EmulatedExchange: mid price not set"));
    }
    return Promise.resolve(this.mid);
  }

  execute(command: Command, pair: PairConfig): Promise<Order | Error> {
    if (!(this.mid > 0)) {
      return Promise.resolve(new ExchangeError("EmulatedExchange: mid price not set"));
    }

    const tier = liquidityTierForPair(pair.symbol);
    const emulated = emulateFillPrice({ side: command.side, close: this.mid, tier });
    const { fillPrice, priorityFeeUsdc, breakdown } = emulated;

    const fillCosts = {
      mid: breakdown.mid,
      slippageUsdcPerBase: breakdown.slippageUsdcPerBase,
      poolFeeUsdcPerBase: breakdown.poolFeeUsdcPerBase,
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
        side: command.side,
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
      side: command.side,
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
