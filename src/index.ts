import { loadConfig } from "./config.js";
import { closeSql } from "./db/db.js";
import { defaultDuckdbPath, importDuckdb } from "./db/import-duckdb.js";
import { assertMigrationsApplied } from "./db/migrate.js";
import { parseBacktestArgs, printBacktestReport, runBacktest } from "./engine/backtest.js";
import { runPaper } from "./engine/paper.js";
import { createLiveRuntime, runTrade } from "./engine/trade.js";
import { runWallet } from "./engine/wallet.js";
import { runWatch } from "./engine/watch.js";
import { Telegram } from "./notify/telegram.js";
import { PaperPortfolio } from "./paper/portfolio.js";
import { SimpleStrategyManager } from "./strategy/strategy-manager.js";
import type {
  Candle,
  MarketIndicators,
  Portfolio,
  ProgramState,
  ShutdownCb,
  Signal,
  StrategyMode,
} from "./types.js";

function usage(): never {
  console.log(`Usage:
  pnpm start          # engine from MODE in .env (watch | paper | trade)
  pnpm watch          # signal recommendations only
  pnpm paper          # recommendations + virtual portfolio
  pnpm trade          # recommendations + live Jupiter swaps
  pnpm wallet         # sync live portfolio from chain and print balances
  pnpm backtest       # Replay OHLCV with emulated Jupiter fills
  pnpm migrate        # dbmate up (TimescaleDB)
  pnpm import-duckdb  # Copy data/speculator.duckdb into TimescaleDB

  tsx src/index.ts watch|paper|trade [--once]
  tsx src/index.ts wallet
  tsx src/index.ts import-duckdb [path]
  tsx src/index.ts backtest [--days <n> | --from <date> [--to <date>]] [--strategy <name>] [--force-refresh] [--ignore-trend]

Options:
  --once            Run a single poll iteration and exit (watch/paper/trade)
  --days <n>        Backtest lookback in days (default: 90)
  --from <date>     Backtest range start (YYYY-MM-DD or DD-MM-YYYY, UTC)
  --to <date>       Backtest range end inclusive (default: now; requires --from)
  --strategy <name> Override strategy (bollinger | grid; default: env STRATEGY)
  --force-refresh   Ignore OHLCV cache and refetch from GeckoTerminal
  --ignore-trend    Skip HTF market state (do not apply or log trend)
`);
  process.exit(1);
}

const ENGINE_MODES = ["watch", "paper", "trade"] as const;
const CLI_COMMANDS = [...ENGINE_MODES, "wallet", "backtest", "import-duckdb"] as const;

type CliCommand = (typeof CLI_COMMANDS)[number];

function isCliCommand(value: string): value is CliCommand {
  return (CLI_COMMANDS as readonly string[]).includes(value);
}

function isEngineMode(value: string): value is (typeof ENGINE_MODES)[number] {
  return (ENGINE_MODES as readonly string[]).includes(value);
}

/** CLI subcommand wins; otherwise MODE from env (default paper). */
function resolveCommand(argv: string[]): { command: CliCommand; rest: string[] } {
  const first = argv[0];
  if (first !== undefined && isCliCommand(first)) {
    return { command: first, rest: argv.slice(1) };
  }
  if (first !== undefined && !first.startsWith("-")) {
    usage();
  }

  const mode = (process.env["MODE"] ?? "paper").trim();
  if (!isEngineMode(mode)) {
    console.error(`Invalid MODE "${mode}". Expected watch | paper | trade.`);
    usage();
  }
  return { command: mode, rest: argv };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, rest } = resolveCommand(argv);

  switch (command) {
    case "backtest":
      await runBacktestCommand(rest);
      return;
    case "watch":
      await runWatchCommand(rest);
      return;
    case "paper":
      await runPaperCommand(rest);
      return;
    case "trade":
      await runTradeCommand(rest);
      return;
    case "wallet":
      await runWalletCommand();
      return;
    case "import-duckdb":
      await runImportDuckdbCommand(rest);
      return;
  }
}

