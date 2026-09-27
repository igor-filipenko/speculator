# Speculator web server

Axum + Tokio HTTP server for the Speculator Telegram Mini App.

- `GET /api/health` — liveness (no auth)
- `GET /api/portfolio?mode=paper|live` — portfolio for `BOT_ID` (`Authorization: tma <initData>`)
- Serves static files from `WEB_STATIC_DIR` (default `web/dist`)

```bash
# from repo root
pnpm web:build
pnpm server:dev   # passes --dev (skips Telegram auth)
```

`--dev` skips Telegram `initData` validation and makes `TELEGRAM_*` env optional. Use only for local testing; production (`pnpm server:build` / `miniapp.service`) must not pass `--dev`.

Env: `DATABASE_URL`, `BOT_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID` (or `TELEGRAM_CHAT_ID`), `WEB_LISTEN`, `WEB_STATIC_DIR`.

Telegram auth failures log the failing step (`hash mismatch`, `user not allowed`, missing header, …) without dumping `initData` or the bot token. Follow with `journalctl -u miniapp -f`.
