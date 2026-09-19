# Speculator

TypeScript CLI bot for Solana **trade recommendations** (`BUY` / `SELL` / `HOLD`).

- **OHLCV:** GeckoTerminal (candles for Bollinger / Grid)
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
| `STRATEGY`                            | `bollinger` (default), `grid`, or `donchian`                                          |
| `HTF`                                 | Higher-timeframe for trend / S/R: `4h` (default) or `1d`. Volatility is always 1h.    |
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
| `LIVE_SOL_RESERVE_SOL`                | Native SOL to keep for fees; not sold (default `0.05`)                                |
| `TELEGRAM_BOT_TOKEN`                  | Optional bot token from [@BotFather](https://t.me/BotFather)                          |
| `TELEGRAM_CHAT_ID`                    | Optional chat id for alerts and commands                                              |
| `TELEGRAM_ALLOWED_USER_ID`            | Mini App allowlist (defaults to `TELEGRAM_CHAT_ID`)                                   |
| `WEB_LISTEN`                          | Mini App listen addr (default `127.0.0.1:8787`)                                       |
| `WEB_STATIC_DIR`                      | SPA directory (default `web/dist`)                                                    |

Set `MODE` in `.env` (`watch` | `paper` | `trade`), then:

```bash
pnpm start
```

Explicit commands still override `MODE`: `pnpm watch`, `pnpm paper`, `pnpm trade`, `pnpm wallet` (live portfolio snapshot).

### Telegram (optional)

Set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to enable Telegram via [grammY](https://grammy.dev/). You get outbound alerts for **BUY/SELL** signals and paper fills (**HOLD** stays console/Timescale only), plus inbound commands from the configured chat:

| Command      | Reply                                                    |
| ------------ | -------------------------------------------------------- |
| `/start`     | Greeting and command list                                |
| `/report`    | Last signal per pair (including HOLD)                    |
| `/market`    | HTF trend chart (EMA50/200, ADX, S/R) plus 1h volatility |
| `/chart`     | OHLCV candle chart with strategy overlays                |
| `/portfolio` | Current paper or live portfolio                          |

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Message your bot once, then get your chat id (e.g. via [@userinfobot](https://t.me/userinfobot)).
3. Put both values in `.env`.

### Telegram Mini App (optional)

Read-only portfolio UI served by a separate Rust HTTP process (`server/`) and React SPA (`web/`).

| Endpoint                              | Auth                            | Purpose                         |
| ------------------------------------- | ------------------------------- | ------------------------------- |
| `GET /api/health`                     | none                            | Liveness                        |
| `GET /api/portfolio?mode=paper\|live` | `Authorization: tma <initData>` | Portfolio snapshot for `BOT_ID` |

Local development:

```bash
pnpm web:build          # or pnpm web:dev (Vite proxies /api → :8787)
pnpm server:dev         # listens on WEB_LISTEN (default 127.0.0.1:8787)
```

Required for the web server: `DATABASE_URL`, `BOT_ID`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOWED_USER_ID` (or `TELEGRAM_CHAT_ID` for a private chat). Point BotFather’s Mini App / menu button URL at your public origin. Opening the SPA in a normal browser shows an “Open from Telegram” page (no API calls).

Production unit: [deploy/miniapp.service](./deploy/miniapp.service) (`User=miniapp`, `Group=speculator`, binary `bin/server`, static files `web/dist`).

## Build

Typecheck + type-aware ESLint (zero warnings allowed):

```bash
pnpm check
```

Or separately:

```bash
pnpm typecheck
pnpm lint
```

Compile to `dist/`:

```bash
pnpm build
```

Day-to-day development uses `tsx` (no build required for `watch` / `paper` / `trade` / `backtest`). Strict compile settings live in `tsconfig.json` (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, …) and `eslint.config.js` (typescript-eslint recommendedTypeChecked).

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

Requires `WALLET_KEYPAIR_PATH` pointing at a Solana CLI JSON keypair **outside this repo**. Native SOL below `LIVE_SOL_RESERVE_SOL` aborts swaps so the wallet can still pay fees. For `SOL/USDC`, only SOL above that reserve is treated as a tradable long. Fills are labeled **LIVE** (not simulated) and stored in `bot.portfolios` / `bot.trades` (`mode=live`) with the transaction signature.

Print on-chain live portfolio (sync + snapshot, no swaps):

```bash
pnpm wallet
```

Export the Phantom-importable private key from `WALLET_KEYPAIR_PATH` (stdout — treat as highly sensitive). A Solana CLI keypair has no recoverable Phantom seed phrase; import via **Import Private Key** in Phantom.

```bash
pnpm wallet export
```

Offline backtest (replay cached/fetched GeckoTerminal OHLCV with emulated fill costs):

```bash
pnpm backtest
pnpm backtest -- --days 14
pnpm backtest -- --from 01-01-2026 --to 01-08-2026
pnpm backtest -- --from 2026-01-01 --to 2026-08-01 --force-refresh
```

| Flag              | Meaning                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `--days <n>`      | Lookback window (default **90** days)                                  |
| `--from <date>`   | Range start (`YYYY-MM-DD` or `DD-MM-YYYY`, UTC midnight)               |
| `--to <date>`     | Range end inclusive (same formats; default **now**; requires `--from`) |
| `--force-refresh` | Delete cached OHLCV rows for the pair and refetch from GeckoTerminal   |
| `--ignore-trend`  | Do not evaluate/apply HTF market state (no MARKET logs, no trend risk) |

Use either `--days` or `--from`/`--to`, not both.

OHLCV candles are stored in Timescale **`market.candles`** (hypertable, keyed by pool address) and reused on later runs and by other processes sharing `DATABASE_URL`. Gecko page fetches and Timescale reads/upserts retry on transient failures (connection timeout, disconnect) until the window is filled. Fills use candle **close** as mid, then apply adverse costs (not live Jupiter):

| Pair tier           | Slippage | Pool fee | Priority fee                |
| ------------------- | -------- | -------- | --------------------------- |
| Liquid (`SOL/USDC`) | 0.30%    | 0.25%    | 0.0001 SOL → USDC via close |
| Meme (future pairs) | 2.0%     | 0.30%    | same                        |

The report prints equity, return, buy-and-hold benchmark (same emulated round-trip costs), excess vs hold, win rate, max drawdown, cost totals, and each simulated trade. Backtest never writes paper portfolio state.

Offline **regime** replay (same HTF 4h/1d + 1h close cadence as backtest, no fills). Prints every trend/volatility switch, which strategy/risk params would activate, time-in-regime, and a CLI candlestick chart with regime bands:

```bash
pnpm regime
pnpm regime -- --days 14
pnpm regime -- --from 01-01-2026 --to 01-08-2026
```

Same `--days` / `--from` / `--to` / `--force-refresh` flags as backtest. Strategy comes from env `STRATEGY`. Regime does not take `--ignore-trend` (market state is the whole point).

Single iteration (smoke test):

```bash
pnpm exec tsx src/index.ts watch --once
pnpm exec tsx src/index.ts paper --once
pnpm exec tsx src/index.ts trade --once
```

Signals are printed to the console and stored in `market.signals`. Paper mode persists cash, position, P&L, and trades in `bot.portfolios` / `bot.trades` (`mode=paper`, scoped by `BOT_ID`; restored on restart). Live mode uses the same tables with `mode=live` (cash/size are synced from the wallet). To reset paper to `PAPER_CASH_USDC`, delete that bot's paper rows. Mint/decimals come from `solana.tokens`; Gecko pool addresses from `solana.pools` (seeded with SOL/USDC on `pnpm migrate`). With Telegram configured, BUY/SELL (and paper/live fills) are also sent to your chat, and you can query `/report`, `/market`, `/chart`, and `/portfolio` from that chat.

## TimescaleDB

All engines share one remote TimescaleDB. Give each process a distinct `BOT_ID` so paper/live ledgers and signals do not overwrite each other. OHLCV in `market.candles` is global (not per bot).

```bash
docker compose up -d
pnpm migrate
pnpm paper
```

Apply schema with `pnpm migrate` ([dbmate](https://github.com/amacneil/dbmate) `up` via the package script; a second run is a no-op). Engines do **not** auto-migrate; they exit if the database is behind the files in `migrations/`.

## Deploy (Ubuntu VPS + systemd)

Build on your machine and copy each process with [deploy/bot.sh](./deploy/bot.sh) and [deploy/miniapp.sh](./deploy/miniapp.sh). The bot script creates user **`bot`** (group **`speculator`**), installs [deploy/bot.service](./deploy/bot.service), and uploads `dist/`, `migrations/`, and prod `node_modules`. The Mini App script creates user **`miniapp`**, installs [deploy/miniapp.service](./deploy/miniapp.service), and uploads `web/dist` plus `bin/server`. Logs go to **journald**; signal history and paper portfolio state live in TimescaleDB (`DATABASE_URL`).

### 1. Host prerequisites

On the VPS: Node ≥ 24, `pnpm`, and SSH sudo for the deploy user.

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

First time: edit secrets on the host, then migrate:

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

psql "$DATABASE_URL" -c "SELECT pair, cash_usdc, position_side FROM bot.portfolios WHERE mode = 'paper';"
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

## Strategy (v1)

ATR stop/trail and cooldown via `GenericRiskManager`. One virtual long per pair (`flat → long → flat`).

`SimpleStrategyManager` computes **MarketIndicators** from two timeframes. **HTF** candles (`HTF`, default 4h) supply 200-EMA, 50-EMA, ADX, +DI/−DI, ATR, clustered swing **support/resistance** (volume-weighted, within ~8 ATR of price), and **global trend**: `bullish` when ADX ≥ 20, +DI > −DI, and `close > EMA50 > EMA200`; `bearish` is the mirror; mixed stack or weak ADX is `flat`; missing EMA warmup is `unknown`. A new trend is published only after **2 consecutive HTF closes** agree (one-bar ADX/stack blips stay on the previous trend; the first label after `unknown` is immediate). **1h** candles supply **volatility**: TTM-style squeeze when Bollinger(20, 2) sits inside Keltner(20, 1.5×ATR); otherwise `high` if ATR% is above the **80th** percentile of the last 100 ATR% values (stays high until ATR% falls to the **60th** or below); else `low` (`unknown` until warm). A new vol label is published only after **2 consecutive 1h closes** agree. HTF and 1h OHLCV are loaded via the Timescale candle cache on each poll; indicators are recomputed every tick. Telegram `/market` shows the HTF candle chart (EMA50/200, S/R, ADX) and lists trend, 1h volatility, and key levels in the caption. The **active strategy is still the env/CLI default**; the **risk manager follows HTF trend** (`bullish` / `flat` → `GenericRiskManager`, `bearish` / `unknown` → `HighRiskManager` which blocks new BUYs). **Bollinger also switches to HighRiskManager when 1h volatility is `high`**, so it does not fade wide, noisy bands. A Telegram message is sent when the trend or volatility changes.

### Bollinger flat (`bollinger`)

Mean-reversion for ranging or bullish-dip markets (15m, BB period 14). **No new BUYs when HTF trend is bearish/unknown or 1h volatility is high** (exits at mid / ATR still fire). Buys on **lower-band reclaim** — same-bar wick (low ≤ lower, green close back inside) or prior close ≤ prior lower — with close still below mid:

| Regime            | Entry                                                                                        | Exit                                       | ATR stop/trail |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------- |
| bullish / low     | wick or close reclaim; RSI &lt; 48; ADX ≤ 32; (mid−lower)/close ≥ 0.35%; reclaim depth ≥ 15% | close ≥ BB mid **and** above entry + 0.20% | 2.5× / 3×      |
| bullish / squeeze | RSI &lt; 50; ADX ≤ 36; stdDev 1.4; reclaim depth ≥ 20%                                       | same                                       | 2.5× / 3×      |
| flat / low        | RSI &lt; 50; ADX ≤ 35; stdDev 1.5; reclaim depth ≥ 15%                                       | same                                       | 2.5× / 3×      |
| flat / squeeze    | RSI &lt; 45; ADX ≤ 28; stdDev 1.4; reclaim depth ≥ 20%                                       | same                                       | 2.5× / 3×      |
| bear or 1h high   | HOLD (no BUY)                                                                                | same                                       | regime ATR     |

Reclaim depth is `(close − lower) / (mid − lower)`. Cooldown 2 bars, minHold 1. `/chart` draws Bollinger mid/upper/lower plus RSI with the oversold line for this mode.

### Grid (`grid`)

ATR-spaced ladder on 15m. Buys the nearest level **reclaim** when HTF is bullish or flat, ADX is under the regime cap, and the reclaimed level is a **dip** (at/below the grid anchor **and** `dipAtrMult`–`maxDipAtrMult` × ATR below the recent high over `reanchorBars`; skips waterfalls deeper than 2×ATR). **Skips squeeze entries within `chaseAtrMult` (0.5×ATR) of the last take-profit**, **skips bullish/low entries within the same buffer of the last SELL**, and **skips a new long for `atrReentryBars` (96 = 24h) after an ATR stop/trail**. Sells at entry + one grid spacing, or earlier at the nearest HTF/1h resistance, or if HTF is not bullish and close falls back through the reclaimed level (capped at `failReclaimAtrMult` 0.75×ATR below entry). Grid lines clip to the S/R corridor (`max` nearest support, `min` nearest resistance). **Grid spacing and ADX cap follow HTF trend × 1h volatility** (bullish/high → ×8 and ADX 30; bullish/low → ×5 and ADX 22; flat/high → ×6 and ADX 22; flat/low or squeeze → ×5 and ADX 20; bearish → ×2). ATR stop is 3× in bullish, 1.5× otherwise; trail tightens to 6× in bullish high/squeeze, otherwise 8× (4× bearish). Cooldown 8 bars.

### Donchian breakout (`donchian`)

Trend-following channel breakout on 15m. **Buys only while HTF trend is bullish.** Entry is a close **crossing above the prior 20-bar high by at least 0.2–0.35×ATR**, with last volume above `k × SMA(volume)` of the previous 20 bars, close above trend EMA 50, and the **prior channel high above the last SELL fill** (skips throwbacks that only reclaim a local high). Sells when close **crosses below the prior 40-bar low** (55-bar in 1h squeeze) so a 5h dip does not dump a multi-day runner. Volume/EMA do not block exits. ATR stop/trail still apply. Flat/bearish/unknown HTF skip new BUYs (exits still fire).

**Volume SMA multiplier (bullish only):** high 1.2; low 1.5; squeeze 1.6.

ATR stop is 3× (2.5× flat, 2× bearish); trail 6× bullish high/squeeze, 8× bullish low, 5× flat, 3× bearish. Cooldown 96 bars (24h), minHold 16. `/chart` draws Donchian mid/upper/lower plus a volume pane with the SMA overlay.

Paper fills are **simulated** (no on-chain fees, slippage, or MEV). Live fills (`pnpm trade`) are real Jupiter swaps. Backtest fills use emulated Jupiter-like costs on candle close (or stop level for ATR exits).

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
  market/gecko-terminal.ts
  market/htf.ts            # HTF EMA stack + DMI trend + S/R; 1h squeeze/high/low vol
  market/htf-indicators.ts # HTF + 1h MarketIndicators refresh (OHLCV cache)
  market/levels.ts         # swing-pivot S/R clusters
  exchange/jupiter.ts      # paper Exchange (Jupiter quote only)
  exchange/jupiter-swap.ts # live Swap API V2 order + execute
  exchange/wallet.ts       # JSON keypair + RPC balances
  exchange/emulated-*.ts   # backtest fill model + EmulatedExchange
  risk/risk-manager.ts     # GenericRiskManager + HighRiskManager + RiskParams (ATR/cooldown)
  strategy/indicators.ts   # hand-rolled EMA/RSI/ATR/ADX/DMI/Bollinger/Keltner/Donchian/SMA
  strategy/mode/bollinger.ts
  strategy/mode/grid.ts
  strategy/mode/donchian.ts
  strategy/strategy-manager.ts # loadStrategy + HTF trend / 1h vol; getActiveStrategy/RiskManager
  strategy/market-state-svg.ts # HTF candles + EMA50/200 + S/R + ADX for /market
  strategy/mode/bollinger-svg.ts # BB SVG for /chart
  strategy/mode/grid-svg.ts      # grid SVG for /chart
  strategy/mode/donchian-svg.ts  # Donchian + volume SMA SVG for /chart
  chart/render-png.ts      # SVG → PNG (@resvg/resvg-js)
  paper/portfolio.ts
  paper/store.ts           # paper load/save (Timescale bot.* mode=paper)
  live/portfolio.ts        # on-chain cash/size + ledger
  notify/console.ts
  notify/telegram.ts       # optional grammY alerts + /start /report /market /chart /portfolio
  engine/tick.ts           # shared paper/trade poll loop
  engine/watch.ts
  engine/paper.ts
  engine/trade.ts
  engine/wallet.ts         # one-shot live portfolio print / keypair export
  engine/backtest.ts
```
