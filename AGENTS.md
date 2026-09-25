# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

**speculator** — TypeScript CLI that emits Solana trade _recommendations_ (`BUY` / `SELL` / `HOLD`) using Bollinger or Grid on GeckoTerminal OHLCV, with optional **paper** portfolio filled from Jupiter swap quotes, **live** Jupiter swaps (`pnpm trade`), offline **backtest** / **regime** replay, plus a read-only **Telegram Mini App** (`server/` Axum HTTP + `web/` React SPA).

Build/run: [README.md](./README.md).

## Hard constraints

- Live Jupiter swaps and wallet signing are in scope for **`pnpm trade` only**. Paper and watch stay quote-only; backtest must not call live Jupiter.
- The Mini App server (`server/`) is **read-only** (health + portfolio). It must not place orders or call Jupiter.
- Candle-replay **backtest** (`pnpm backtest`): Gecko OHLCV + Timescale `market.candles` cache + Jupiter-like fee/slippage emulation.
- Candle-replay **regime** (`pnpm regime`): same HTF/1h close cadence as backtest; logs trend/vol switches and draws a CLI chart. No fills.
- One position per pair: `long` or `short` or `flat`. No leverage multiplier and no multi-position sizing.
- Package manager is **pnpm** only (not npm/yarn/bun). Runtime is **Node ≥24** (24 Active LTS recommended). Rust toolchain required for `server/`.
- Comments and user-facing docs in this repo are **English**.
- Format with **Prettier** (`pnpm format`); `pnpm check` includes `format:check`. Prefer the Prettier VS Code/Cursor extension (format on save is enabled in `.vscode/settings.json`).
- Keep the dependency surface small: prefer `fetch` + zod + tsx + `pg`; `dbmate` is allowed for SQL migrations; `grammy` is allowed for optional Telegram notify/commands; `@solana/web3.js` is allowed for live keypair signing and RPC balances. Do not add heavy TA libraries (`technicalindicators`, etc.) — indicators stay hand-rolled in `src/strategy/indicators.ts`. Mini App UI uses React + shadcn under `web/`; API uses Axum under `server/`.
- Never commit secrets (`.env`, private keys, keypair JSON). Use `.env.example` only.

## Layout

```
src/                    # TypeScript trading CLI (unchanged engines)
web/                    # React + TypeScript + shadcn Telegram Mini App SPA
server/                 # Rust Axum + Tokio HTTP API (serves web/dist + /api)
deploy/
  bot.service
  miniapp.service
  bot.sh
  miniapp.sh

src/ highlights:
  index.ts              # CLI entry: MODE env or watch | paper | trade | wallet | backtest | regime
  config.ts             # zod + dotenv
  types.ts              # Candle, Signal, Position, Order, Trade
  db/                   # Timescale access (portfolios, trades, signals, candles, tokens, pools)
  market/               # Gecko OHLCV + HTF/1h MarketIndicators
  exchange/             # emulated, or jupiter (spot long + perps short)
  strategy/             # indicators + bollinger/grid/donchian + SVGs
  risk/risk-manager.ts
  portfolio/            # live, paper, wallet (keypair + RPC balances)
  notify/               # console + Telegram grammY
  engine/               # watch | paper | trade | wallet | backtest | regime
  chart/render-png.ts
```

## Conventions

- Prefer small pure functions for indicators and strategy; keep I/O at the edges (market, exchange, engine).
- Strategy knobs live on the mode `*Params` object (`gridParamsFor` / `bollingerParamsFor` / …). Do not add magic numbers inside `evaluate*`.
- Flow: Strategy signal → RiskManager command → Exchange order → Portfolio applyOrder.
- Paper and backtest fills must be labeled **simulated** in logs; live fills must be labeled **LIVE** and include a tx signature when present.
- One position per pair: ignore a new entry on the side already open. `BUY` opens a long or covers a short; `SELL` opens a short or closes a long.
- When changing strategy defaults, update `.env.example` (and README) together.
- After substantive code changes, run `pnpm check` (`typecheck` + ESLint with `--max-warnings 0`).
- Keep TypeScript strict flags in `tsconfig.json` and type-aware rules in `eslint.config.js`; do not weaken them without discussion.

## Security

- Treat `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, and the wallet keypair as secrets.
- Never log private key bytes or keypair file contents; log only the public key.
- Prefer high-trust, maintained packages; avoid adding deps with known high/critical CVEs.
