import { Connection } from "@solana/web3.js";
import { assertTradeConfig, isPublicSolanaRpc, type AppConfig } from "../config.js";
import { JupiterSwapExchange } from "../exchange/jupiter-swap.js";
import { loadKeypairFromFile, WalletBalances } from "../exchange/wallet.js";
import { LivePortfolio } from "../live/portfolio.js";
import { Telegram } from "../notify/telegram.js";
import type {
  Exchange,
  Portfolio,
  ProgramState,
  RiskManager,
  ShutdownCb,
  Strategy,
} from "../types.js";
import { runTradingLoop } from "./tick.js";

export interface TradeOptions {
  config: AppConfig;
  strategy: Strategy;
  riskManager: RiskManager;
  exchange: Exchange;
  state: ProgramState;
  telegram: Telegram;
  once?: boolean;
  shutdownCb: ShutdownCb;
}

export interface LiveRuntime {
  portfolios: Map<string, Portfolio>;
  exchange: JupiterSwapExchange;
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

  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const balances = new WalletBalances(connection, keypair.publicKey);
  const portfolios = await LivePortfolio.load(config.pairs, balances, {
    solReserve: config.liveSolReserveSol,
  });
  const exchange = new JupiterSwapExchange({
    apiKey: config.jupiterApiKey,
    keypair,
    balances,
    slippageBps: config.slippageBps,
    solReserve: config.liveSolReserveSol,
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
