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
# optional: copy an existing data/speculator.duckdb into Timescale
# pnpm import-duckdb
```

Edit `.env`:

| Variable               | Meaning                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `STRATEGY`             | `bollinger` (default) or `grid`                                                       |
| `HTF`                  | Higher-timeframe for StrategyManager: `4h` (default) or `1d`                          |
| `MODE`                 | Engine for `pnpm start`: `watch` \| `paper` \| `trade` (default `paper`)              |
| `BOT_ID`               | Unique id for this process (isolates paper/live ledgers and signals)                  |
| `DATABASE_URL`         | TimescaleDB connection URI (required)                                                 |
| `JUPITER_API_KEY`      | From [portal.jup.ag](https://portal.jup.ag/) — recommended                            |
| `WATCHLIST`            | `BASE/QUOTE` pairs resolved via `solana.tokens` + `solana.pools` (default `SOL/USDC`) |
| `POLL_INTERVAL_MS`     | Poll interval (default `60000`)                                                       |
| `PAPER_CASH_USDC`      | Starting virtual USDC for paper mode (when this `BOT_ID` has no paper rows)           |
| `WALLET_KEYPAIR_PATH`  | Solana CLI JSON keypair — **required for `pnpm trade`**. Keep outside the repo        |
| `SOLANA_RPC_URL`       | RPC for live balance reads (default public mainnet; use a dedicated RPC)              |
| `SLIPPAGE_BPS`         | Jupiter swap slippage (default `50`)                                                  |
| `LIVE_SOL_RESERVE_SOL` | Native SOL to keep for fees; not sold (default `0.05`)                                |
| `TELEGRAM_BOT_TOKEN`   | Optional bot token from [@BotFather](https://t.me/BotFather)                          |
| `TELEGRAM_CHAT_ID`     | Optional chat id for alerts and commands                                              |

Set `MODE` in `.env` (`watch` | `paper` | `trade`), then:

```bash
pnpm start
```

Explicit commands still override `MODE`: `pnpm watch`, `pnpm paper`, `pnpm trade`, `pnpm wallet` (live portfolio snapshot).

### Telegram (optional)

Set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to enable Telegram via [grammY](https://grammy.dev/). You get outbound alerts for **BUY/SELL** signals and paper fills (**HOLD** stays console/Timescale only), plus inbound commands from the configured chat:

| Command      | Reply                                     |
| ------------ | ----------------------------------------- |
| `/start`     | Greeting and command list                 |
| `/report`    | Last signal per pair (including HOLD)     |
| `/market`    | HTF trend chart (EMA50/200, ADX, S/R)     |
| `/chart`     | OHLCV candle chart with strategy overlays |
| `/portfolio` | Current paper or live portfolio           |

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Message your bot once, then get your chat id (e.g. via [@userinfobot](https://t.me/userinfobot)).
3. Put both values in `.env`.

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

OHLCV candles are stored in Timescale **`market.candles`** (hypertable, keyed by pool address) and reused on later runs and by other processes sharing `DATABASE_URL`. Fills use candle **close** as mid, then apply adverse costs (not live Jupiter):

| Pair tier           | Slippage | Pool fee | Priority fee                |
| ------------------- | -------- | -------- | --------------------------- |
| Liquid (`SOL/USDC`) | 0.30%    | 0.25%    | 0.0001 SOL → USDC via close |
| Meme (future pairs) | 2.0%     | 0.30%    | same                        |

The report prints equity, return, buy-and-hold benchmark (same emulated round-trip costs), excess vs hold, win rate, max drawdown, cost totals, and each simulated trade. Backtest never writes paper portfolio state.

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
pnpm import-duckdb          # optional: copy data/speculator.duckdb (needs BOT_ID)
pnpm paper
```

Apply schema with `pnpm migrate` (advisory-locked; a second run skips versions already in `schema_migrations`). `pnpm import-duckdb` upserts tokens/pools/candles, inserts this `BOT_ID`'s signals (skipping duplicates), and replaces paper/live ledgers, so re-running does not duplicate rows. Engines do **not** auto-migrate; they exit if the database is behind the files in `migrations/`.

## Deploy (Ubuntu VPS + systemd)

