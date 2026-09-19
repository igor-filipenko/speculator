# Speculator Mini App

React + TypeScript + shadcn SPA for the Telegram Mini App.

```bash
# from repo root
pnpm web:dev      # Vite on :5173, proxies /api → :8787
pnpm web:build    # output → web/dist (served by server/)
```

Without Telegram `initData`, the app shows an “Open from Telegram” page and does not call the API.
