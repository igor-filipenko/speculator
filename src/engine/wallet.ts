import { assertTradeConfig, type AppConfig } from "../config.js";
import { exportWalletSecrets, loadKeypairFromFile } from "../exchange/wallet.js";
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

/**
 * Print Phantom-importable private key for WALLET_KEYPAIR_PATH.
 * Secrets are written only to stdout for this intentional export command.
 *
 * A Phantom BIP44 seed phrase cannot be derived from a Solana CLI keypair JSON.
 */
export async function runWalletExport(config: AppConfig): Promise<void> {
  assertTradeConfig(config);
  const keypair = await loadKeypairFromFile(config.walletKeypairPath);
  const secrets = exportWalletSecrets(keypair);

  console.error("WARNING: private key grants full control of this wallet.");
  console.error("Do not share, commit, screenshot, or paste it into chat/logs.");
  console.error(
    "Import in Phantom via Import Private Key. A seed phrase cannot be recovered from a CLI keypair.",
  );
  console.log(`Public key:  ${secrets.publicKey}`);
  console.log(`Private key: ${secrets.privateKeyBase58}`);
}
