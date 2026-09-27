# Speculator Mini App

React + TypeScript + shadcn SPA for the Telegram Mini App.

```bash
# from repo root
pnpm web:dev      # Vite on :5173, proxies /api → :8787; skips Telegram gate
pnpm web:build    # output → web/dist (served by server/; auth required)
pnpm server:dev   # Axum with --dev (skips API initData validation)
```

`pnpm web:dev` sets `VITE_SKIP_TELEGRAM_AUTH=1` so the SPA loads the portfolio UI without Telegram `initData`. Pair it with `pnpm server:dev` so `/api/portfolio` also skips auth. Production builds omit that flag and still show “Open from Telegram” when `initData` is missing.
