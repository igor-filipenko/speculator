# Speculator Mini App

React + TypeScript + shadcn SPA for the Telegram Mini App.

```bash
# from repo root
pnpm web:dev      # Vite on :5173, proxies /api → :8787; skips Telegram gate
pnpm web:build    # output → web/dist (served by server/; auth required)
pnpm web:check    # typecheck + ESLint (--max-warnings 0) + Prettier check
pnpm server:dev   # Axum with --dev (skips API initData validation)
```

Tooling matches the CLI package: shared `tsconfig.base.json` strict flags, type-aware ESLint, and Prettier (root `.prettierrc.json`).

`pnpm web:dev` sets `VITE_SKIP_TELEGRAM_AUTH=1` so the SPA loads without Telegram `initData`. The default page is the latest signal (`GET /api/signal`); Portfolio is the other tab. Pair it with `pnpm server:dev` so those routes also skip auth. Production builds omit that flag and still show “Open from Telegram” when `initData` is missing.
