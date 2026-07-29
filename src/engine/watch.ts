import type { AppConfig } from "../config.js";
import { strategyParams } from "../config.js";
import { JupiterClient } from "../jupiter/client.js";
import { fetchCandles } from "../market/gecko-terminal.js";
import {
  appendSignalJsonl,
  logPaperSnapshot,
  logPaperTrade,
  logSignal,
} from "../notify/console.js";
import { PaperPortfolio } from "../paper/portfolio.js";
import { evaluateEmaRsi } from "../strategy/ema-rsi.js";
import type { PairConfig } from "../types.js";

export interface WatchOptions {
  config: AppConfig;
  /** When true, run a single iteration then exit (useful for smoke tests). */
  once?: boolean;
}

/**
 * Main poll loop: candles → indicators → signal → optional paper fill.
 */
export async function runWatch(options: WatchOptions): Promise<void> {
  const { config, once = false } = options;
  const params = strategyParams(config.strategy);
  const jupiter = new JupiterClient({ apiKey: config.jupiterApiKey });

  if (!config.jupiterApiKey) {
    console.warn(
      "Warning: JUPITER_API_KEY is empty; quotes may fail or be rate-limited.",
    );
  }

  const portfolios = new Map<string, PaperPortfolio>();
  if (config.mode === "paper") {
    for (const pair of config.pairs) {
      portfolios.set(
        pair.symbol,
        new PaperPortfolio(pair.symbol, config.paperCashUsdc),
      );
    }
  }

  console.log(
    `Starting ${config.mode} mode | strategy=${config.strategy} (${params.timeframe}) | pairs=${config.watchlist.join(",")} | poll=${config.pollIntervalMs}ms`,
  );

  const tick = async (): Promise<void> => {
    for (const pair of config.pairs) {
      try {
        await processPair({ config, pair, params, jupiter, portfolios });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${pair.symbol}] tick failed: ${message}`);
      }
    }
  };

  await tick();
  if (once) {
    return;
  }

  for (;;) {
    await sleep(config.pollIntervalMs);
    await tick();
  }
}

async function processPair(args: {
  config: AppConfig;
  pair: PairConfig;
  params: ReturnType<typeof strategyParams>;
  jupiter: JupiterClient;
  portfolios: Map<string, PaperPortfolio>;
}): Promise<void> {
  const { config, pair, params, jupiter, portfolios } = args;

  const candles = await fetchCandles({
    poolAddress: pair.geckoPoolAddress,
    timeframe: params.timeframe,
    limit: Math.max(params.emaSlow + params.rsiPeriod + 5, 50),
  });

  const price = await jupiter.spotPrice({
    baseMint: pair.baseMint,
    quoteMint: pair.quoteMint,
    baseDecimals: pair.baseDecimals,
    quoteDecimals: pair.quoteDecimals,
  });

  const signal = evaluateEmaRsi({
    pair: pair.symbol,
    candles,
    params,
    price,
  });

  logSignal(signal);
  await appendSignalJsonl(signal);

  if (config.mode !== "paper") {
    return;
  }

  const portfolio = portfolios.get(pair.symbol);
  if (!portfolio) {
    return;
  }

  const trade = portfolio.applySignal(signal);
  if (trade) {
    logPaperTrade(trade);
  }
  logPaperSnapshot(portfolio.getSnapshot(price));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
