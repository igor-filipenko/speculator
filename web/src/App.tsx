import { useMemo } from "react";

import { OpenInTelegramPage } from "@/components/OpenInTelegramPage";
import { PortfolioView } from "@/components/PortfolioView";
import { bootstrapTelegram, hasTelegramAuth } from "@/lib/telegram";

bootstrapTelegram();

export default function App() {
  const authed = useMemo(() => hasTelegramAuth(), []);

  if (!authed) {
    return <OpenInTelegramPage />;
  }

  return <PortfolioView />;
}
