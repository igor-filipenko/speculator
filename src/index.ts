import { loadConfig, strategyParams } from "./config.js";
import { parseBacktestArgs, printBacktestReport, runBacktest } from "./engine/backtest.js";
import { runWatch } from "./engine/watch.js";
import { Telegram } from "./notify/telegram.js";
import { PaperPortfolio } from "./paper/portfolio.js";
import type { Candle, Portfolio, ProgramState, RunMode, ShutdownCb, Signal } from "./types.js";

function usage(): never {
  console.log(`Usage:
  pnpm watch     # MODE=signal (or override via CLI)
  pnpm paper     # MODE=paper
  pnpm backtest  # Replay OHLCV with emulated Jupiter fills

  tsx src/index.ts watch|paper [--once]
  tsx src/index.ts backtest [--days <n> | --from <date> [--to <date>]] [--force-refresh]

Options:
  --once            Run a single poll iteration and exit (watch/paper)
  --days <n>        Backtest lookback in days (default: 30 intraday / 90 swing)
  --from <date>     Backtest range start (YYYY-MM-DD or DD-MM-YYYY, UTC)
  --to <date>       Backtest range end inclusive (default: now; requires --from)
  --force-refresh   Ignore OHLCV disk cache and refetch from GeckoTerminal
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "backtest") {
    await runBacktestCommand(argv.slice(1));
    return;
  }

  const once = argv.includes("--once");

  if (command !== "watch" && command !== "paper") {
    usage();
  }

  const mode: RunMode = command === "paper" ? "paper" : "signal";
  const config = await loadConfig({ mode });

  const portfolios: Map<string, Portfolio> =
    mode === "paper"
      ? await PaperPortfolio.load(config.pairs, config.paperCashUsdc)
      : new Map<string, Portfolio>();

  const programState: ProgramState = {
    mode: config.mode,
    strategy: strategyParams(config.strategy),
    lastSignals: new Map<string, Signal>(),
    lastCandles: new Map<string, Candle[]>(),
    portfolios,
  };

  const telegram = Telegram.start(once ? undefined : config.telegram, programState);
  const shutdownCb: ShutdownCb = once
    ? async (_reason, _exitCode) => {
        /* --once: main returns after the single tick; no process.exit */
      }
    : installLifecycleNotifiers(telegram);

  await runWatch({ config, state: programState, telegram, once, shutdownCb });
}

async function runBacktestCommand(argv: string[]): Promise<void> {
  const flags = parseBacktestArgs(argv);
  const config = await loadConfig({ mode: "signal" });
  const results = await runBacktest({
    config,
    forceRefresh: flags.forceRefresh,
    ...(flags.days > 0 ? { days: flags.days } : {}),
    ...(flags.fromTime !== undefined ? { fromTime: flags.fromTime } : {}),
    ...(flags.toTime !== undefined ? { toTime: flags.toTime } : {}),
  });

  for (const result of results) {
    printBacktestReport(result);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});

/**
 * Notify Telegram on SIGINT/SIGTERM and uncaught crashes, then exit.
 * Returns a callable used for orderly stops (e.g. --once) and fatal errors inside runWatch.
 */
function installLifecycleNotifiers(telegram: Telegram): ShutdownCb {
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    try {
      await telegram.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram command polling stop failed: ${message}`);
    }

    console.log(`Stopped (${reason})`);
    await telegram.notify({
      type: "shutdown",
      code: exitCode,
      reason,
    });

    // Allow a clean exit after --once without forcing process.exit (lets main resolve).
    if (reason === "once complete") {
      return;
    }
    process.exit(exitCode);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT", 130);
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });
  process.once("uncaughtException", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    void shutdown(`crash: ${message}`, 1);
  });
  process.once("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    void shutdown(`crash: ${message}`, 1);
  });

  return shutdown;
}
