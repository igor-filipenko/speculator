import type { AppConfig } from "../config.js";
import { logPortfolio } from "../notify/console.js";
import { createLiveRuntime } from "./trade.js";

/**
 * One-shot live wallet report: sync each watchlist pair from chain and print a
 * `/portfolio`-style snapshot.
 */
export async function runWallet(config: AppConfig): Promise<void> {
  const runtime = await createLiveRuntime(config);
  console.log(`Wallet ${runtime.walletAddress}`);
  console.log("Portfolio");

  if (runtime.portfolios.size === 0) {
    console.log("No portfolio loaded.");
    return;
  }

  for (const pair of config.pairs) {
    const portfolio = runtime.portfolios.get(pair.symbol);
    if (!portfolio) {
      console.error(`[${pair.symbol}] portfolio not found`);
      continue;
    }

    const markPrice = await runtime.exchange.spotPrice(pair);
    await portfolio.syncFromChain(markPrice);
    logPortfolio(pair.symbol, portfolio.getSnapshot(markPrice));
  }
}
