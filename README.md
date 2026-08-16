# Speculator

TypeScript CLI bot for Solana swing / intraday **trade recommendations** (`BUY` / `SELL` / `HOLD`).

- **OHLCV:** GeckoTerminal (candles for EMA/RSI)
- **Spot / paper fills:** Jupiter Swap quote API (`/swap/v1/quote`)
- **Backtest:** offline candle replay with emulated Jupiter-like slippage, pool fee, and Solana priority fee
- **v1 scope:** signals + optional paper portfolio + backtest (no live swaps)

See [AGENTS.md](./AGENTS.md) for contributor/agent conventions.

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

| Variable             | Meaning                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `STRATEGY`           | `intraday` / `swing` (EMA trend) or `bollinger` (4h BB flat mean-reversion) |
| `JUPITER_API_KEY`    | From [portal.jup.ag](https://portal.jup.ag/) — recommended                  |
| `WATCHLIST`          | `BASE/QUOTE` pairs resolved via `solana.tokens` (default `SOL/USDC`)        |
| `POLL_INTERVAL_MS`   | Poll interval (default `60000`)                                             |
| `PAPER_CASH_USDC`    | Starting virtual USDC for paper mode (when no paper rows in DuckDB)         |
| `TELEGRAM_BOT_TOKEN` | Optional bot token from [@BotFather](https://t.me/BotFather)                |
| `TELEGRAM_CHAT_ID`   | Optional chat id for alerts and commands                                    |

Mode is selected by CLI: `pnpm watch` (signals only) or `pnpm paper` (signals + virtual portfolio).

### Telegram (optional)

Set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to enable Telegram via [grammY](https://grammy.dev/). You get outbound alerts for **BUY/SELL** signals and paper fills (**HOLD** stays console/DuckDB only), plus inbound commands from the configured chat:

| Command      | Reply                                     |
| ------------ | ----------------------------------------- |
| `/start`     | Greeting and command list                 |
| `/report`    | Last signal per pair (including HOLD)     |
| `/chart`     | OHLCV candle chart with EMA/RSI           |
| `/portfolio` | Current paper portfolio (paper mode only) |

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

Day-to-day development uses `tsx` (no build required for `watch` / `paper` / `backtest`). Strict compile settings live in `tsconfig.json` (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, …) and `eslint.config.js` (typescript-eslint recommendedTypeChecked).

## Run

Recommendations only (forces signal mode):

```bash
pnpm watch
```

Paper trading (virtual long-only portfolio, simulated fills from Jupiter quotes):

```bash
pnpm paper
```

Offline backtest (replay cached/fetched GeckoTerminal OHLCV with emulated fill costs):

```bash
pnpm backtest
pnpm backtest -- --days 14
pnpm backtest -- --from 01-01-2026 --to 01-08-2026
pnpm backtest -- --from 2026-01-01 --to 2026-08-01 --force-refresh
```

| Flag              | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `--days <n>`      | Lookback window (default **30** for intraday, **90** for swing/bollinger) |
| `--from <date>`   | Range start (`YYYY-MM-DD` or `DD-MM-YYYY`, UTC midnight)                  |
| `--to <date>`     | Range end inclusive (same formats; default **now**; requires `--from`)    |
| `--force-refresh` | Delete cached OHLCV rows for the pair and refetch from GeckoTerminal      |

Use either `--days` or `--from`/`--to`, not both.

OHLCV candles are stored in **`data/speculator.duckdb`** (DuckDB, `candles` table) and reused on later runs. Fills use candle **close** as mid, then apply adverse costs (not live Jupiter):

| Pair tier           | Slippage | Pool fee | Priority fee                |
| ------------------- | -------- | -------- | --------------------------- |
| Liquid (`SOL/USDC`) | 0.30%    | 0.25%    | 0.0001 SOL → USDC via close |
| Meme (future pairs) | 2.0%     | 0.30%    | same                        |

The report prints equity, return, win rate, max drawdown, cost totals, and each simulated trade. Backtest never writes paper portfolio state to DuckDB.

Single iteration (smoke test):

```bash
pnpm exec tsx src/index.ts watch --once
pnpm exec tsx src/index.ts paper --once
```

Signals are printed to the console and stored in the `signals` table in **`data/speculator.duckdb`**. Paper mode also persists cash, position, P&L, and trades there (`paper.portfolios` / `paper.trades`; restored on restart). To reset paper to `PAPER_CASH_USDC`, delete those rows (or the DuckDB file). Mint/pool/decimals metadata for watchlist pairs comes from `solana.tokens` (seeded with SOL/USDC on first open). With Telegram configured, BUY/SELL (and paper fills) are also sent to your chat, and you can query `/report`, `/chart`, and `/portfolio` from that chat.

## Deploy (Ubuntu VPS + systemd)

Run paper mode as a supervised service using [deploy/speculator.service](./deploy/speculator.service). Logs go to **journald**; signal history and paper portfolio state live in `data/speculator.duckdb` under the app directory.

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

The unit defaults to **`pnpm paper`**. For signals only, change `ExecStart` to `/usr/bin/pnpm watch`.

### Alternative: runtime install under `/opt/speculator`

Install a production layout (`dist/` + prod `node_modules`) instead of running from a full source clone. After install, edit secrets once:

```bash
sudo nano /opt/speculator/.env
sudo chmod 600 /opt/speculator/.env
```

Both methods copy `dist/`, `package.json`, `pnpm-lock.yaml`, `.env.example`, run `pnpm install --prod`, and **preserve** an existing `.env` and `data/speculator.duckdb`.

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
  node_modules/
  package.json
  pnpm-lock.yaml
  .env
  data/
    speculator.duckdb
```

### 4. Monitor logs

```bash
# Follow live ticks, fills, and errors
journalctl -u speculator -f

# Recent history
journalctl -u speculator --since "1 hour ago"

# DuckDB state (WorkingDirectory)
ls -la /opt/speculator/data/speculator.duckdb

# Inspect paper / tokens / signals (example)
duckdb /opt/speculator/data/speculator.duckdb \
  "SELECT pair, cash_usdc, position_side FROM paper.portfolios;"
duckdb /opt/speculator/data/speculator.duckdb \
  "SELECT symbol, mint, decimals, pool_address FROM solana.tokens;"
duckdb /opt/speculator/data/speculator.duckdb \
  "SELECT \"at\", pair, side, price FROM signals ORDER BY \"at\" DESC LIMIT 20;"
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
ssh user@vps.example.com 'sudo systemctl restart speculator'
```

Change `/opt/speculator` if you use another runtime path.

Useful controls: `sudo systemctl stop speculator` · `sudo systemctl restart speculator` · `sudo systemctl disable speculator`.

## Strategy (v1)

ATR stop/trail and cooldown via `SimpleRiskManager`. One virtual long per pair (`flat → long → flat`).

### EMA trend (`intraday` / `swing`)

EMA crossover + RSI band + trend EMA + ADX regime filter:

| Mode       | Timeframe | EMA     | Entry filters                                | ATR stop/trail | Cooldown |
| ---------- | --------- | ------- | -------------------------------------------- | -------------- | -------- |
| `intraday` | 15m       | 9 / 21  | RSI `[40, 60)`; close &gt; EMA 100; ADX ≥ 25 | 3.5× / 4.5×    | 12 bars  |
| `swing`    | 4h        | 12 / 26 | RSI `[40, 60)`; close &gt; EMA 50; ADX ≥ 20  | 2× / 2.5×      | 2 bars   |

Exits: bearish EMA cross with RSI &gt; 45, or ATR(14) hard / trailing stop from peak close. ADX does **not** block exits. Discretionary cross-SELL respects `minHoldBars` (4 intraday / 1 swing); protective stops still fire immediately.

### Bollinger flat (`bollinger`)

Mean-reversion for ranging markets (4h, BB period 20, stdDev 2). Buys only on **lower-band reclaim** with filters:

| Mode        | Entry                                                                | Exit                         | ATR stop/trail | Cooldown | minHold |
| ----------- | -------------------------------------------------------------------- | ---------------------------- | -------------- | -------- | ------- |
| `bollinger` | reclaim lower; ADX ≤ 15; close &gt; EMA 50; (mid−lower)/close ≥ 1.5% | close ≥ BB mid (SMA), or ATR | 2.5× / 3×      | 4 bars   | 1 bar   |

`/chart` draws Bollinger mid/upper/lower for this mode (EMA/RSI chart for trend modes).

Paper fills are **simulated** (no on-chain fees, slippage, or MEV). Backtest fills use emulated Jupiter-like costs on candle close (or stop level for ATR exits).

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
  db/                      # DuckDB: candles, paper, signals
  market/gecko-terminal.ts
  exchange/jupiter.ts      # live Exchange (Jupiter quote only)
  exchange/emulated-*.ts   # backtest fill model + EmulatedExchange
  risk/risk-manager.ts     # SimpleRiskManager + RiskParams (ATR/cooldown)
  strategy/indicators.ts   # hand-rolled EMA/RSI/ATR/ADX/Bollinger
  strategy/ema-rsi.ts
  strategy/bollinger.ts
  strategy/strategy.ts     # Swing / Intraday / Bollinger (+ getRiskParams)
  strategy/ohlcv-svg.ts    # EMA/RSI SVG for /chart
  strategy/bollinger-svg.ts # BB SVG for /chart
  chart/render-png.ts      # SVG → PNG (@resvg/resvg-js)
  paper/portfolio.ts
  paper/store.ts           # paper load/save (DuckDB)
  notify/console.ts
  notify/telegram.ts       # optional grammY alerts + /start /report /chart /portfolio
  engine/watch.ts
  engine/backtest.ts
```
