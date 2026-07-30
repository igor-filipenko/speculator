import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { PairConfig, RunMode, StrategyMode } from "./types.js";

loadDotenv();

/** Well-known SOL/USDC Raydium pool on GeckoTerminal (Solana). */
export const DEFAULT_SOL_USDC_POOL =
  "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const envSchema = z.object({
  MODE: z.enum(["signal", "paper"]).default("signal"),
  STRATEGY: z.enum(["intraday", "swing"]).default("intraday"),
  JUPITER_API_KEY: z.string().optional().default(""),
  WATCHLIST: z.string().default("SOL/USDC"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  PAPER_CASH_USDC: z.coerce.number().positive().default(1000),
  GECKO_POOL_ADDRESS: z.string().optional().default(""),
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

function resolvePair(symbol: string, geckoPoolOverride: string): PairConfig {
  const normalized = symbol.trim().toUpperCase();
  if (normalized !== "SOL/USDC") {
    throw new Error(
      `Unsupported pair "${symbol}". v1 only supports SOL/USDC.`,
    );
  }

  return {
    symbol: "SOL/USDC",
    baseMint: SOL_MINT,
    quoteMint: USDC_MINT,
    baseDecimals: 9,
    quoteDecimals: 6,
    geckoPoolAddress: geckoPoolOverride || DEFAULT_SOL_USDC_POOL,
  };
}

export function loadConfig(overrides?: { mode?: RunMode }): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  const env = parsed.data;
  const watchlist = env.WATCHLIST.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (watchlist.length === 0) {
    throw new Error("WATCHLIST must contain at least one pair");
  }

  const pairs = watchlist.map((symbol) =>
    resolvePair(symbol, env.GECKO_POOL_ADDRESS),
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

export interface StrategyParams {
  timeframe: "15m" | "4h";
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiBuyMax: number;
  rsiSellMin: number;
}

export function strategyParams(mode: StrategyMode): StrategyParams {
  if (mode === "swing") {
    return {
      timeframe: "4h",
      emaFast: 12,
      emaSlow: 26,
      rsiPeriod: 14,
      rsiBuyMax: 70,
      rsiSellMin: 30,
    };
  }

  return {
    timeframe: "15m",
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    rsiBuyMax: 70,
    rsiSellMin: 30,
  };
}
