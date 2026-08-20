import { readFile } from "node:fs/promises";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

/** On-chain balances used by live portfolios and swap sizing. */
export interface BalanceSource {
  owner: PublicKey;
  refresh(mints: readonly string[]): Promise<void>;
  nativeSol(): number;
  tokenUi(mint: string): number;
}

/**
 * Load a Solana CLI JSON keypair (`[byte, byte, ...]` secret key).
 * Errors never include file contents or secret bytes.
 */
export async function loadKeypairFromFile(path: string): Promise<Keypair> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`WALLET_KEYPAIR_PATH is not readable: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("WALLET_KEYPAIR_PATH must be a Solana CLI JSON keypair file");
  }

  if (!Array.isArray(parsed) || parsed.length < 64) {
    throw new Error("WALLET_KEYPAIR_PATH must be a JSON array of 64 secret-key bytes");
  }
  if (!parsed.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error("WALLET_KEYPAIR_PATH contains invalid byte values");
  }

  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

/** RPC-backed SPL token + native SOL balances. */
export class WalletBalances implements BalanceSource {
  readonly owner: PublicKey;
  private nativeSolUi = 0;
  private readonly tokens = new Map<string, number>();

  constructor(
    private readonly connection: Connection,
    owner: PublicKey,
  ) {
    this.owner = owner;
  }

  nativeSol(): number {
    return this.nativeSolUi;
  }

  tokenUi(mint: string): number {
    return this.tokens.get(mint) ?? 0;
  }

  async refresh(mints: readonly string[]): Promise<void> {
    const lamports = await this.connection.getBalance(this.owner);
    this.nativeSolUi = lamports / 1e9;

    for (const mint of mints) {
      this.tokens.set(mint, await this.readTokenUi(mint));
    }
  }

  private async readTokenUi(mint: string): Promise<number> {
    const resp = await this.connection.getParsedTokenAccountsByOwner(this.owner, {
      mint: new PublicKey(mint),
    });
    let total = 0;
    for (const { account } of resp.value) {
      const data = account.data;
      if (!("parsed" in data)) {
        continue;
      }
      const parsed: unknown = data.parsed;
      if (typeof parsed !== "object" || parsed === null || !("info" in parsed)) {
        continue;
      }
      const info = (parsed as { info?: unknown }).info;
      if (typeof info !== "object" || info === null || !("tokenAmount" in info)) {
        continue;
      }
      const tokenAmount = (info as { tokenAmount?: unknown }).tokenAmount;
      if (typeof tokenAmount !== "object" || tokenAmount === null) {
        continue;
      }
      const ui = (tokenAmount as { uiAmount?: unknown }).uiAmount;
      if (typeof ui === "number" && Number.isFinite(ui)) {
        total += ui;
      }
    }
    return total;
  }
}
