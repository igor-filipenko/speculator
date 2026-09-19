import WebApp from "@twa-dev/sdk";

interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  themeParams: { bg_color?: string };
}

function telegramWebApp(): TelegramWebApp | undefined {
  const fromSdk = WebApp as unknown as TelegramWebApp | undefined;
  if (fromSdk && typeof fromSdk.initData === "string") {
    return fromSdk;
  }
  const fromWindow = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram
    ?.WebApp;
  if (fromWindow && typeof fromWindow.initData === "string") {
    return fromWindow;
  }
  return undefined;
}

export function getInitData(): string {
  return telegramWebApp()?.initData ?? "";
}

/** True when opened inside Telegram with signed initData. */
export function hasTelegramAuth(): boolean {
  const data = getInitData();
  console.info("[telegram] initData length", data.length);
  return data.length > 0;
}

/** Prepare Telegram WebApp chrome when running inside Telegram. */
export function bootstrapTelegram(): void {
  try {
    const app = telegramWebApp();
    app?.ready();
    const data = getInitData();
    console.info("[telegram] after ready() initData length", data.length);
    if (!data) {
      return;
    }
    app?.expand();
    document.documentElement.classList.add("dark");
    const bg = app?.themeParams.bg_color;
    if (bg) {
      document.documentElement.style.setProperty("--tg-bg", bg);
    }
  } catch (err) {
    console.warn("[telegram] bootstrap failed", err);
  }
}
