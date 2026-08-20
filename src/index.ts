import { loadConfig } from "./config.js";
import { defaultDataDir, getSpeculatorDb } from "./db/db.js";
import { parseBacktestArgs, printBacktestReport, runBacktest } from "./engine/backtest.js";
import { runPaper } from "./engine/paper.js";
import { runWatch } from "./engine/watch.js";
import { Telegram } from "./notify/telegram.js";
import { PaperPortfolio } from "./paper/portfolio.js";
import { SimpleRiskManager } from "./risk/risk-manager.js";
import { loadStrategy } from "./strategy/strategy.js";
import type { Candle, Portfolio, ProgramState, ShutdownCb, Signal, StrategyMode } from "./types.js";

function usage(): never {
  console.log(`Usage:
  pnpm watch      # signal recommendations only
  pnpm paper      # recommendations + virtual portfolio
  pnpm backtest   # Replay OHLCV with emulated Jupiter fills
  pnpm database   # Start DuckDB Quack server (requires DUCKDB_MODE=server in .env)

  tsx src/index.ts watch|paper [--once]
  tsx src/index.ts backtest [--days <n> | --from <date> [--to <date>]] [--strategy <name>] [--force-refresh]

Options:
  --once            Run a single poll iteration and exit (watch/paper)
  --days <n>        Backtest lookback in days (default: 90)
  --from <date>     Backtest range start (YYYY-MM-DD or DD-MM-YYYY, UTC)
  --to <date>       Backtest range end inclusive (default: now; requires --from)
  --strategy <name> Override strategy (ema-rsi | bollinger | grid; default: env STRATEGY)
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
    case "database":
      await runDatabaseCommand();
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
  const risk = new SimpleRiskManager(strategy.getRiskParams());
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

  await runPaper({
    config,
    strategy,
    risk,
    state: programState,
    telegram,
    once,
    shutdownCb,
  });
}

async function runDatabaseCommand(): Promise<void> {
  const mode = process.env["DUCKDB_MODE"];
  if (mode !== "server") {
    console.error(
      `pnpm database requires DUCKDB_MODE=server (current: ${mode ?? "standalone (default)"}). Set it in .env and restart.`,
    );
    process.exit(1);
  }

  const url = process.env["DUCKDB_URL"] ?? "quack:localhost";
  const conn = await getSpeculatorDb(defaultDataDir());

  let stopping = false;
  const keepalive = setInterval(() => {
    // keeps Node.js event loop alive while quack serves requests
  }, 2_147_483_647);

  const stop = async (reason: string, code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepalive);
    try {
      await conn.run(`CALL quack_stop('${url}')`);
    } catch {
      // ignore: quack may already be stopped
    }
    console.log(`[database] Stopped (${reason})`);
    process.exit(code);
  };

  process.once("SIGINT", () => void stop("SIGINT", 130));
  process.once("SIGTERM", () => void stop("SIGTERM", 0));
}

const VALID_STRATEGIES: StrategyMode[] = ["ema-rsi", "bollinger", "grid"];

async function runBacktestCommand(argv: string[]): Promise<void> {
  const flags = parseBacktestArgs(argv);
  const config = await loadConfig();

  const strategyMode: StrategyMode = flags.strategy
    ? validateStrategyFlag(flags.strategy)
    : config.strategy;

  const strategy = loadStrategy(strategyMode);
  const risk = new SimpleRiskManager(strategy.getRiskParams());
  const results = await runBacktest({
    config,
    strategy,
    risk,
    forceRefresh: flags.forceRefresh,
    ...(flags.days > 0 ? { days: flags.days } : {}),
    ...(flags.fromTime !== undefined ? { fromTime: flags.fromTime } : {}),
    ...(flags.toTime !== undefined ? { toTime: flags.toTime } : {}),
  });

  for (const result of results) {
    await printBacktestReport(result);
  }
}

function validateStrategyFlag(value: string): StrategyMode {
  if (VALID_STRATEGIES.includes(value as StrategyMode)) {
    return value as StrategyMode;
  }
  throw new Error(`Invalid --strategy "${value}". Valid options: ${VALID_STRATEGIES.join(", ")}`);
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
