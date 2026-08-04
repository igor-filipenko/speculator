import { Bot, type Context, InputFile } from "grammy";
import { match } from "ts-pattern";
import type { TelegramConfig } from "../config.js";
import { renderOhlcvPng } from "../chart/render-png.js";
import type { Portfolio, ProgramState, RunMode, Signal, Trade } from "../types.js";

/** Tagged payloads for outbound Telegram notifications. */
type TelegramInfo =
  | { type: "start" }
  | { type: "shutdown"; code: number; reason?: string }
  | { type: "signal"; signal: Signal }
  | { type: "trade"; trade: Trade };


export class Telegram {
  private readonly config: TelegramConfig | undefined;
  private readonly onStop: () => Promise<void>;

  private constructor(
    config: TelegramConfig | undefined,
    onStop: () => Promise<void>,
  ) {
    this.config = config;
    this.onStop = onStop;
  }

  static start(config: TelegramConfig | undefined, state: ProgramState): Telegram {
    const onStop = startTelegramCommands(config, state);
    return new Telegram(config, onStop);
  }

  async notify(info: TelegramInfo): Promise<boolean> {
    return notifyTelegram(this.config, info);
  }

  async stop(): Promise<void> {
    await this.onStop();
  }
}

/** One Bot per process — avoid constructing on every tick. */
let bot: Bot | undefined;
let botToken: string | undefined;
let commandsStarted = false;

function getBot(token: string): Bot {
  if (!bot || botToken !== token) {
    bot = new Bot(token);
    botToken = token;
    commandsStarted = false;
  }
  return bot;
}

/**
 * Format and send a Telegram notification. No-ops when config is missing.
 * Returns false if the send failed (caller may treat start failure as fatal).
 */
async function notifyTelegram(
  config: TelegramConfig | undefined,
  info: TelegramInfo,
): Promise<boolean> {
  if (!config) {
    return true;
  }

  try {
    const text = match(info)
      .with({ type: "start" }, () => formatStartMessage())
      .with({ type: "shutdown" }, (shutdown) => formatShutdownMessage(shutdown))
      .with({ type: "signal", signal: { side: "HOLD" } }, () => null)
      .with({ type: "signal" }, ({ signal }) => formatSignalMessage(signal))
      .with({ type: "trade" }, ({ trade }) => formatTradeMessage(trade),
      )
      .exhaustive();

    if (text == null) {
      // skip hold
      return true;
    }

    await sendTelegramMessage(config, text);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Telegram notify failed: ${message}`);
    return false;
  }
}

/** Send a plain-text Telegram message via grammY. */
async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
): Promise<void> {
  try {
    await getBot(config.botToken).api.sendMessage(config.chatId, text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Telegram send failed: ${message}`, { cause: err });
  }
}

function formatSignalMessage(signal: Signal): string {
  const ts = signal.at.toISOString();
  const meta = signal.meta
    ? ` emaFast=${fmt(signal.meta.emaFast)} emaSlow=${fmt(signal.meta.emaSlow)} rsi=${fmt(signal.meta.rsi)}`
    : "";
  return `[${ts}] ${signal.pair} ${signal.side} @ ${signal.price.toFixed(6)} — ${signal.reason}${meta}`;
}

function formatTradeMessage(trade: Trade): string {
  const pnl =
    trade.realizedPnl != null
      ? ` realizedPnl=${trade.realizedPnl.toFixed(4)} USDC`
      : "";
  return `PAPER ${trade.side} ${trade.pair} size=${trade.size.toFixed(6)} @ ${trade.price.toFixed(6)} (simulated)${pnl}`;
}

function formatStartMessage(): string {
  return [
    "Speculator bot is running.",
    "",
    "Commands:",
    "/start — this help",
    "/report — last signal per pair + candle chart (EMA/RSI)",
    "/portfolio — current paper portfolio",
  ].join("\n");
}

function formatShutdownMessage(shutdown: {
  code: number;
  reason?: string;
}): string {
  return shutdown.reason != null
    ? `Stopped (${shutdown.reason}) code=${shutdown.code}`
    : `Shutdown with code ${shutdown.code}.`;
}

