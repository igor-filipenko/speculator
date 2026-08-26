import { Bot, type Context, InputFile } from "grammy";
import { match } from "ts-pattern";
import type { TelegramConfig } from "../config.js";
import { renderMarketPng, renderOhlcvPng } from "../chart/render-png.js";
import type { MarketState, Portfolio, ProgramState, Risk, Signal, Trade, Trend } from "../types.js";

/** Tagged payloads for outbound Telegram notifications. */
type TelegramInfo =
  | { type: "start" }
  | { type: "shutdown"; code: number; reason?: string }
  | { type: "signal"; signal: Signal }
  | { type: "risk"; risk: Risk }
  | { type: "trade"; trade: Trade }
  | { type: "market"; market: MarketState; previous?: Trend };

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
      .with({ type: "market" }, ({ market, previous }) =>
        previous !== undefined
          ? formatMarketMessage(market, previous)
          : formatMarketMessage(market),
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
    `Price ${code(signal.price.toFixed(6))}`,
    "",
    `_${escapeMd(signal.reason)}_`,
  ];

  if (signal.meta) {
    const parts = formatMetaParts(signal.meta);
    if (parts.length > 0) {
      lines.push("", parts.join(" · "));
    }
  }

  lines.push("", `_${escapeMd(signal.at.toISOString())}_`);
  return lines.join("\n");
}

const META_LABELS: Record<keyof NonNullable<Signal["meta"]>, string> = {
  emaFast: "EMA fast",
  emaSlow: "EMA slow",
  trendEma: "Trend EMA",
  rsi: "RSI",
  atr: "ATR",
  adx: "ADX",
  bbMid: "BB mid",
  bbUpper: "BB upper",
  bbLower: "BB lower",
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

function formatStartMessage(): string {
  return [
    "*Speculator*",
    "_Bot is running\\._",
    "",
    "*Commands*",
    `/start — ${escapeMd("this help")}`,
    `/report — ${escapeMd("last signal per pair")}`,
    `/market — ${escapeMd("HTF trend chart (EMA200, ADX)")}`,
    `/chart — ${escapeMd("OHLCV candle chart (EMA/RSI)")}`,
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

function signedPct(frac: number): string {
  const pct = frac * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function pctOf(frac: number): string {
  return `${(frac * 100).toFixed(2)}%`;
}

function formatUsdCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) {
    return `$${(n / 1e9).toFixed(2)}B`;
  }
  if (abs >= 1e6) {
    return `$${(n / 1e6).toFixed(2)}M`;
  }
  if (abs >= 1e3) {
    return `$${(n / 1e3).toFixed(2)}K`;
  }
  return `$${n.toFixed(2)}`;
}

export function formatMarketStateMessage(state: MarketState): string {
  const trendIcon = match(state.trend)
    .with("bullish", () => "🟢")
    .with("bearish", () => "🔴")
    .with("flat", () => "⚪")
    .with("unknown", () => "❔")
    .exhaustive();

  const lines = [
    `${trendIcon} *${escapeMd(state.pair)}*  *${escapeMd(state.timeframe)}*`,
    `Trend ${code(state.trend)}`,
    `Price ${code(state.price.toFixed(6))}`,
  ];

  if (state.ema200 != null) {
    const dist = state.distEma200Pct != null ? ` (${signedPct(state.distEma200Pct)})` : "";
    lines.push(`EMA200 ${code(state.ema200.toFixed(4))}${escapeMd(dist)}`);
  }
  if (state.ema50 != null) {
    lines.push(`EMA50 ${code(state.ema50.toFixed(4))}`);
  }

  const adxAtr: string[] = [];
  if (state.adx != null) {
    adxAtr.push(`ADX ${code(state.adx.toFixed(2))}`);
  }
  if (state.atr != null) {
    const atrPct = state.atrPct != null ? ` (${pctOf(state.atrPct)})` : "";
    adxAtr.push(`ATR ${code(state.atr.toFixed(4))}${escapeMd(atrPct)}`);
  }
  if (adxAtr.length > 0) {
    lines.push(adxAtr.join(" · "));
  }

  if (state.marketCapUsd != null) {
    lines.push(`MCap ${code(formatUsdCompact(state.marketCapUsd))}`);
  }
  if (state.fdvUsd != null) {
    const label = state.marketCapUsd == null ? "FDV \\(mcap n/a\\)" : "FDV";
    lines.push(`${label} ${code(formatUsdCompact(state.fdvUsd))}`);
  }

  lines.push(`Strategy ${code(state.strategyMode)} ${escapeMd("(env)")}`);
  lines.push(`_${escapeMd(state.at.toISOString())}_`);
  return lines.join("\n");
}

export function formatMarketMessage(state: MarketState, previous?: Trend): string {
  const change =
    previous !== undefined
      ? `${escapeMd(previous)} → ${escapeMd(state.trend)}`
      : escapeMd(state.trend);
  return [
    `🔄 *${escapeMd(state.pair)}*  *MARKET*`,
    change,
    "",
    formatMarketStateMessage(state),
  ].join("\n");
}

export function formatMarketStatesMessage(lastMarketStates: Map<string, MarketState>): string {
  if (lastMarketStates.size === 0) {
    return ["📡 *Market*", "", `_No market state yet\\. Wait for the next poll tick\\._`].join(
      "\n",
    );
  }

  const blocks = [...lastMarketStates.values()].map(formatMarketStateMessage);
  return ["📡 *Market*", ...blocks].join("\n\n");
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
    const pos =
      snapshot.position.side === "long"
        ? `long ${snapshot.position.size.toFixed(6)} @ ${snapshot.position.entryPrice.toFixed(6)}`
        : "flat";

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
 * Register /start, /report, /market, /chart, /portfolio and begin long polling.
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

  instance.command("market", async (ctx) => {
    try {
      await sendMarketCharts(ctx, state.lastMarketStates);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram /market failed: ${message}`);
      try {
        await replyMd(ctx, escapeMd("Failed to fetch market state."));
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

/** Send one HTF MarketState chart photo per pair. */
async function sendMarketCharts(
  ctx: Context,
  lastMarketStates: Map<string, MarketState>,
): Promise<void> {
  if (lastMarketStates.size === 0) {
    await replyMd(ctx, formatMarketStatesMessage(lastMarketStates));
    return;
  }

  let sent = 0;
  for (const [pair, market] of lastMarketStates) {
    if (market.candles.length === 0) {
      try {
        await replyMd(ctx, formatMarketStateMessage(market));
        sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Telegram /market text failed for ${pair}: ${message}`);
      }
      continue;
    }
    try {
      const png = renderMarketPng(market);
      await ctx.replyWithPhoto(new InputFile(png, `${pair.replace("/", "-")}-market.png`), {
        caption: formatMarketStateMessage(market),
        parse_mode: PARSE_MODE,
      });
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Telegram /market failed for ${pair}: ${message}`);
      try {
        await replyMd(ctx, `Market chart failed for ${code(pair)}\\.`);
      } catch {
        /* ignore secondary reply failure */
      }
    }
  }

  if (sent === 0) {
    await replyMd(ctx, formatMarketStatesMessage(lastMarketStates));
  }
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
