import { useMemo, useState } from "react";

import { OpenInTelegramPage } from "@/components/OpenInTelegramPage";
import { PortfolioView } from "@/components/PortfolioView";
import { SignalView } from "@/components/SignalView";
import { cn } from "@/lib/utils";
import { bootstrapTelegram, hasTelegramAuth } from "@/lib/telegram";

bootstrapTelegram();

type Page = "signal" | "portfolio";

const pages: { id: Page; label: string }[] = [
  { id: "signal", label: "Signal" },
  { id: "portfolio", label: "Portfolio" },
];

export default function App() {
  const authed = useMemo(() => hasTelegramAuth(), []);
  const [page, setPage] = useState<Page>("signal");

  if (!authed) {
    return <OpenInTelegramPage />;
  }

  const title = pages.find((item) => item.id === page)?.label ?? "Signal";

  return (
    <div className="flex min-h-dvh">
      <nav
        aria-label="Sections"
        className="flex w-36 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar px-3 py-6 text-sidebar-foreground"
      >
        <p className="px-2 pb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Speculator
        </p>
        {pages.map((item) => {
          const active = page === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-lg px-2 py-2 text-left text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "hover:bg-sidebar-accent/70",
              )}
              onClick={() => setPage(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
      <main className="min-w-0 flex-1 px-4 py-6">
        <div className="flex w-full max-w-lg flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {page === "signal" ? <SignalView /> : <PortfolioView />}
        </div>
      </main>
    </div>
  );
}