function formatReportMessage(lastSignals: Map<string, Signal>): string {
  if (lastSignals.size === 0) {
    return "No signal yet. Wait for the next poll tick.";
  }
  return [...lastSignals.values()].map(formatSignalMessage).join("\n");
}

function formatPortfolioMessage(
  mode: RunMode,
  portfolios: Map<string, Portfolio>,
  lastSignals: Map<string, Signal>,
): string {
  if (mode !== "paper") {
    return "Portfolio is only available in paper mode (pnpm paper).";
  }
  if (portfolios.size === 0) {
    return "No paper portfolio loaded.";
  }

  const lines: string[] = [];
  for (const [pair, portfolio] of portfolios) {
    const markPrice = lastSignals.get(pair)?.price ?? 0;
    const snapshot = portfolio.getSnapshot(markPrice);
    const pos =
      snapshot.position.side === "long"
        ? `long ${snapshot.position.size.toFixed(6)} @ ${snapshot.position.entryPrice.toFixed(6)}`
        : "flat";
    lines.push(
      `${pair} cash=${snapshot.cashUsdc.toFixed(4)} USDC | position=${pos} | equity=${snapshot.equity.toFixed(4)} | realizedPnl=${snapshot.realizedPnl.toFixed(4)} (simulated)`,
    );
  }
  return lines.join("\n");
}

/**
 * Register /start, /report, /portfolio and begin long polling.
 * Only the configured chatId is answered. Returns a stop function for shutdown.
 */
function startTelegramCommands(
  config: TelegramConfig | undefined,
  state: ProgramState,
): () => Promise<void> {
  if (!config) {
    return async () => {
      /* no-op when config is missing */
    };
  }

  const instance = getBot(config.botToken);
  if (commandsStarted) {
    return async () => {
      await instance.stop();
      commandsStarted = false;
    };
  }

  instance.use(async (ctx, next) => {
    if (String(ctx.chat?.id) !== config.chatId) {
      return;
    }
    await next();
  });

  instance.command("start", async (ctx) => {
    try {
      await ctx.reply(formatStartMessage());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram /start failed: ${message}`);
    }
  });

  instance.command("report", async (ctx) => {
    try {
      await ctx.reply(formatReportMessage(state.lastSignals));
      await sendReportCharts(ctx, state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram /report failed: ${message}`);
      try {
        await ctx.reply("Failed to fetch last signal.");
      } catch {
        /* ignore secondary reply failure */
      }
    }
  });

  instance.command("portfolio", async (ctx) => {
    try {
      await ctx.reply(
        formatPortfolioMessage(state.mode, state.portfolios, state.lastSignals),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram /portfolio failed: ${message}`);
      try {
        await ctx.reply("Failed to fetch portfolio.");
      } catch {
        /* ignore secondary reply failure */
      }
    }
  });

  commandsStarted = true;
  void instance.start({
    onStart: () => {
      console.log("Telegram command polling started");
    },
  });

  return async () => {
    await instance.stop();
    commandsStarted = false;
  };
}

/** Send one OHLCV chart photo per pair that has cached candles. */
async function sendReportCharts(
  ctx: Context,
  state: ProgramState,
): Promise<void> {
  for (const [pair, candles] of state.lastCandles) {
    if (candles.length === 0) {
      continue;
    }
    try {
      const png = renderOhlcvPng({
        pair,
        candles,
        strategy: state.strategy,
      });
      const signal = state.lastSignals.get(pair);
      const caption = signal
        ? `${pair} ${signal.side} @ ${signal.price.toFixed(6)}`
        : pair;
      await ctx.replyWithPhoto(new InputFile(png, `${pair.replace("/", "-")}-report.png`), {
        caption,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram /report chart failed for ${pair}: ${message}`);
      try {
        await ctx.reply(`Chart failed for ${pair} (text report above is still valid).`);
      } catch {
        /* ignore secondary reply failure */
      }
    }
  }
}

function fmt(n: number | undefined): string {
  return n == null ? "n/a" : n.toFixed(4);
}
