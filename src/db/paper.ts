import type { PersistedPortfolio, PersistedTrade } from "../portfolio/paper/store.js";
import {
  insertPaperTrade as insert,
  loadAllPaperPortfolios as loadAll,
  paperPortfolioCount as count,
  syncPaperPortfolio as sync,
  upsertPaperPortfolio as upsert,
} from "./bot.js";

export async function paperPortfolioCount(): Promise<number> {
  return count();
}

export async function loadAllPaperPortfolios(): Promise<Record<string, PersistedPortfolio>> {
  return loadAll();
}

export async function upsertPaperPortfolio(portfolio: PersistedPortfolio): Promise<string | null> {
  return upsert(portfolio);
}

export async function insertPaperTrade(
  trade: PersistedTrade,
  instanceId: string | null,
): Promise<void> {
  await insert(trade, instanceId);
}

export async function syncPaperPortfolio(portfolio: PersistedPortfolio): Promise<string | null> {
  return sync(portfolio);
}
