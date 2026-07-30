import type { Candle } from "../types.js";
import type { StrategyParams } from "../config.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

interface GeckoOhlcvResponse {
  data?: {
    attributes?: {
      ohlcv_list?: [number, number, number, number, number, number][];
    };
  };
}

/** Map strategy timeframe to GeckoTerminal path + aggregate. */
function geckoTimeframe(
  timeframe: StrategyParams["timeframe"],
): { path: "minute" | "hour"; aggregate: number } {
  if (timeframe === "4h") {
    return { path: "hour", aggregate: 4 };
  }
  return { path: "minute", aggregate: 15 };
}

export interface FetchCandlesOptions {
  poolAddress: string;
  timeframe: StrategyParams["timeframe"];
  /** Number of candles to request (GeckoTerminal max is typically 1000). */
  limit?: number;
}

/**
 * Fetch OHLCV candles for a Solana pool from GeckoTerminal.
 * Candles are returned oldest → newest.
 */
export async function fetchCandles(
  options: FetchCandlesOptions,
): Promise<Candle[]> {
  const { poolAddress, timeframe, limit = 200 } = options;
  const { path, aggregate } = geckoTimeframe(timeframe);

  const url = new URL(
    `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${path}`,
  );
  url.searchParams.set("aggregate", String(aggregate));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("currency", "usd");

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (response.status === 429) {
    throw new Error("GeckoTerminal rate limit (429); back off and retry");
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GeckoTerminal OHLCV failed (${response.status}): ${body.slice(0, 200)}`,
    );
  }

  const json = (await response.json()) as GeckoOhlcvResponse;
  const rows = json.data?.attributes?.ohlcv_list ?? [];

  // API returns newest first; normalize to chronological order.
  const candles: Candle[] = rows
    .map(([time, open, high, low, close, volume]) => ({
      time,
      open,
      high,
      low,
      close,
      volume,
    }))
    .sort((a, b) => a.time - b.time);

  if (candles.length === 0) {
    throw new Error(
      `No OHLCV returned for pool ${poolAddress} (${timeframe})`,
    );
  }

  return candles;
}
