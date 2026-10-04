import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { assertMigrationsApplied } from "./db/migrate.js";
import { getPool } from "./db/pools.js";
import { getToken } from "./db/tokens.js";
import type { HtfTimeframe, PairConfig } from "./types.js";

loadDotenv();

const envSchema = z
  .object({
    STRATEGY: z.string().trim().min(1).default("bollinger"),
    HTF: z.enum(["4h", "1d"]).default("4h"),
    JUPITER_API_KEY: z.string().optional().default(""),
    WATCHLIST: z.string().default("SOL/USDC"),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    PAPER_CASH_USDC: z.coerce.number().positive().default(1000),
    WALLET_KEYPAIR_PATH: z.string().optional().default(""),
    SOLANA_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
    SLIPPAGE_BPS: z.coerce.number().int().min(1).max(10_000).default(50),
    SOL_RESERVE_MIN: z.coerce.number().positive().default(0.03),
    SOL_RESERVE_MAX: z.coerce.number().positive().default(0.05),
    TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
    TELEGRAM_CHAT_ID: z.string().optional().default(""),
    DATABASE_URL: z.string().min(1),
    BOT_ID: z.string().min(1),
  })
  .refine((env) => env.SOL_RESERVE_MAX > env.SOL_RESERVE_MIN, {
    path: ["SOL_RESERVE_MAX"],
    message: "SOL_RESERVE_MAX must be greater than SOL_RESERVE_MIN",
  });

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface AppConfig {
  /** `strategy.registry.id` selected by `STRATEGY` or `--strategy`. */
  strategy: string;
  /** Higher-timeframe bars for StrategyManager trend / S/R (default 4h). */
  htf: HtfTimeframe;
  jupiterApiKey: string;
  watchlist: string[];
  pollIntervalMs: number;
  paperCashUsdc: number;
  pairs: PairConfig[];
  botId: string;
  /** Solana CLI JSON keypair path — required for trade mode only. */
  walletKeypairPath?: string;
  solanaRpcUrl: string;
  slippageBps: number;
  /** Refill native SOL when the balance is below this. */
  solReserveMin: number;
  /** Target native SOL after a refill. SOL below this is not sold. */
  solReserveMax: number;
  /** Present only when both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set. */
  telegram?: TelegramConfig;
}

const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

/** Throw if trade mode is missing a keypair path. */
export function assertTradeConfig(
  config: AppConfig,
): asserts config is AppConfig & { walletKeypairPath: string } {
  if (!config.walletKeypairPath) {
    throw new Error(
      "WALLET_KEYPAIR_PATH is required for trade mode (Solana CLI JSON keypair file)",
    );
  }
}

export function isPublicSolanaRpc(url: string): boolean {
  return url === DEFAULT_SOLANA_RPC;
}

async function resolvePair(symbol: string): Promise<PairConfig> {
  const normalized = symbol.trim().toUpperCase();
  const parts = normalized.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid pair "${symbol}". Expected BASE/QUOTE (e.g. SOL/USDC).`);
  }
  const [baseSymbol, quoteSymbol] = parts;

  const base = await getToken(baseSymbol);
  if (!base) {
    throw new Error(`Unknown base token "${baseSymbol}" (not in solana.tokens).`);
  }
  const quote = await getToken(quoteSymbol);
  if (!quote) {
    throw new Error(`Unknown quote token "${quoteSymbol}" (not in solana.tokens).`);
  }

  const pool = await getPool(baseSymbol, quoteSymbol);
  if (!pool) {
    throw new Error(
      `No GeckoTerminal pool for ${normalized}: add a solana.pools row for ${baseSymbol}/${quoteSymbol}.`,
    );
  }

  return {
    symbol: normalized,
    baseMint: base.mint,
    quoteMint: quote.mint,
    baseDecimals: base.decimals,
    quoteDecimals: quote.decimals,
    geckoPoolAddress: pool.address,
  };
}

export async function loadConfig(): Promise<AppConfig> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  await assertMigrationsApplied();

  const env = parsed.data;
  const watchlist = env.WATCHLIST.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (watchlist.length === 0) {
    throw new Error("WATCHLIST must contain at least one pair");
  }

  const pairs = await Promise.all(watchlist.map((symbol) => resolvePair(symbol)));

  const botToken = env.TELEGRAM_BOT_TOKEN.trim();
  const chatId = env.TELEGRAM_CHAT_ID.trim();

  const walletKeypairPath = env.WALLET_KEYPAIR_PATH.trim();

  const config: AppConfig = {
    strategy: env.STRATEGY,
    htf: env.HTF,
    jupiterApiKey: env.JUPITER_API_KEY,
    watchlist,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    paperCashUsdc: env.PAPER_CASH_USDC,
    pairs,
    botId: env.BOT_ID.trim(),
    solanaRpcUrl: env.SOLANA_RPC_URL.trim() || DEFAULT_SOLANA_RPC,
    slippageBps: env.SLIPPAGE_BPS,
    solReserveMin: env.SOL_RESERVE_MIN,
    solReserveMax: env.SOL_RESERVE_MAX,
  };

  if (walletKeypairPath) {
    config.walletKeypairPath = walletKeypairPath;
  }

  if (botToken && chatId) {
    config.telegram = { botToken, chatId };
  }

  return config;
}
