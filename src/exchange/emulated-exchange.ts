import type { Command, Exchange, Order, PairConfig } from "../types.js";
import { emulateFillPrice, liquidityTierForPair } from "./emulated-quote.js";

/**
 * Offline exchange: fills from candle mid + Jupiter-like fee/slippage model.
 * Call {@link setMidPrice} before each bar's spotPrice/execute.
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

  execute(command: Command, pair: PairConfig): Promise<Order> {
    if (!(this.mid > 0)) {
      return Promise.reject(new Error("EmulatedExchange: mid price not set"));
    }

    const tier = liquidityTierForPair(pair.symbol);
    const emulated = emulateFillPrice({ side: command.side, close: this.mid, tier });
    const { fillPrice, priorityFeeUsdc, breakdown } = emulated;

    const fillCosts = {
      mid: breakdown.mid,
      slippageUsdcPerBase: breakdown.slippageUsdcPerBase,
      poolFeeUsdcPerBase: breakdown.poolFeeUsdcPerBase,
    };

    if (command.side === "BUY") {
      const budget = command.quoteBudgetUsdc ?? 0;
      const spendable = budget - priorityFeeUsdc;
      if (spendable <= 0) {
        return Promise.reject(
          new Error("EmulatedExchange: BUY budget too small after priority fee"),
        );
      }
      return Promise.resolve({
        pair: command.pair,
        side: "BUY",
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
      return Promise.reject(new Error("EmulatedExchange: SELL requires baseSize > 0"));
    }
    return Promise.resolve({
      pair: command.pair,
      side: "SELL",
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
