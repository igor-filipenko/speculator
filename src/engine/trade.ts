import { Connection } from "@solana/web3.js";
import { assertTradeConfig, isPublicSolanaRpc, type AppConfig } from "../config.js";
import { JupiterExchange } from "../exchange/jupiter/jupiter.js";
import { LivePortfolio } from "../portfolio/live/portfolio.js";
import { loadKeypairFromFile, WalletBalances } from "../portfolio/wallet/wallet.js";
import { Telegram } from "../notify/telegram.js";
import type {
  Exchange,
  Portfolio,
  PositionSource,
  ProgramState,
  ShutdownCb,
  StrategyManager,
} from "../types.js";
import { runTradingLoop } from "./tick.js";

export interface TradeOptions {
  config: AppConfig;
  strategyManager: StrategyManager;
  exchange: Exchange;
  state: ProgramState;
  telegram: Telegram;
  once?: boolean;
  shutdownCb: ShutdownCb;
}

export interface LiveRuntime {
  portfolios: Map<string, Portfolio>;
  exchange: Exchange & PositionSource;
  walletAddress: string;
}

/** Shared wallet + exchange + live portfolios (one BalanceSource for all pairs). */
export async function createLiveRuntime(config: AppConfig): Promise<LiveRuntime> {
  assertTradeConfig(config);

  const keypair = await loadKeypairFromFile(config.walletKeypairPath);
  if (isPublicSolanaRpc(config.solanaRpcUrl)) {
    console.warn(
      "Warning: SOLANA_RPC_URL is the public mainnet endpoint; a dedicated RPC is recommended.",
    );
  }

  const connection = new Connection(config.solanaRpcUrl, {
    commitment: "confirmed",
    // Disable the default keep-alive Agent so one-shot `pnpm wallet` can exit.
    httpAgent: false,
  });
  const balances = new WalletBalances(connection, keypair.publicKey);
  const exchange = new JupiterExchange({
    apiKey: config.jupiterApiKey,
    keypair,
    balances,
    slippageBps: config.slippageBps,
    solReserve: config.liveSolReserveSol,
  });
  const portfolios = await LivePortfolio.load(config.pairs, balances, {
    solReserve: config.liveSolReserveSol,
    positions: exchange,
  });

  return {
    portfolios,
    exchange,
    walletAddress: keypair.publicKey.toBase58(),
  };
}

/**
 * Live poll loop: candles → signal → risk command → Jupiter swap → on-chain portfolio.
 */
export async function runTrade(options: TradeOptions): Promise<void> {
  await runTradingLoop({
    ...options,
    modeLabel: "trade",
  });
}
