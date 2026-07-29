import { loadConfig } from "./config.js";
import { runWatch } from "./engine/watch.js";
import type { RunMode } from "./types.js";

function usage(): never {
  console.log(`Usage:
  pnpm watch   # MODE=signal (or override via CLI)
  pnpm paper   # MODE=paper

  tsx src/index.ts watch|paper [--once]

Options:
  --once   Run a single poll iteration and exit
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const once = argv.includes("--once");

  if (command !== "watch" && command !== "paper") {
    usage();
  }

  const mode: RunMode = command === "paper" ? "paper" : "signal";
  const config = loadConfig({ mode });

  await runWatch({ config, once });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
