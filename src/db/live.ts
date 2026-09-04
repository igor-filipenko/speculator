import type { PersistedLivePortfolio, PersistedLiveTrade } from "../live/store.js";
import { insertTrade, loadAllPortfolios, portfolioCount, upsertPortfolio } from "./bot.js";
import { getBotId } from "./db.js";

export async function livePortfolioCount(): Promise<number> {
  return portfolioCount(getBotId(), "live");
}

export async function loadAllLivePortfolios(): Promise<Record<string, PersistedLivePortfolio>> {
  return loadAllPortfolios(getBotId(), "live");
}

export async function upsertLivePortfolio(portfolio: PersistedLivePortfolio): Promise<void> {
  await upsertPortfolio(getBotId(), "live", portfolio);
}

export async function insertLiveTrade(trade: PersistedLiveTrade): Promise<void> {
  await insertTrade(getBotId(), "live", trade);
}

export async function loadLiveState(): Promise<{
  portfolios: Record<string, PersistedLivePortfolio>;
} | null> {
  const count = await livePortfolioCount();
  if (count === 0) {
    return null;
  }
  const portfolios = await loadAllLivePortfolios();
  if (Object.keys(portfolios).length === 0) {
    return null;
  }
  return { portfolios };
}
