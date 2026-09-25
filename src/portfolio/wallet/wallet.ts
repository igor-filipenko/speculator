import { readFile } from "node:fs/promises";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

/** On-chain balances used by live portfolios and swap sizing. */
export interface BalanceSource {
  owner: PublicKey;
  refresh(mints: readonly string[]): Promise<void>;
  nativeSol(): number;
  tokenUi(mint: string): number;
}

/** Exported signing material from a Solana CLI JSON keypair (sensitive). */
export interface WalletSecrets {
  publicKey: string;
  /** Full 64-byte secret key as base58 — Phantom "Import Private Key". */
  privateKeyBase58: string;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bitcoin/Solana base58 encode (no checksum). */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }

  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }

  const size = Math.floor(((bytes.length - zeros) * 138) / 100) + 1;
  const encoded = new Uint8Array(size);
  let length = 0;

  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]!;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k -= 1, j += 1) {
      carry += 256 * encoded[k]!;
      encoded[k] = carry % 58;
      carry = (carry / 58) | 0;
    }
    length = j;
  }

  let start = size - length;
  while (start < size && encoded[start] === 0) {
    start += 1;
  }

  let out = "1".repeat(zeros);
  for (let i = start; i < size; i += 1) {
    out += BASE58_ALPHABET[encoded[i]!]!;
  }
  return out;
}

/**
 * Derive a Phantom-importable private key from a loaded keypair.
 * Caller must treat the return value as secret material.
 *
 * Solana CLI JSON keypairs are raw ed25519 keys, not BIP44 HD wallets, so a
 * Phantom recovery phrase cannot be reverse-engineered from the keypair file.
 */
export function exportWalletSecrets(keypair: Keypair): WalletSecrets {
  return {
    publicKey: keypair.publicKey.toBase58(),
    privateKeyBase58: encodeBase58(keypair.secretKey),
  };
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