Run paper mode as a supervised service using [deploy/speculator.service](./deploy/speculator.service). Logs go to **journald**; signal history and paper portfolio state live in TimescaleDB (`DATABASE_URL`).

### 1. Install runtime on the VPS

```bash
# Node 24 LTS (or any Node >= 24)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git

sudo corepack enable
corepack prepare pnpm@10.14.0 --activate
```

Confirm `pnpm` is on the path systemd will use (often `/usr/bin/pnpm`):

```bash
which pnpm
```

If it differs, edit `ExecStart=` in the unit file accordingly.

### 2. Clone and configure

```bash
git clone git@github.com:igor-filipenko/speculator.git ~/speculator
cd ~/speculator
pnpm install
cp .env.example .env
chmod 600 .env
nano .env   # set JUPITER_API_KEY (and optional Telegram vars)
```

Smoke-test once before enabling the service:

```bash
pnpm exec tsx src/index.ts paper --once
```

### 3. Install `speculator.service`

```bash
# Adjust User, Group, WorkingDirectory, EnvironmentFile, ExecStart paths
nano deploy/speculator.service

sudo cp deploy/speculator.service /etc/systemd/system/speculator.service
sudo systemctl daemon-reload
sudo systemctl enable --now speculator
sudo systemctl status speculator
```

The unit reads `MODE` from `.env` (default **`paper`**). For signals only, set `MODE=watch`.

### Alternative: runtime install under `/opt/speculator`

Install a production layout (`dist/` + prod `node_modules`) instead of running from a full source clone. After install, edit secrets once:

```bash
sudo nano /opt/speculator/.env
sudo chmod 600 /opt/speculator/.env
```

Both methods copy `dist/`, `migrations/`, `package.json`, `pnpm-lock.yaml`, `.env.example`, run `pnpm install --prod`, and **preserve** an existing `.env`. After deploy, run `pnpm migrate` (and `pnpm import-duckdb` once if you still have a DuckDB file) against the shared database.

#### A. From the VPS (git clone + `install-runtime`)

```bash
git clone git@github.com:igor-filipenko/speculator.git ~/speculator-src
cd ~/speculator-src
pnpm install
pnpm build
sudo pnpm install-runtime -- /opt/speculator
```

#### B. From your machine (no git on the VPS)

Requires SSH access and `pnpm` on the host. Builds locally, then scp’s the runtime and installs prod deps remotely:

```bash
./deploy/deploy.sh user@vps.example.com
# or a custom path:
./deploy/deploy.sh user@vps.example.com /opt/speculator
```

Point the service at that directory (see [deploy/speculator.service](./deploy/speculator.service)):

```ini
WorkingDirectory=/opt/speculator
EnvironmentFile=/opt/speculator/.env
ExecStart=/usr/bin/node /opt/speculator/dist/index.js paper
```

Runtime layout:

```text
/opt/speculator/
  dist/
  migrations/
  node_modules/
  package.json
  pnpm-lock.yaml
  .env
```

### 4. Monitor logs

```bash
# Follow live ticks, fills, and errors
journalctl -u speculator -f

# Recent history
journalctl -u speculator --since "1 hour ago"

# Inspect paper / tokens / signals (example)
psql "$DATABASE_URL" -c "SELECT pair, cash_usdc, position_side FROM bot.portfolios WHERE mode = 'paper';"
psql "$DATABASE_URL" -c "SELECT symbol, mint, decimals FROM solana.tokens;"
psql "$DATABASE_URL" -c "SELECT address, base_mint, quote_mint FROM solana.pools;"
psql "$DATABASE_URL" -c "SELECT at, pair, side, price FROM market.signals ORDER BY at DESC LIMIT 20;"
```

### 5. Redeploy

**From a source clone on the VPS:**

```bash
git pull && pnpm install && pnpm build && \
  sudo pnpm install-runtime -- /opt/speculator && \
  sudo systemctl restart speculator
```

**From your machine** (no git pull on the VPS):

```bash
./deploy/deploy.sh user@vps.example.com /opt/speculator
```

The script stops `speculator`, copies runtime files (including `migrations/`), then starts the service again.

Change `/opt/speculator` if you use another runtime path.

