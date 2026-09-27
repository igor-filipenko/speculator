import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchSignal, type SignalDto, type SignalResponse } from "@/lib/api";
import { getInitData } from "@/lib/telegram";

function formatPrice(n: number): string {
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return n.toFixed(digits);
}

function formatIndicator(n: number): string {
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return n.toFixed(digits);
}

function sideClass(side: string): string | undefined {
  if (side === "BUY") return "bg-emerald-500/15 text-emerald-400";
  if (side === "SELL") return "bg-destructive/15 text-destructive";
  return undefined;
}

function IndicatorRow({ label, value }: { label: string; value: number | undefined }) {
  if (value == null) return null;
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{formatIndicator(value)}</span>
    </div>
  );
}

function SignalCard({ signal }: { signal: SignalDto }) {
  const variant = signal.side === "HOLD" ? "secondary" : "outline";
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-lg">{signal.pair}</CardTitle>
          <Badge variant={variant} className={sideClass(signal.side)}>
            {signal.side}
          </Badge>
        </div>
        <CardDescription>{new Date(signal.at).toLocaleString()}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="leading-relaxed">{signal.reason}</p>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Price</span>
          <span className="font-mono">{formatPrice(signal.price)}</span>
        </div>
        <IndicatorRow label="EMA fast" value={signal.emaFast} />
        <IndicatorRow label="EMA slow" value={signal.emaSlow} />
        <IndicatorRow label="Trend EMA" value={signal.trendEma} />
        <IndicatorRow label="RSI" value={signal.rsi} />
        <IndicatorRow label="ATR" value={signal.atr} />
        <IndicatorRow label="ADX" value={signal.adx} />
      </CardContent>
    </Card>
  );
}

export function SignalView() {
  const [data, setData] = useState<SignalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSignal(getInitData());
      setData(res);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <Skeleton className="h-44 w-full rounded-xl" />;
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Could not load signal</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data?.signal) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No signal yet</CardTitle>
          <CardDescription>
            No rows in <span className="font-mono">market.signals</span> for bot{" "}
            <span className="font-mono">{data?.botId}</span>.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return <SignalCard signal={data.signal} />;
}
