import { Bot, type Context, InputFile } from "grammy";
import { match } from "ts-pattern";
import type { TelegramConfig } from "../config.js";
import { renderOhlcvPng } from "../chart/render-png.js";
import type { Portfolio, ProgramState, Risk, Signal, Trade } from "../types.js";

/** Tagged payloads for outbound Telegram notifications. */
type TelegramInfo =
  | { type: "start" }
  | { type: "shutdown"; code: number; reason?: string }
  | { type: "signal"; signal: Signal }
  | { type: "risk"; risk: Risk }
  | { type: "trade"; trade: Trade }
  | { type: "protective"; trade: Trade }
  | { type: "error"; pair?: string; message: string };

const PARSE_MODE = "MarkdownV2" as const;

export class Telegram {
  private readonly config: TelegramConfig | undefined;
  private readonly onStop: () => Promise<void>;

  private constructor(config: TelegramConfig | undefined, onStop: () => Promise<void>) {
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
      .with({ type: "risk" }, ({ risk }) => formatRiskMessage(risk))
      .with({ type: "trade" }, ({ trade }) => formatTradeMessage(trade))
      .with({ type: "protective" }, ({ trade }) => formatProtectiveMessage(trade))
      .with({ type: "error" }, ({ pair, message }) => formatErrorMessage(pair, message))
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

/** Send a MarkdownV2 Telegram message via grammY. */
async function sendTelegramMessage(config: TelegramConfig, text: string): Promise<void> {
  try {
    await getBot(config.botToken).api.sendMessage(config.chatId, text, {
      parse_mode: PARSE_MODE,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Telegram send failed: ${message}`, { cause: err });
  }
}

async function replyMd(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: PARSE_MODE });
}

/** Escape plain text for Telegram MarkdownV2. */
function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/** Inline code span; escapes backticks and backslashes inside. */
function code(text: string): string {
  return `\`${text.replace(/[`\\]/g, "\\$&")}\``;
}

function formatSignalMessage(signal: Signal): string {
  const sideIcon = match(signal.side)
    .with("BUY", () => "🟢")
    .with("SELL", () => "🔴")
    .with("HOLD", () => "⚪")
    .exhaustive();

  const lines = [
    `${sideIcon} *${escapeMd(signal.pair)}*  *${escapeMd(signal.side)}*`,
    `Strategy ${code(signal.strategyId)}`,
    `Price ${code(signal.price.toFixed(6))}`,
  ];

  const levels = formatSignalLevels(signal);
  if (levels.length > 0) {
    lines.push(levels.join(" · "));
  }

  lines.push("", `_${escapeMd(signal.reason)}_`);

  if (signal.meta) {
    const parts = formatMetaParts(signal.meta);
    if (parts.length > 0) {
      lines.push("", parts.join(" · "));
    }
  }

  lines.push("", `_${escapeMd(signal.at.toISOString())}_`);
  return lines.join("\n");
}

function formatSignalLevels(signal: Signal): string[] {
  const parts: string[] = [];
  if (signal.slPrice != null) {
    parts.push(`SL ${code(fmt(signal.slPrice))}`);
  }
  if (signal.tpPrices.length > 0) {
    parts.push(`TP ${signal.tpPrices.map((p) => code(fmt(p))).join(" / ")}`);
  }
  parts.push(`${escapeMd("Min R:R")} ${code(signal.minRewardRisk.toFixed(2))}`);
  return parts;
}

const META_LABELS: Record<keyof NonNullable<Signal["meta"]>, string> = {
  emaFast: "EMA fast",
  emaSlow: "EMA slow",
  trendEma: "Trend EMA",
  macd: "MACD",
  macdSignal: "MACD signal",
  macdHist: "MACD histogram",
  rsi: "RSI",
  stochK: "Stoch %K",
  stochD: "Stoch %D",
  atr: "ATR",
  adx: "ADX",
  plusDi: "+DI",
  minusDi: "-DI",
  bbMid: "BB mid",
  bbUpper: "BB upper",
  bbLower: "BB lower",
  kcMid: "KC mid",
  kcUpper: "KC upper",
  kcLower: "KC lower",
  donchianUpper: "DC upper",
  donchianLower: "DC lower",
  volumeSma: "Vol SMA",
  rvol: "RVOL",
  barLow: "Bar low",
  barHigh: "Bar high",
};

function formatMetaParts(meta: NonNullable<Signal["meta"]>): string[] {
  const parts: string[] = [];
  for (const key of Object.keys(META_LABELS) as (keyof typeof META_LABELS)[]) {
    const value = meta[key];
    if (value != null) {
      parts.push(`${escapeMd(META_LABELS[key])} ${code(fmt(value))}`);
    }
  }
  return parts;
}

function formatRiskMessage(risk: Risk): string {
  return [
    `⚠️ *${escapeMd(risk.signal.pair)}*  *RISK*`,
    `Price ${code(risk.signal.price.toFixed(6))}`,
    `Signal ${code(risk.signal.side)}`,
    "",
    `_${escapeMd(risk.reason)}_`,
    "",
    `_${escapeMd(risk.signal.at.toISOString())}_`,
  ].join("\n");
}

function formatTradeMessage(trade: Trade): string {
  const heading = trade.simulated
    ? `📄 *PAPER ${escapeMd(trade.side)}*`
    : `⚡ *LIVE ${escapeMd(trade.side)}*`;
  const lines = [
    heading,
    `*${escapeMd(trade.pair)}*`,
    `Size ${code(trade.size.toFixed(6))} @ ${code(trade.price.toFixed(6))}`,
  ];
  if (trade.simulated) {
    lines.push(`_simulated_`);
  }
  if (trade.txSignature != null) {
    lines.push(`Sig ${code(trade.txSignature)}`);
  }
  if (trade.realizedPnl != null) {
    lines.push(`Realized P&L ${code(`${trade.realizedPnl.toFixed(4)} USDC`)}`);
  }
  return lines.join("\n");
}

function formatProtectiveMessage(trade: Trade): string {
  const heading = trade.simulated
    ? `🛡️ *PAPER STOP ${escapeMd(trade.side)}*`
    : `🛡️ *LIVE STOP ${escapeMd(trade.side)}*`;
  const lines = [
    heading,
    `*${escapeMd(trade.pair)}*`,
    `Size ${code(trade.size.toFixed(6))} @ ${code(trade.price.toFixed(6))}`,
  ];
  if (trade.reason) {
    lines.push("", `_${escapeMd(trade.reason)}_`);
  }
  if (trade.simulated) {
    lines.push(`_simulated_`);
  }
  if (trade.txSignature != null) {
    lines.push(`Sig ${code(trade.txSignature)}`);
  }
  if (trade.realizedPnl != null) {
    lines.push(`Realized P&L ${code(`${trade.realizedPnl.toFixed(4)} USDC`)}`);
  }
  return lines.join("\n");
}

function formatStartMessage(): string {
  return [
    "*Speculator*",
    "_Bot is running\\._",
    "",
    "*Commands*",
    `/start — ${escapeMd("this help")}`,
    `/report — ${escapeMd("last signal per pair")}`,
    `/chart — ${escapeMd("OHLCV candle chart (strategy overlays)")}`,
    `/portfolio — ${escapeMd("current portfolio")}`,
  ].join("\n");
}

function formatShutdownMessage(shutdown: { code: number; reason?: string }): string {
  if (shutdown.reason != null) {
    return [
      "⏹ *Stopped*",
      `Reason ${code(shutdown.reason)}`,
      `Exit code ${code(String(shutdown.code))}`,
    ].join("\n");
  }
  return ["⏹ *Shutdown*", `Exit code ${code(String(shutdown.code))}`].join("\n");
}

function formatReportMessage(lastSignals: Map<string, Signal>): string {
  if (lastSignals.size === 0) {
    return ["📊 *Report*", "", `_No signal yet\\. Wait for the next poll tick\\._`].join("\n");
  }

  const blocks = [...lastSignals.values()].map(formatSignalMessage);
  return ["📊 *Report*", ...blocks].join("\n\n");
}

export function formatErrorMessage(pair: string | undefined, message: string): string {
  const where = pair != null ? `*${escapeMd(pair)}* ` : "";
  return [`⚠️ ${where}*ERROR*`, escapeMd(message)].join("\n");
}

function formatPosition(position: { side: string; size: number; entryPrice: number }): string {
  if (position.side === "flat") {
    return "flat";
  }
  return `${position.side} ${position.size.toFixed(6)} @ ${position.entryPrice.toFixed(6)}`;
}

function formatPortfolioMessage(
  portfolios: Map<string, Portfolio>,
  lastSignals: Map<string, Signal>,
): string {
  if (portfolios.size === 0) {
    return ["💼 *Portfolio*", "", `_No portfolio loaded\\._`].join("\n");
  }

  const blocks: string[] = ["💼 *Portfolio*"];
  for (const [pair, portfolio] of portfolios) {
    const markPrice = lastSignals.get(pair)?.price ?? 0;
    const snapshot = portfolio.getSnapshot(markPrice);
    const pos = formatPosition(snapshot.position);

    blocks.push(
      "",
      `*${escapeMd(pair)}*`,
      `Cash ${code(`${snapshot.cashUsdc.toFixed(4)} USDC`)}`,
      `Position ${code(pos)}`,
      `Equity ${code(snapshot.equity.toFixed(4))}`,
      `Realized P&L ${code(snapshot.realizedPnl.toFixed(4))}`,
      snapshot.simulated ? `_simulated_` : `_live_`,
    );
  }
  return blocks.join("\n");
}

function formatChartCaption(pair: string, signal: Signal | undefined): string {
  if (!signal) {
    return `📈 *${escapeMd(pair)}*`;
  }
  return [
    `📈 *${escapeMd(pair)}*  *${escapeMd(signal.side)}*`,
    `Price ${code(signal.price.toFixed(6))}`,
  ].join("\n");
}

/**
 * Register /start, /report, /chart, /portfolio and begin long polling.
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
      await replyMd(ctx, formatStartMessage());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram /start failed: ${message}`);
    }
  });

  instance.command("report", async (ctx) => {
    try {
      await replyMd(ctx, formatReportMessage(state.lastSignals));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram /report failed: ${message}`);
      try {
        await replyMd(ctx, escapeMd("Failed to fetch last signal."));
      } catch {
        /* ignore secondary reply failure */
      }
    }
  });

  instance.command("chart", async (ctx) => {
    try {
      await sendCharts(ctx, state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram /chart failed: ${message}`);
      try {
        await replyMd(ctx, escapeMd("Failed to render chart."));
      } catch {
        /* ignore secondary reply failure */
      }
    }
  });

  instance.command("portfolio", async (ctx) => {
    try {
      await replyMd(ctx, formatPortfolioMessage(state.portfolios, state.lastSignals));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram /portfolio failed: ${message}`);
      try {
        await replyMd(ctx, escapeMd("Failed to fetch portfolio."));
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
async function sendCharts(ctx: Context, state: ProgramState): Promise<void> {
  if (state.lastCandles.size === 0) {
    await replyMd(
      ctx,
      ["📈 *Chart*", "", `_No candles yet\\. Wait for the next poll tick\\._`].join("\n"),
    );
    return;
  }

  let sent = 0;
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
      const caption = formatChartCaption(pair, state.lastSignals.get(pair));
      await ctx.replyWithPhoto(new InputFile(png, `${pair.replace("/", "-")}-chart.png`), {
        caption,
        parse_mode: PARSE_MODE,
      });
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram /chart failed for ${pair}: ${message}`);
      try {
        await replyMd(ctx, `Chart failed for ${code(pair)}\\.`);
      } catch {
        /* ignore secondary reply failure */
      }
    }
  }

  if (sent === 0) {
    await replyMd(ctx, ["📈 *Chart*", "", `_No candles available yet\\._`].join("\n"));
  }
}

function fmt(n: number): string {
  return n.toFixed(4);
}
