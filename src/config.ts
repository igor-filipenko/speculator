import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { getToken } from "./db/tokens.js";
import type { PairConfig, RunMode, StrategyMode, StrategyParams } from "./types.js";

loadDotenv();

const envSchema = z.object({
  MODE: z.enum(["signal", "paper"]).default("signal"),
  STRATEGY: z.enum(["intraday", "swing"]).default("intraday"),
  JUPITER_API_KEY: z.string().optional().default(""),
  WATCHLIST: z.string().default("SOL/USDC"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  PAPER_CASH_USDC: z.coerce.number().positive().default(1000),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
});

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface AppConfig {
  mode: RunMode;
  strategy: StrategyMode;
  jupiterApiKey: string;
  watchlist: string[];
  pollIntervalMs: number;
  paperCashUsdc: number;
  pairs: PairConfig[];
  /** Present only when both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set. */
  telegram?: TelegramConfig;
}

async function resolvePair(symbol: string, dataDir?: string): Promise<PairConfig> {
  const normalized = symbol.trim().toUpperCase();
  const parts = normalized.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid pair "${symbol}". Expected BASE/QUOTE (e.g. SOL/USDC).`);
  }
  const [baseSymbol, quoteSymbol] = parts;

  const base = await getToken(baseSymbol, dataDir);
  if (!base) {
    throw new Error(`Unknown base token "${baseSymbol}" (not in solana.tokens).`);
  }
  const quote = await getToken(quoteSymbol, dataDir);
  if (!quote) {
    throw new Error(`Unknown quote token "${quoteSymbol}" (not in solana.tokens).`);
  }

  if (!base.poolAddress) {
    throw new Error(
      `No GeckoTerminal pool for ${normalized}: set pool_address on solana.tokens.${baseSymbol}.`,
    );
  }

  return {
    symbol: normalized,
    baseMint: base.mint,
    quoteMint: quote.mint,
    baseDecimals: base.decimals,
    quoteDecimals: quote.decimals,
    geckoPoolAddress: base.poolAddress,
  };
}

export async function loadConfig(overrides?: {
  mode?: RunMode;
  dataDir?: string;
}): Promise<AppConfig> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  const env = parsed.data;
  const watchlist = env.WATCHLIST.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (watchlist.length === 0) {
    throw new Error("WATCHLIST must contain at least one pair");
  }

  const pairs = await Promise.all(
    watchlist.map((symbol) => resolvePair(symbol, overrides?.dataDir)),
  );

  const botToken = env.TELEGRAM_BOT_TOKEN.trim();
  const chatId = env.TELEGRAM_CHAT_ID.trim();

  const config: AppConfig = {
    mode: overrides?.mode ?? env.MODE,
    strategy: env.STRATEGY,
    jupiterApiKey: env.JUPITER_API_KEY,
    watchlist,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    paperCashUsdc: env.PAPER_CASH_USDC,
    pairs,
  };

  if (botToken && chatId) {
    config.telegram = { botToken, chatId };
  }

  return config;
}

export function strategyParams(mode: StrategyMode): StrategyParams {
  if (mode === "swing") {
    return {
      mode: "swing",
      timeframe: "4h",
      emaFast: 12,
      emaSlow: 26,
      rsiPeriod: 14,
      rsiBuyMax: 70,
      rsiSellMin: 30,
    };
  }

  return {
    mode: "intraday",
    timeframe: "15m",
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    rsiBuyMax: 70,
    rsiSellMin: 30,
  };
}
