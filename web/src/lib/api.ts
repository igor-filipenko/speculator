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

export async function fetchPortfolio(
  initData: string,
  mode: PortfolioMode,
): Promise<PortfolioResponse> {
  const res = await fetch(`/api/portfolio?mode=${encodeURIComponent(mode)}`, {
    headers: {
      Authorization: `tma ${initData}`,
      Accept: "application/json",
    },
  });
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
  return (await res.json()) as PortfolioResponse;
}