async function runWatchCommand(argv: string[]): Promise<void> {
  const once = argv.includes("--once");
  const config = await loadConfig();
  const strategyManager = new SimpleStrategyManager({
    strategyMode: config.strategy,
    htf: config.htf,
  });
  const strategy = strategyManager.getActiveStrategy();
  const programState: ProgramState = {
    strategy,
    lastSignals: new Map<string, Signal>(),
    lastCandles: new Map<string, Candle[]>(),
    lastMarketIndicators: new Map<string, MarketIndicators>(),
    portfolios: new Map<string, Portfolio>(),
  };

  const telegram = Telegram.start(once ? undefined : config.telegram, programState);
  const shutdownCb: ShutdownCb = once
    ? async (_reason, _exitCode) => {
        /* --once: main returns after the single tick; no process.exit */
      }
    : installLifecycleNotifiers(telegram);

  await runWatch({
    config,
    strategy,
    strategyManager,
    state: programState,
    telegram,
    once,
    shutdownCb,
  });
}

async function runPaperCommand(argv: string[]): Promise<void> {
  const once = argv.includes("--once");
  const config = await loadConfig();
  const strategyManager = new SimpleStrategyManager({
    strategyMode: config.strategy,
    htf: config.htf,
  });
  const strategy = strategyManager.getActiveStrategy();
  const portfolios: Map<string, Portfolio> = await PaperPortfolio.load(
    config.pairs,
    config.paperCashUsdc,
  );

  const programState: ProgramState = {
    strategy,
    lastSignals: new Map<string, Signal>(),
    lastCandles: new Map<string, Candle[]>(),
    lastMarketIndicators: new Map<string, MarketIndicators>(),
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
    strategyManager,
    state: programState,
    telegram,
    once,
    shutdownCb,
  });
}

async function runTradeCommand(argv: string[]): Promise<void> {
  const once = argv.includes("--once");
  const config = await loadConfig();
  const strategyManager = new SimpleStrategyManager({
    strategyMode: config.strategy,
    htf: config.htf,
  });
  const strategy = strategyManager.getActiveStrategy();
  const runtime = await createLiveRuntime(config);
  console.log(`Wallet ${runtime.walletAddress}`);

  const programState: ProgramState = {
    strategy,
    lastSignals: new Map<string, Signal>(),
    lastCandles: new Map<string, Candle[]>(),
    lastMarketIndicators: new Map<string, MarketIndicators>(),
    portfolios: runtime.portfolios,
  };

  const telegram = Telegram.start(once ? undefined : config.telegram, programState);
  const shutdownCb: ShutdownCb = once
    ? async (_reason, _exitCode) => {
        /* --once: main returns after the single tick; no process.exit */
      }
    : installLifecycleNotifiers(telegram);

  await runTrade({
    config,
    strategyManager,
    exchange: runtime.exchange,
    state: programState,
    telegram,
    once,
    shutdownCb,
  });
}

async function runWalletCommand(): Promise<void> {
  const config = await loadConfig();
  await runWallet(config);
}

async function runImportDuckdbCommand(argv: string[]): Promise<void> {
  await assertMigrationsApplied();
  const path = argv[0] && !argv[0].startsWith("-") ? argv[0] : defaultDuckdbPath();
  await importDuckdb(path);
  await closeSql();
}

const VALID_STRATEGIES: StrategyMode[] = ["bollinger", "grid"];

async function runBacktestCommand(argv: string[]): Promise<void> {
  const flags = parseBacktestArgs(argv);
  const config = await loadConfig();

  const strategyMode: StrategyMode = flags.strategy
    ? validateStrategyFlag(flags.strategy)
    : config.strategy;

  const strategyManager = new SimpleStrategyManager({
    strategyMode,
    htf: config.htf,
  });
  const results = await runBacktest({
    config,
    strategyManager,
    forceRefresh: flags.forceRefresh,
    ignoreTrend: flags.ignoreTrend,
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
