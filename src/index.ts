import { loadConfig } from "./config.js";
import { parseBacktestArgs, printBacktestReport, runBacktest } from "./engine/backtest.js";
import { runPaper } from "./engine/paper.js";
import { runWatch } from "./engine/watch.js";
import { Telegram } from "./notify/telegram.js";
import { PaperPortfolio } from "./paper/portfolio.js";
import { loadStrategy } from "./strategy/strategy.js";
import type { Candle, Portfolio, ProgramState, ShutdownCb, Signal } from "./types.js";

function usage(): never {
  console.log(`Usage:
  pnpm watch     # signal recommendations only
  pnpm paper     # recommendations + virtual portfolio
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

  switch (command) {
    case "backtest":
      await runBacktestCommand(argv.slice(1));
      return;
    case "watch":
      await runWatchCommand(argv.slice(1));
      return;
    case "paper":
      await runPaperCommand(argv.slice(1));
      return;
    default:
      usage();
  }
}

async function runWatchCommand(argv: string[]): Promise<void> {
  const once = argv.includes("--once");
  const config = await loadConfig();
  const strategy = loadStrategy(config.strategy);
  const programState: ProgramState = {
    strategy,
    lastSignals: new Map<string, Signal>(),
    lastCandles: new Map<string, Candle[]>(),
    portfolios: new Map<string, Portfolio>(),
  };

  const telegram = Telegram.start(once ? undefined : config.telegram, programState);
  const shutdownCb: ShutdownCb = once
    ? async (_reason, _exitCode) => {
        /* --once: main returns after the single tick; no process.exit */
      }
    : installLifecycleNotifiers(telegram);

  await runWatch({ config, strategy, state: programState, telegram, once, shutdownCb });
}

async function runPaperCommand(argv: string[]): Promise<void> {
  const once = argv.includes("--once");
  const config = await loadConfig();
  const strategy = loadStrategy(config.strategy);
  const portfolios: Map<string, Portfolio> = await PaperPortfolio.load(
    config.pairs,
    config.paperCashUsdc,
  );

  const programState: ProgramState = {
    strategy,
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

  await runPaper({ config, strategy, state: programState, telegram, once, shutdownCb });
}

async function runBacktestCommand(argv: string[]): Promise<void> {
  const flags = parseBacktestArgs(argv);
  const config = await loadConfig();
  const strategy = loadStrategy(config.strategy);
  const results = await runBacktest({
    config,
    strategy,
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
