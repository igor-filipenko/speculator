import { Bot } from "grammy";
import type { TelegramConfig } from "../config.js";
import type { Signal } from "../types.js";
import type { PaperTrade } from "../paper/portfolio.js";

/** One Bot per process — avoid constructing on every tick. */
let bot: Bot | undefined;
let botToken: string | undefined;

function getBot(token: string): Bot {
  if (!bot || botToken !== token) {
    bot = new Bot(token);
    botToken = token;
  }
  return bot;
}

/** Send a plain-text Telegram message via grammY (outbound only; no polling). */
export async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
): Promise<void> {
  try {
    await getBot(config.botToken).api.sendMessage(config.chatId, text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Telegram send failed: ${message}`, { cause: err });
  }
}

export function formatSignalMessage(signal: Signal): string {
  const ts = signal.at.toISOString();
  const meta = signal.meta
    ? ` emaFast=${fmt(signal.meta.emaFast)} emaSlow=${fmt(signal.meta.emaSlow)} rsi=${fmt(signal.meta.rsi)}`
    : "";
  return `[${ts}] ${signal.pair} ${signal.side} @ ${signal.price.toFixed(6)} — ${signal.reason}${meta}`;
}

export function formatPaperTradeMessage(trade: PaperTrade): string {
  const pnl =
    trade.realizedPnl != null
      ? ` realizedPnl=${trade.realizedPnl.toFixed(4)} USDC`
      : "";
  return `PAPER ${trade.side} ${trade.pair} size=${trade.size.toFixed(6)} @ ${trade.price.toFixed(6)} (simulated)${pnl}`;
}

function fmt(n: number | undefined): string {
  return n == null ? "n/a" : n.toFixed(4);
}
