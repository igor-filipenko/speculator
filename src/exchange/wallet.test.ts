import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { loadKeypairFromFile } from "./wallet.js";

describe("loadKeypairFromFile", () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads a Solana CLI JSON secret key and returns the matching pubkey", async () => {
    const dir = await mkdtemp(join(tmpdir(), "speculator-keypair-"));
    dirs.push(dir);
    const generated = Keypair.generate();
    const path = join(dir, "id.json");
    await writeFile(path, JSON.stringify(Array.from(generated.secretKey)));

    const loaded = await loadKeypairFromFile(path);
    assert.equal(loaded.publicKey.toBase58(), generated.publicKey.toBase58());
  });

  it("rejects a missing file without echoing contents", async () => {
    await assert.rejects(
      () => loadKeypairFromFile(join(tmpdir(), "speculator-missing-keypair.json")),
      /not readable/,
    );
  });

  it("rejects a non-array JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "speculator-keypair-"));
    dirs.push(dir);
    const path = join(dir, "bad.json");
    await writeFile(path, JSON.stringify({ not: "a keypair" }));
    await assert.rejects(() => loadKeypairFromFile(path), /JSON array of 64 secret-key bytes/);
  });
});
