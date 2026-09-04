# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

**speculator** — TypeScript CLI that emits Solana trade _recommendations_ (`BUY` / `SELL` / `HOLD`) using Bollinger or Grid on GeckoTerminal OHLCV, with optional **paper** portfolio filled from Jupiter swap quotes, **live** Jupiter swaps (`pnpm trade`), plus offline **backtest** replay with emulated fill costs.

Build/run: [README.md](./README.md).

## Hard constraints

- Live Jupiter swaps and wallet signing are in scope for **`pnpm trade` only**. Paper and watch stay quote-only; backtest must not call live Jupiter.
- Candle-replay **backtest** (`pnpm backtest`): Gecko OHLCV + Timescale `market.candles` cache + Jupiter-like fee/slippage emulation.
- **Do not** add shorts, leverage, or multi-position sizing.
- Package manager is **pnpm** only (not npm/yarn/bun). Runtime is **Node ≥24** (24 Active LTS recommended).
- Comments and user-facing docs in this repo are **English**.
- Format with **Prettier** (`pnpm format`); `pnpm check` includes `format:check`. Prefer the Prettier VS Code/Cursor extension (format on save is enabled in `.vscode/settings.json`).
- Keep the dependency surface small: prefer `fetch` + zod + tsx + `pg`; `dbmate` is allowed for SQL migrations; `grammy` is allowed for optional Telegram notify/commands; `@solana/web3.js` is allowed for live keypair signing and RPC balances. Do not add heavy TA libraries (`technicalindicators`, etc.) — indicators stay hand-rolled in `src/strategy/indicators.ts`.
- Never commit secrets (`.env`, private keys, keypair JSON). Use `.env.example` only.

## Layout

```
src/
  index.ts              # CLI entry: MODE env or watch | paper | trade | wallet | backtest
  config.ts             # zod + dotenv
  types.ts              # Candle, Signal, Position, Order, Trade
  db/
    db.ts               # pg.Pool (DATABASE_URL) + BOT_ID
    migrate.ts          # assert dbmate migrations are applied
    candles.ts          # market.candles (pool_address + timeframe)
    bot.ts              # bot.portfolios / bot.trades
    paper.ts / live.ts  # mode wrappers
    signals.ts          # market.signals
    tokens.ts           # solana.tokens
    pools.ts            # solana.pools
  market/gecko-terminal.ts
  market/ohlcv-cache.ts # OHLCV fetch + Timescale cache orchestration
  market/htf.ts         # HTF EMA stack + DMI trend + S/R → MarketIndicators
  market/htf-indicators.ts # HTF MarketIndicators refresh (OHLCV cache)
  market/levels.ts      # swing-pivot S/R clusters
  exchange/jupiter.ts          # paper Exchange (Jupiter quote only)
  exchange/jupiter-swap.ts     # live Exchange (Swap API V2 order + execute)
  exchange/wallet.ts           # JSON keypair load + RPC balances
  exchange/amounts.ts          # atomic units, SOL reserve, fill math
  exchange/emulated-quote.ts   # backtest fill cost model
  exchange/emulated-exchange.ts
  strategy/indicators.ts
  strategy/mode/bollinger.ts
  strategy/mode/grid.ts
  strategy/strategy-manager.ts # loadStrategy + HTF MarketIndicators; getActiveStrategy / getActiveRiskManager
  strategy/market-state-svg.ts # HTF candles + EMA50/200 + S/R + ADX SVG
  risk/risk-manager.ts         # Signal + Snapshot + RiskParams → Command | Risk
  strategy/mode/bollinger-svg.ts # Bollinger band SVG
  strategy/mode/grid-svg.ts    # ATR grid SVG
  chart/render-png.ts   # SVG → PNG
  paper/portfolio.ts    # applyOrder (not raw signals)
  paper/store.ts        # paper load/save (Timescale)
  live/portfolio.ts     # on-chain cash/size + ledger entry/PnL
  live/store.ts         # live persisted shapes
  notify/console.ts
  notify/telegram.ts    # optional alerts + inbound commands (grammY polling)
  engine/tick.ts        # shared poll loop (paper + trade)
  engine/watch.ts
  engine/paper.ts
  engine/trade.ts
  engine/wallet.ts      # one-shot live portfolio print
  engine/backtest.ts    # offline candle replay
```

## Conventions

- Prefer small pure functions for indicators and strategy; keep I/O at the edges (market, exchange, engine).
- Flow: Strategy signal → RiskManager command → Exchange order → Portfolio applyOrder.
- Paper and backtest fills must be labeled **simulated** in logs; live fills must be labeled **LIVE** and include a tx signature when present.
- One long position per pair: ignore BUY when already long; ignore SELL when flat.
- When changing strategy defaults, update `.env.example` (and README) together.
- After substantive code changes, run `pnpm check` (`typecheck` + ESLint with `--max-warnings 0`).
- Keep TypeScript strict flags in `tsconfig.json` and type-aware rules in `eslint.config.js`; do not weaken them without discussion.

## Security

- Treat `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, and the wallet keypair as secrets.
- Never log private key bytes or keypair file contents; log only the public key.
- Prefer high-trust, maintained packages; avoid adding deps with known high/critical CVEs.
