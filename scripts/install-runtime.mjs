#!/usr/bin/env node
/**
 * Install runtime files into a target directory (e.g. /opt/speculator).
 *
 * Usage (from repo root, after `pnpm build`):
 *   node scripts/install-runtime.mjs /opt/speculator
 *   pnpm install-runtime /opt/speculator
 *
 * Copies dist/, package.json, pnpm-lock.yaml, .env.example.
 * Preserves existing .env and signals.jsonl.
 * Runs `pnpm install --prod` in the target.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const rawArgs = process.argv.slice(2).filter((a) => a !== "--");
const targetArg = rawArgs[0] ?? "/opt/speculator";
const target = resolve(targetArg);

const distSrc = join(repoRoot, "dist");
const pkgSrc = join(repoRoot, "package.json");
const lockSrc = join(repoRoot, "pnpm-lock.yaml");
const envExampleSrc = join(repoRoot, ".env.example");

if (!existsSync(distSrc)) {
  console.error("Missing dist/. Run `pnpm build` first.");
  process.exit(1);
}
if (!existsSync(pkgSrc) || !existsSync(lockSrc)) {
  console.error("Missing package.json or pnpm-lock.yaml in repo root.");
  process.exit(1);
}

mkdirSync(target, { recursive: true });

const distDest = join(target, "dist");
rmSync(distDest, { recursive: true, force: true });
cpSync(distSrc, distDest, { recursive: true });
copyFileSync(pkgSrc, join(target, "package.json"));
copyFileSync(lockSrc, join(target, "pnpm-lock.yaml"));

if (existsSync(envExampleSrc)) {
  copyFileSync(envExampleSrc, join(target, ".env.example"));
}

const envDest = join(target, ".env");
if (!existsSync(envDest) && existsSync(envExampleSrc)) {
  copyFileSync(envExampleSrc, envDest);
  try {
    chmodSync(envDest, 0o600);
  } catch {
    // ignore chmod failures on exotic FS
  }
  console.log(`Created ${envDest} from .env.example — edit secrets before starting.`);
} else {
  console.log(`Preserved existing ${envDest}`);
}

console.log(`Installing production dependencies in ${target} ...`);
const install = spawnSync(
  "pnpm",
  ["install", "--prod", "--dir", target],
  { stdio: "inherit", shell: false },
);

if (install.status !== 0) {
  console.error("pnpm install --prod failed");
  process.exit(install.status ?? 1);
}

console.log(`Runtime installed at ${target}`);
console.log(`Run: node ${join(target, "dist/index.js")} paper`);
