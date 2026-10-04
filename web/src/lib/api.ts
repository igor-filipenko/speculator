export type PortfolioMode = "paper" | "live";

export interface PositionDto {
  pair: string;
  side: string;
  size: number;
  entryPrice: number;
  openedAt?: string;
}

export interface PortfolioItemDto {
  pair: string;
  cashUsdc: number;
  realizedPnl: number;
  equity: number;
  position: PositionDto;
  simulated: boolean;
  updatedAt: string;
}

export interface PortfolioResponse {
  mode: string;
  botId: string;
  portfolios: PortfolioItemDto[];
}

export interface SignalDto {
  pair: string;
  side: string;
  price: number;
  reason: string;
  at: string;
  emaFast?: number;
  emaSlow?: number;
  rsi?: number;
  trendEma?: number;
  atr?: number;
  adx?: number;
}

export interface SignalResponse {
  botId: string;
  signal: SignalDto | null;
}

async function getJson<T>(path: string, initData: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (initData) {
    headers["Authorization"] = `tma ${initData}`;
  }
  const res = await fetch(path, { headers });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchPortfolio(initData: string, mode: PortfolioMode): Promise<PortfolioResponse> {
  return getJson(`/api/portfolio?mode=${encodeURIComponent(mode)}`, initData);
}

export function fetchSignal(initData: string): Promise<SignalResponse> {
  return getJson("/api/signal", initData);
}
