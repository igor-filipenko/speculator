# Speculator

TypeScript CLI bot for Solana swing / intraday **trade recommendations** (`BUY` / `SELL` / `HOLD`).

- **OHLCV:** GeckoTerminal (candles for EMA/RSI)
- **Spot / paper fills:** Jupiter Swap quote API (`/swap/v1/quote`)
- **v1 scope:** signals + optional paper portfolio (no live swaps, no backtest)

See [PLANS.md](./PLANS.md) for the product plan and [AGENTS.md](./AGENTS.md) for contributor/agent conventions.

## Requirements

- **Node.js ≥24** (24 Active LTS recommended)
- **pnpm** 10+ (Corepack recommended)

```bash
corepack enable
corepack prepare pnpm@10.14.0 --activate
```

## Setup

```bash
pnpm install
cp .env.example .env
```

Edit `.env`:

| Variable | Meaning |
|----------|---------|
| `MODE` | `signal` (default via `pnpm watch`) or `paper` |
| `STRATEGY` | `intraday` (15m EMA 9/21) or `swing` (4h EMA 12/26) |
| `JUPITER_API_KEY` | From [portal.jup.ag](https://portal.jup.ag/) — recommended |
| `WATCHLIST` | `SOL/USDC` (only pair in v1) |
| `POLL_INTERVAL_MS` | Poll interval (default `60000`) |
| `PAPER_CASH_USDC` | Starting virtual USDC for paper mode |
| `GECKO_POOL_ADDRESS` | Optional Solana pool override for OHLCV |
| `TELEGRAM_BOT_TOKEN` | Optional bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Optional chat id to receive alerts |

### Telegram (optional)

Set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to enable outbound alerts via [grammY](https://grammy.dev/) (`sendMessage` only — no polling). You get messages for **BUY/SELL** signals and paper fills; **HOLD** stays console/JSONL only.

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Message your bot once, then get your chat id (e.g. via [@userinfobot](https://t.me/userinfobot)).
3. Put both values in `.env`.

## Build

Typecheck:

```bash
pnpm typecheck
```

Compile to `dist/`:

```bash
pnpm build
```

Day-to-day development uses `tsx` (no build required for `watch` / `paper`).

## Run

Recommendations only (forces signal mode):

```bash
pnpm watch
```

Paper trading (virtual long-only portfolio, simulated fills from Jupiter quotes):

```bash
pnpm paper
```

Single iteration (smoke test):

```bash
pnpm exec tsx src/index.ts watch --once
pnpm exec tsx src/index.ts paper --once
```

Signals are printed to the console and appended to `signals.jsonl` in the project root. With Telegram configured, BUY/SELL (and paper fills) are also sent to your chat.

## Strategy (v1)

EMA crossover + RSI filter, one virtual long per pair (`flat → long → flat`):

| Mode | Timeframe | EMA | RSI filter |
|------|-----------|-----|------------|
| `intraday` | 15m | 9 / 21 | BUY if RSI &lt; 70; SELL if RSI &gt; 30 |
| `swing` | 4h | 12 / 26 | same |

Paper fills are **simulated** (no on-chain fees, slippage, or MEV).

## Project layout

```
src/
  index.ts                 # CLI
  config.ts                # zod + env
  types.ts
  market/gecko-terminal.ts
  jupiter/client.ts
  strategy/indicators.ts   # hand-rolled EMA/RSI
  strategy/ema-rsi.ts
  paper/portfolio.ts
  notify/console.ts
  notify/telegram.ts       # optional grammY outbound alerts
  engine/watch.ts
```
