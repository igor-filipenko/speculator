import type { PersistedPortfolio, PersistedTrade } from "../paper/store.js";
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

export async function upsertPaperPortfolio(portfolio: PersistedPortfolio): Promise<void> {
  await upsert(portfolio);
}

export async function insertPaperTrade(trade: PersistedTrade): Promise<void> {
  await insert(trade);
}

export async function syncPaperPortfolio(portfolio: PersistedPortfolio): Promise<void> {
  await sync(portfolio);
}
