import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchPortfolio,
  type PortfolioItemDto,
  type PortfolioMode,
  type PortfolioResponse,
} from "@/lib/api";
import { getInitData } from "@/lib/telegram";

function formatUsdc(n: number): string {
  return `${n.toFixed(4)} USDC`;
}

function PositionLine({ item }: { item: PortfolioItemDto }) {
  const { position } = item;
  if (position.side === "long") {
    return (
      <span>
        long {position.size.toFixed(6)} @ {position.entryPrice.toFixed(6)}
      </span>
    );
  }
  return <span>flat</span>;
}

function PortfolioCard({ item }: { item: PortfolioItemDto }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-lg">{item.pair}</CardTitle>
          <Badge variant={item.simulated ? "secondary" : "default"}>
            {item.simulated ? "simulated" : "live"}
          </Badge>
        </div>
        <CardDescription>Updated {new Date(item.updatedAt).toLocaleString()}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Cash</span>
          <span className="font-mono">{formatUsdc(item.cashUsdc)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Position</span>
          <span className="font-mono text-right">
            <PositionLine item={item} />
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Equity</span>
          <span className="font-mono">{formatUsdc(item.equity)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Realized P&amp;L</span>
          <span className="font-mono">{formatUsdc(item.realizedPnl)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function PortfolioView() {
  const [mode, setMode] = useState<PortfolioMode>("paper");
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPortfolio(getInitData(), mode);
      setData(res);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Speculator
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={mode === "paper" ? "default" : "outline"}
            onClick={() => setMode("paper")}
          >
            Paper
          </Button>
          <Button
            size="sm"
            variant={mode === "live" ? "default" : "outline"}
            onClick={() => setMode("live")}
          >
            Live
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-36 w-full rounded-xl" />
        </div>
      ) : null}

      {!loading && error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Could not load portfolio</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {!loading && !error && data && data.portfolios.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No portfolio yet</CardTitle>
            <CardDescription>
              No {mode} rows for bot <span className="font-mono">{data.botId}</span>.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {!loading && !error && data
        ? data.portfolios.map((item) => <PortfolioCard key={item.pair} item={item} />)
        : null}
    </main>
  );
}
