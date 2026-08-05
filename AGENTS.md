# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

**speculator** — TypeScript CLI that emits Solana swing/intraday trade _recommendations_ (`BUY` / `SELL` / `HOLD`) using EMA/RSI on GeckoTerminal OHLCV, with optional **paper** portfolio filled from Jupiter swap quotes, plus offline **backtest** replay with emulated fill costs.

Build/run: [README.md](./README.md).

## Hard constraints (v1)

- **Do not** add live Jupiter swaps, wallet signing, Executor/dry-run layers, or `TradeIntent` unless the user explicitly expands scope.
- Candle-replay **backtest** (`pnpm backtest`) is in scope: Gecko OHLCV + disk cache + Jupiter-like fee/slippage emulation. Do not call live Jupiter during backtest.
- **Do not** add shorts, leverage, or multi-position sizing.
- Package manager is **pnpm** only (not npm/yarn/bun). Runtime is **Node ≥24** (24 Active LTS recommended).
- Comments and user-facing docs in this repo are **English**.
- Format with **Prettier** (`pnpm format`); `pnpm check` includes `format:check`. Prefer the Prettier VS Code/Cursor extension (format on save is enabled in `.vscode/settings.json`).
- Keep the dependency surface small: prefer `fetch` + zod + tsx; `grammy` is allowed for optional Telegram notify/commands. Do not add heavy TA libraries (`technicalindicators`, etc.) — indicators stay hand-rolled in `src/strategy/indicators.ts`.
- Never commit secrets (`.env`, private keys). Use `.env.example` only.

## Layout

```
src/
  index.ts              # CLI entry: watch | paper | backtest
  config.ts             # zod + dotenv
  types.ts              # Candle, Signal, Position
  market/gecko-terminal.ts
  market/ohlcv-cache.ts # disk cache for backtest OHLCV
  jupiter/client.ts     # quote only (live paper/watch)
  jupiter/emulated-quote.ts  # backtest fill cost model
  strategy/indicators.ts
  strategy/ema-rsi.ts
  chart/ohlcv-svg.ts    # candle + EMA/RSI SVG for Telegram /chart
  chart/render-png.ts   # SVG → PNG
  paper/portfolio.ts
  paper/store.ts        # paper-state.json load/save
  notify/console.ts
  notify/telegram.ts    # optional alerts + inbound commands (grammY polling)
  engine/watch.ts
  engine/backtest.ts    # offline candle replay
```

## Conventions

- Prefer small pure functions for indicators and strategy; keep I/O at the edges (market, jupiter, engine).
- Paper and backtest fills must be labeled **simulated** in logs; they are not real on-chain prices after fees/slippage.
- One long position per pair: ignore BUY when already long; ignore SELL when flat.
- When changing strategy defaults, update `.env.example` (and README) together.
- After substantive code changes, run `pnpm check` (`typecheck` + ESLint with `--max-warnings 0`).
- Keep TypeScript strict flags in `tsconfig.json` and type-aware rules in `eslint.config.js`; do not weaken them without discussion.

## Security

- Treat `JUPITER_API_KEY` and `TELEGRAM_BOT_TOKEN` as secrets.
- Do not introduce code paths that load or log private keys in v1.
- Prefer high-trust, maintained packages; avoid adding deps with known high/critical CVEs.
