# Speculator

TypeScript CLI bot for Solana **trade recommendations** (`BUY` / `SELL` / `HOLD`).

- **OHLCV:** GeckoTerminal, Birdeye pair candles, or Binance spot klines (`CANDLE_SOURCE`, default gecko-terminal)
- **Spot / paper fills:** Jupiter Swap quote API (`/swap/v1/quote`)
- **Live trades:** Jupiter Swap API V2 (`/swap/v2/order` + `/swap/v2/execute`) signed with a Solana CLI keypair
- **Backtest:** offline candle replay with emulated Jupiter-like slippage, pool fee, and Solana priority fee

See [AGENTS.md](./AGENTS.md) for contributor/agent conventions.

## Requirements

- **Node.js ≥24** (24 Active LTS recommended)
- **pnpm** 10+ (Corepack recommended)
- **Docker** (local Timescale via Compose; `pnpm test` database tests use Testcontainers)

```bash
corepack enable
corepack prepare pnpm@10.14.0 --activate
```

## Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm migrate
```

Edit `.env`:

| Variable                              | Meaning                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `STRATEGY`                            | `strategy.registry` id. Implementation is `src/strategy/mode/<id>/index.ts`           |
| `CANDLE_SOURCE`                       | OHLCV vendor: `gecko-terminal` (default), `binance`, or `birdeye`                     |
| `BIRDEYE_API_KEY`                     | Required when `CANDLE_SOURCE=birdeye`. Pair OHLCV for the selected pool               |
| `MODE`                                | Engine for `pnpm start`: `watch` \| `paper` \| `trade` (default `paper`)              |
| `BOT_ID`                              | Unique id for this process (isolates paper/live ledgers and signals)                  |
| `DATABASE_URL`                        | TimescaleDB connection URI (required)                                                 |
| `DATABASE_POOL_MAX`                   | pg.Pool max clients (default `2`)                                                     |
| `DATABASE_POOL_MIN`                   | pg.Pool min clients (default `0`)                                                     |
| `DATABASE_POOL_IDLE_TIMEOUT_MS`       | Close idle clients after this many ms (default `15000`)                               |
| `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | Fail connect after this many ms (default `30000`)                                     |
| `PGAPPNAME`                           | Postgres `application_name` (default `speculator/<BOT_ID>`)                           |
| `JUPITER_API_KEY`                     | From [portal.jup.ag](https://portal.jup.ag/) — recommended                            |
| `WATCHLIST`                           | `BASE/QUOTE` pairs resolved via `solana.tokens` + `solana.pools` (default `SOL/USDC`) |
| `POLL_INTERVAL_MS`                    | Poll interval (default `60000`)                                                       |
| `PAPER_CASH_USDC`                     | Starting virtual USDC for paper mode (when this `BOT_ID` has no paper rows)           |
| `WALLET_KEYPAIR_PATH`                 | Solana CLI JSON keypair — **required for `pnpm trade`**. Keep outside the repo        |
| `SOLANA_RPC_URL`                      | RPC for live balance reads (default public mainnet; use a dedicated RPC)              |
| `SLIPPAGE_BPS`                        | Jupiter swap slippage (default `50`)                                                  |
| `SOL_RESERVE_MIN`                     | Refill native SOL when below this (default `0.03`)                                    |
| `SOL_RESERVE_MAX`                     | Target after refill; SOL below this is not sold (default `0.05`)                      |
| `TELEGRAM_BOT_TOKEN`                  | Optional bot token from [@BotFather](https://t.me/BotFather)                          |
| `TELEGRAM_CHAT_ID`                    | Optional chat id for alerts and commands                                              |
| `TELEGRAM_ALLOWED_USER_ID`            | Mini App allowlist (defaults to `TELEGRAM_CHAT_ID`)                                   |
| `WEB_LISTEN`                          | Mini App listen addr (default `127.0.0.1:8787`)                                       |
| `WEB_STATIC_DIR`                      | SPA directory (default `web/dist`)                                                    |

Set `MODE` in `.env` (`watch` | `paper` | `trade`), then:

```bash
pnpm start
```

Explicit commands still override `MODE`: `pnpm watch`, `pnpm paper`, `pnpm trade`, `pnpm wallet` (live portfolio snapshot), `pnpm positions` (open or close the live long or short), `pnpm strategy` (assign instances to this bot).

### Telegram (optional)

Set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to enable Telegram via [grammY](https://grammy.dev/). You get outbound alerts for **BUY/SELL** signals and paper fills (**HOLD** stays console/Timescale only), plus inbound commands from the configured chat:

| Command      | Reply                                     |
| ------------ | ----------------------------------------- |
| `/start`     | Greeting and command list                 |
| `/report`    | Last signal per pair (including HOLD)     |
| `/chart`     | OHLCV candle chart with strategy overlays |
| `/portfolio` | Current paper or live portfolio           |

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Message your bot once, then get your chat id (e.g. via [@userinfobot](https://t.me/userinfobot)).
3. Put both values in `.env`.

### Telegram Mini App (optional)

Read-only UI served by a separate Rust HTTP process (`server/`) and React SPA (`web/`). The Mini App opens on the latest strategy signal; portfolio is a second tab.

| Endpoint                              | Auth                            | Purpose                                  |
| ------------------------------------- | ------------------------------- | ---------------------------------------- |
| `GET /api/health`                     | none                            | Liveness                                 |
| `GET /api/signal`                     | `Authorization: tma <initData>` | Newest `market.signals` row for `BOT_ID` |
| `GET /api/portfolio?mode=paper\|live` | `Authorization: tma <initData>` | Portfolio snapshot for `BOT_ID`          |

Local development:

```bash
pnpm web:build          # or pnpm web:dev (Vite proxies /api → :8787)
pnpm server:dev         # listens on WEB_LISTEN (default 127.0.0.1:8787)
```

Required for the web server: `DATABASE_URL`, `BOT_ID`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOWED_USER_ID` (or `TELEGRAM_CHAT_ID` for a private chat). Point BotFather’s Mini App / menu button URL at your public origin. Opening the SPA in a normal browser shows an “Open from Telegram” page (no API calls).

Production unit: [deploy/miniapp.service](./deploy/miniapp.service) (`User=miniapp`, `Group=speculator`, binary `bin/server`, static files `web/dist`).

## Build

Typecheck + type-aware ESLint (zero warnings allowed) + Prettier check + tests + `web` check:

```bash
pnpm check
```

Or separately:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm web:check
```

Compile to `dist/`:

```bash
pnpm build
```

Day-to-day development uses `tsx` (no build required for `watch` / `paper` / `trade` / `backtest`). Strict compile settings live in `tsconfig.base.json` / `tsconfig.json` (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, …) and `eslint.config.js` (typescript-eslint recommendedTypeChecked). The Mini App (`web/`) shares the same base tsconfig flags, ESLint rules, and Prettier config (`pnpm web:check`).

## Run

Engine from `MODE` in `.env` (default `paper`):

```bash
pnpm start
```

Recommendations only (forces signal mode):

```bash
pnpm watch
```

Paper trading (virtual long-only portfolio, simulated fills from Jupiter quotes):

```bash
pnpm paper
```

Live trading (on-chain Jupiter swaps; spends real tokens):

```bash
pnpm trade
```

Requires `WALLET_KEYPAIR_PATH` pointing at a Solana CLI JSON keypair **outside this repo**. When the position is flat and native SOL is below `SOL_RESERVE_MIN`, the bot buys SOL up to `SOL_RESERVE_MAX`. Other swaps abort below the minimum so the wallet can still pay fees. For `SOL/USDC`, only SOL above `SOL_RESERVE_MAX` is treated as a tradable long. Fills are labeled **LIVE** (not simulated) and stored in `bot.virtual_accounts`, `bot.positions`, and `bot.trades` (`mode=live`) with the transaction signature. A SOL reserve top-up is not stored as a strategy trade.

Print on-chain live portfolio (sync + snapshot, no swaps). Each pair includes native SOL. When native SOL is below `SOL_RESERVE_MIN`, the report warns with the shortfall up to `SOL_RESERVE_MAX`.

```bash
pnpm wallet
pnpm wallet -- --buy-sol
```

`--buy-sol` swaps the first `WATCHLIST` pair's quote into SOL to clear that shortfall, then prints the portfolio.

Export the Phantom-importable private key from `WALLET_KEYPAIR_PATH` (stdout — treat as highly sensitive). A Solana CLI keypair has no recoverable Phantom seed phrase; import via **Import Private Key** in Phantom.

```bash
pnpm wallet export
```

Open or close the live position on the first `WATCHLIST` pair through `JupiterExchange`. Longs are spot swaps. Shorts are Jupiter Perps. Opens spend that many USDC. Closes exit the whole position. Each fill is a **LIVE** transaction.

```bash
pnpm positions list
pnpm positions open long 10
pnpm positions close long
pnpm positions open short 10
pnpm positions close short
```

Assign strategy instances to this `BOT_ID`. `add` copies that module's default knobs, stores `jupiter` as the venue, and risks 2 percent. The first instance added becomes the selection (`strategy use` changes it). `set period=14` merges that knob. `--deposit` assigns an instance that has no deposit yet. `remove` refuses while the instance has an open position. Each book keeps that instance's cash and position, so two instances on one pair do not share a deposit. The risk manager sizes an open from that instance's risk percent. Backtest and tune still take `STRATEGY` until a later phase reads this selection.

```bash
pnpm strategy list
pnpm strategy add bollinger SOL/USDC --candle-source gecko-terminal --deposit 1000
pnpm strategy use 00000000-0000-4000-8000-000000000000
pnpm strategy set 00000000-0000-4000-8000-000000000000 period=14 --risk-percent 1
pnpm strategy remove 00000000-0000-4000-8000-000000000000
```

Offline backtest (replay cached/fetched OHLCV with emulated fill costs):

```bash
pnpm backtest
pnpm backtest -- --from 01-01-2026 --to 01-08-2026
pnpm backtest -- --from 2026-01-01 --to 2026-08-01
pnpm backtest -- --verbose
```

| Flag              | Meaning                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `--from <date>`   | Range start (`YYYY-MM-DD` or `DD-MM-YYYY`, UTC midnight)               |
| `--to <date>`     | Range end inclusive (same formats; default **now**; requires `--from`) |
| `--verbose`, `-v` | Print simulated trades and chart (default: metrics only)               |

Without `--from`/`--to`, lookback is **90** days from now.

OHLCV candles are stored in Timescale **`market.candles`** (hypertable, keyed by source, pool address, timeframe, and open time) and reused on later runs and by other processes sharing `DATABASE_URL`. Missing ranges are filled from `CANDLE_SOURCE` (default GeckoTerminal; `binance` uses spot klines; `birdeye` uses the Solana pool). Vendor fetches and Timescale reads/upserts retry on transient failures until the window is filled. Each bar is replayed as a **forming** candle (open → low → high → close on green bars, open → high → low → close on red) so signals see the same incomplete last bar as live. Fills use the intra-bar tick as mid, then apply adverse costs (not live Jupiter):

| Pair tier           | Slippage | Pool fee | Priority fee                |
| ------------------- | -------- | -------- | --------------------------- |
| Liquid (`SOL/USDC`) | 0.05%    | 0.04%    | 0.0001 SOL → USDC via close |
| Meme (future pairs) | 0.80%    | 0.25%    | same                        |

Short opens and covers skip the spot pool fee. They pay a perps schedule instead: open and close base fees plus hourly short borrow on entry notional for the time the short is open. Watch, paper, and trade load that schedule from [Jupiter pool-info](https://perps-api.jup.ag/v1/pool-info) (`openFeePercent`, `shortBorrowRatePercent`; close uses the same base rate) and reuse it for one hour. Backtest uses the offline snapshot (0.06% open, 0.06% close, 0.0007% per hour as of 2026-10-02) and does not call Jupiter. Price impact is not charged; pool-info only publishes its cap.

The report prints equity, return, buy-and-hold benchmark (same emulated round-trip costs), excess vs hold, long/short round-trip counts, win rate, max drawdown, and cost totals. Pass `--verbose` to also list each simulated trade and draw the console chart. Backtest never writes paper portfolio state.

Offline **tune** searches the active strategy's numeric knobs by anchored walk-forward. Candles load once. Each train window is a full factorial when it fits in `--max-trials`, otherwise a seeded Latin hypercube. The chosen set is the center of a stable neighborhood (median Sharpe of the set and its adjacent levels), then that single set is replayed on the next fold. The report compares the stitched out-of-sample track to today's defaults and does not rewrite them. The report says **Keep defaults** unless the search beats them on mean OOS Sharpe, compounds a positive OOS return, and is positive in at least two thirds of the test folds. Candles are read through a spike filter that clamps vendor wicks far beyond the candle body. See [TUNE.md](./TUNE.md) for methodology and how to judge a result.

```bash
pnpm tune
pnpm tune -- --days 180
pnpm tune -- --from 01-01-2026 --to 01-10-2026 --max-trials 48
```

| Flag                 | Meaning                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `--days <n>`         | Lookback from now (default **365**; not with `--from`)                    |
| `--from` / `--to`    | Same UTC dates as backtest                                                |
| `--strategy <name>`  | `strategy.registry` id (default: env `STRATEGY`)                          |
| `--folds <n>`        | Sequential folds, first is train-only (default **4**, minimum 2)          |
| `--max-trials <n>`   | Trials per train window before neighbor fill (default **96**)             |
| `--seed <n>`         | Latin-hypercube seed (default **1**)                                      |
| `--min-trades <n>`   | Reject a trial with fewer completed round-trips (default **8**)           |
| `--max-dd <pct>`     | Reject a trial whose max drawdown exceeds this percent (default **40**)   |
| `--min-return <pct>` | Reject a trial that returns at most this percent on train (default **0**) |
| `--min-pf <x>`       | Reject a trial below this profit factor on train (default **1.1**)        |
| `--jobs <n>`         | Replay workers (default: one per CPU; **1** runs on this thread)          |
| `--quotes 1m`        | Step each signal bar on real 1m closes (default: synthetic OHLC path)     |

Tune searches the numeric axes exported by the active strategy. The default replay uses the synthetic OHLC path. `--quotes 1m` uses the same minute-close fills as backtest.

Single iteration (smoke test):

```bash
pnpm exec tsx src/index.ts watch --once
pnpm exec tsx src/index.ts paper --once
pnpm exec tsx src/index.ts trade --once
```

Signals are printed to the console and stored in `market.signals`. Paper mode persists cash, position, P&L, and trades in `bot.virtual_accounts`, `bot.positions`, and `bot.trades` (`mode=paper`, scoped by `BOT_ID`; restored on restart). Live mode uses the same tables with `mode=live` (cash/size are synced from the wallet). To reset paper to `PAPER_CASH_USDC`, delete that bot's paper rows. Mint/decimals come from `solana.tokens`; Gecko pool addresses from `solana.pools` (seeded with SOL/USDC on `pnpm migrate`). With Telegram configured, BUY/SELL (and paper/live fills) are also sent to your chat, and you can query `/report`, `/chart`, and `/portfolio` from that chat.

## TimescaleDB

All engines share one remote TimescaleDB. Give each process a distinct `BOT_ID` so paper/live ledgers and signals do not overwrite each other. OHLCV in `market.candles` is global (not per bot).

```bash
docker compose up -d
pnpm migrate
pnpm paper
```

Apply schema with `pnpm migrate` ([dbmate](https://github.com/amacneil/dbmate) `up`, then [scripts/grant-privileges.sql](./scripts/grant-privileges.sql) as the `DATABASE_URL` role). A second run is a no-op for schema and reapplies grants. Engines do **not** auto-migrate; they exit if the database is behind the files in `migrations/`. The `DATABASE_URL` role must own the objects. Remote Timescale with a self-signed certificate needs `sslmode=no-verify` so the Node client uses TLS.

## Deploy (Ubuntu VPS + systemd)

Build on your machine and copy each process with [deploy/bot.sh](./deploy/bot.sh) and [deploy/miniapp.sh](./deploy/miniapp.sh). The bot script creates user **`bot`** (group **`speculator`**), installs [deploy/bot.service](./deploy/bot.service), and uploads `dist/`, `migrations/`, and prod `node_modules`. The Mini App script creates user **`miniapp`**, installs [deploy/miniapp.service](./deploy/miniapp.service), and uploads `web/dist` plus `bin/server`. Logs go to **journald**; signal history and paper portfolio state live in TimescaleDB (`DATABASE_URL`).

### 1. Host prerequisites

From your machine, install TimescaleDB on the VPS (PostgreSQL 18, role and database `speculator`):

```bash
SPECULATOR_PASSWORD='…' ./deploy/db.sh user@vps.example.com
```

PostgreSQL listens on `127.0.0.1`. The local app URL is written on the host at `/root/speculator-database-url`. For remote clients over TLS (`sslmode=require`, port 5432):

```bash
SPECULATOR_PASSWORD='…' SPECULATOR_DB_PUBLIC=1 ./deploy/db.sh user@vps.example.com
```

`SPECULATOR_DB_HOST` overrides the hostname stored for those clients (default: the SSH host). Schema is still applied with `pnpm migrate` after `.env` is in place, then [scripts/grant-privileges.sql](./scripts/grant-privileges.sql) as the object owner.

Also install Node ≥ 24, `pnpm`, and SSH sudo for the deploy user.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable
corepack prepare pnpm@10.14.0 --activate
which pnpm   # should be /usr/bin/pnpm (used by bot.service)
```

### 2. Deploy from your machine

Requires SSH access and `pnpm` on the host (bot only). Builds locally, then scp’s the runtime:

```bash
./deploy/bot.sh user@vps.example.com
./deploy/miniapp.sh user@vps.example.com
# or a custom path:
./deploy/bot.sh user@vps.example.com /opt/speculator
./deploy/miniapp.sh user@vps.example.com /opt/speculator
```

First time: copy `DATABASE_URL` from `/root/speculator-database-url` into the host env, migrate, then restart:

```bash
ssh user@vps.example.com
sudo nano /opt/speculator/.env
sudo chmod 640 /opt/speculator/.env
cd /opt/speculator && pnpm migrate
sudo systemctl restart bot miniapp
```

The units read `MODE` from `.env` (default **`paper`**). For signals only, set `MODE=watch`. Mini App listen address is `WEB_LISTEN` (default `127.0.0.1:8787`).

Runtime layout:

```text
/opt/speculator/
  dist/           # bot (User=bot)
  migrations/
  web/dist/       # Mini App SPA (User=miniapp)
  bin/server      # Mini App HTTP binary
  node_modules/
  package.json
  pnpm-lock.yaml
  .env
```

### 3. Monitor logs

```bash
journalctl -u bot -f
journalctl -u miniapp -f
journalctl -u bot --since "1 hour ago"

psql "$DATABASE_URL" -c "SELECT i.pair, a.cash_usdc, COALESCE(p.side, 'flat') AS position_side FROM bot.virtual_accounts a JOIN strategy.instances i ON i.id = a.strategy_id LEFT JOIN bot.positions p ON p.strategy_id = a.strategy_id AND p.bot_id = a.bot_id AND p.mode = a.mode WHERE a.mode = 'paper';"
psql "$DATABASE_URL" -c "SELECT symbol, mint, decimals FROM solana.tokens;"
psql "$DATABASE_URL" -c "SELECT address, base_mint, quote_mint FROM solana.pools;"
psql "$DATABASE_URL" -c "SELECT at, pair, side, price FROM market.signals ORDER BY at DESC LIMIT 20;"
```

### 4. Redeploy

```bash
./deploy/bot.sh user@vps.example.com /opt/speculator
./deploy/miniapp.sh user@vps.example.com /opt/speculator
```

Useful controls: `sudo systemctl stop bot` · `sudo systemctl restart miniapp` · `sudo systemctl disable bot`.

## Strategy

One position per pair: `long`, `short`, or `flat`.

The active strategy is `STRATEGY` or `--strategy`. That id must exist in `strategy.registry`. The implementation is `src/strategy/mode/<id>/index.ts`, which exports `strategyModule`. Adding a strategy is that folder, a test inside it, and `INSERT INTO strategy.registry (id, name, type)`. The directory name is the id. No other file lists strategy ids.

`SimpleStrategyManager` loads that id and an optional parameter patch. Each strategy evaluates only its own candles. `src/risk/risk-manager.ts` sizes the deposit from the instance risk percent and the book equity, and writes a tighter stop onto that book. Tune searches the axes that strategy exports. Defaults, filters, and the `/chart` overlay live in the strategy file.

Paper fills are **simulated** (no on-chain fees, slippage, or MEV). Live fills (`pnpm trade`) are real Jupiter swaps. Backtest fills use emulated Jupiter-like costs on intra-bar OHLC ticks (stop level for ATR exits).

## Project layout

```
deploy/
  bot.sh                   # build trading bot + scp to a remote host
  miniapp.sh               # build Mini App + scp to a remote host
  bot.service              # systemd unit (trading bot, User=bot)
  miniapp.service          # systemd unit (Mini App HTTP, User=miniapp)
web/                       # React + TypeScript + shadcn Mini App SPA
server/                    # Rust Axum HTTP API + static SPA
scripts/
  install-runtime.mjs      # copy bot runtime + pnpm install --prod to a path
src/
  index.ts                 # CLI
  config.ts                # zod + env
  types.ts
  db/                      # Timescale: migrate, candles, bot ledgers, tokens/pools, signals
  market/gecko/            # GeckoTerminalMarket; public entry index.ts
  market/binance/          # BinanceMarket spot klines; public entry index.ts
  market/birdeye/          # BirdeyeMarket pair OHLCV; public entry index.ts
  market/cached/           # CachedMarket (Timescale gap fill); public entry index.ts
  market/manager.ts        # createMarket(CandleSource)
  exchange/jupiter/        # spot long (Swap API V2) + perps short
  exchange/emulated/       # backtest fill model + EmulatedExchange
  risk/risk-manager.ts     # hard stop, deposit cap, and a tighter stop written onto the book
  strategy/indicators.ts   # hand-rolled EMA/RSI/Stochastic/ATR/ADX/DMI/Bollinger/Keltner/Donchian/SMA
  strategy/mode/           # one <id>/ package per strategy (index.ts exports strategyModule)
  strategy/strategy-manager.ts # discovers mode/<id>/index; loads id + optional param patch
  chart/render-png.ts      # SVG → PNG (@resvg/resvg-js)
  portfolio/paper/         # simulated cash book + Timescale mode=paper
  portfolio/live/          # on-chain cash/size + ledger
  portfolio/wallet/        # JSON keypair + RPC balances
  notify/console.ts
  notify/telegram.ts       # optional grammY alerts + /start /report /chart /portfolio
  engine/tick.ts           # shared paper/trade poll loop
  engine/watch.ts
  engine/paper.ts
  engine/trade.ts
  engine/wallet.ts         # one-shot live portfolio print / keypair export
  engine/backtest.ts
```