Useful controls: `sudo systemctl stop speculator` · `sudo systemctl restart speculator` · `sudo systemctl disable speculator`.

## Strategy (v1)

ATR stop/trail and cooldown via `GenericRiskManager`. One virtual long per pair (`flat → long → flat`).

`SimpleStrategyManager` computes **MarketIndicators** from HTF candles (`HTF`, default 4h): 200-EMA, 50-EMA, ADX, +DI/−DI, ATR, and clustered swing **support/resistance** (volume-weighted, within ~8 ATR of price). Trend is `bullish` when ADX ≥ 20, +DI > −DI, and `close > EMA50 > EMA200`; `bearish` is the mirror; mixed stack or weak ADX is `flat`; missing EMA warmup is `unknown`. HTF OHLCV is loaded via the Timescale candle cache on each poll; indicators are recomputed every tick. Telegram `/market` shows this as a candle chart (EMA50/200, S/R, ADX) and lists key levels in the caption. The **active strategy is still the env/CLI default**; the **risk manager follows HTF trend** (`bullish` / `flat` → `GenericRiskManager`, `bearish` / `unknown` → `HighRiskManager` which blocks new BUYs). A Telegram message is sent when the trend changes.

### Bollinger flat (`bollinger`)

Mean-reversion for ranging markets (15m, BB period 16, stdDev 1.5). Buys only on **lower-band reclaim** with filters:

| Mode        | Entry                                                                                 | Exit                         | ATR stop/trail | Cooldown | minHold |
| ----------- | ------------------------------------------------------------------------------------- | ---------------------------- | -------------- | -------- | ------- |
| `bollinger` | reclaim lower; RSI(14) &lt; 30; ADX ≤ 32; close &gt; EMA 50; (mid−lower)/close ≥ 0.4% | close ≥ BB mid (SMA), or ATR | 2× / 2.5×      | 4 bars   | 3 bars  |

`/chart` draws Bollinger mid/upper/lower plus RSI with the oversold line for this mode.

### Grid (`grid`)

ATR-spaced ladder on 15m. Buys the nearest level **reclaim** when ADX ≤ 30 and close is above trend EMA 20. Sells at entry + one grid spacing (needs portfolio snapshot). ATR stop/trail 2.5× / 3×, cooldown 1 bar.

Paper fills are **simulated** (no on-chain fees, slippage, or MEV). Live fills (`pnpm trade`) are real Jupiter swaps. Backtest fills use emulated Jupiter-like costs on candle close (or stop level for ATR exits).

## Project layout

```
deploy/
  deploy.sh                # build + scp runtime to a remote host
  speculator.service       # systemd unit template
scripts/
  install-runtime.mjs      # copy runtime + pnpm install --prod to a path
src/
  index.ts                 # CLI
  config.ts                # zod + env
  types.ts
  db/                      # Timescale: migrate, candles, bot ledgers, tokens/pools, signals
  market/gecko-terminal.ts
  market/htf.ts            # HTF EMA stack + DMI trend + S/R
  market/htf-indicators.ts # HTF MarketIndicators refresh (OHLCV cache)
  market/levels.ts         # swing-pivot S/R clusters
  exchange/jupiter.ts      # paper Exchange (Jupiter quote only)
  exchange/jupiter-swap.ts # live Swap API V2 order + execute
  exchange/wallet.ts       # JSON keypair + RPC balances
  exchange/emulated-*.ts   # backtest fill model + EmulatedExchange
  risk/risk-manager.ts     # GenericRiskManager + HighRiskManager + RiskParams (ATR/cooldown)
  strategy/indicators.ts   # hand-rolled EMA/RSI/ATR/ADX/DMI/Bollinger
  strategy/mode/bollinger.ts
  strategy/mode/grid.ts
  strategy/strategy-manager.ts # loadStrategy + HTF MarketIndicators; getActiveStrategy/RiskManager
  strategy/market-state-svg.ts # HTF candles + EMA50/200 + S/R + ADX for /market
  strategy/mode/bollinger-svg.ts # BB SVG for /chart
  strategy/mode/grid-svg.ts      # grid SVG for /chart
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
  engine/wallet.ts         # one-shot live portfolio print
  engine/backtest.ts
```
