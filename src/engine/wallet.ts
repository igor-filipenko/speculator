import { assertTradeConfig, type AppConfig } from "../config.js";
import { logOrder, logPortfolio } from "../notify/console.js";
import { exportWalletSecrets, loadKeypairFromFile } from "../portfolio/wallet/wallet.js";
import { isOrder, type PairConfig, type Portfolio, type PortfolioSnapshot } from "../types.js";
import { createLiveRuntime, type LiveRuntime } from "./trade.js";

export interface WalletOptions {
  /** Buy SOL up to SOL_RESERVE_MAX when native SOL is below SOL_RESERVE_MIN. */
  buySol?: boolean;
}

/**
 * One-shot live wallet report: sync each watchlist pair from chain and print a
 * `/portfolio`-style snapshot. `--buy-sol` tops up the fee reserve first.
 */
export async function runWallet(config: AppConfig, options: WalletOptions = {}): Promise<void> {
  const runtime = await createLiveRuntime(config);
  console.log(`Wallet ${runtime.walletAddress}`);

  if (options.buySol) {
    await buySolReserve(runtime, config.pairs[0]);
  }

  console.log("Portfolio");

  if (runtime.portfolios.size === 0) {
    console.log("No portfolio loaded.");
    return;
  }

  let warned = false;
  for (const pair of config.pairs) {
    const portfolio = runtime.portfolios.get(pair.symbol);
    if (!portfolio) {
      console.error(`[${pair.symbol}] portfolio not found`);
      continue;
    }

    const { snapshot } = await syncedSnapshot(runtime, portfolio, pair);
    logPortfolio(pair.symbol, snapshot);
    if (!warned && snapshot.insufficientSol > 0) {
      warned = true;
      console.warn(
        `Warning: native SOL ${snapshot.nativeSol.toFixed(6)} is below SOL_RESERVE_MIN. ` +
          `Short ${snapshot.insufficientSol.toFixed(6)} SOL. Run: pnpm wallet --buy-sol`,
      );
    }
  }
}

/**
 * Swap quote into SOL so native balance reaches SOL_RESERVE_MAX.
 * Uses the first WATCHLIST pair's quote mint.
 */
async function buySolReserve(runtime: LiveRuntime, pair: PairConfig | undefined): Promise<void> {
  if (pair === undefined) {
    throw new Error("WATCHLIST is empty");
  }
  const portfolio = runtime.portfolios.get(pair.symbol);
  if (portfolio === undefined) {
    throw new Error(`no portfolio for ${pair.symbol}`);
  }

  const { snapshot, markPrice } = await syncedSnapshot(runtime, portfolio, pair);
  console.log(`Native SOL ${snapshot.nativeSol.toFixed(6)}`);
  if (!(snapshot.insufficientSol > 0)) {
    console.log("SOL reserve is sufficient.");
    return;
  }

  const order = await runtime.exchange.execute(
    {
      pair: pair.symbol,
      intent: "buy-sol",
      orderType: "market",
      reason: "wallet --buy-sol",
      at: new Date(),
      priceHint: markPrice,
      baseSize: snapshot.insufficientSol,
    },
    pair,
  );
  if (!isOrder(order)) {
    throw new Error(order.message);
  }
  await portfolio.applyOrder(order);
  logOrder(order);
}

async function syncedSnapshot(
  runtime: LiveRuntime,
  portfolio: Portfolio,
  pair: PairConfig,
): Promise<{ snapshot: PortfolioSnapshot; markPrice: number }> {
  const markPrice = await runtime.exchange.spotPrice(pair);
  await portfolio.syncFromChain(markPrice);
  return { snapshot: portfolio.getSnapshot(markPrice), markPrice };
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
