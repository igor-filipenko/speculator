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

## Deploy (Ubuntu VPS + systemd)

Run paper mode as a supervised service using [deploy/speculator.service](./deploy/speculator.service). Logs go to **journald**; signal history is also written to `signals.jsonl` in the app directory.

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

### Alternative: clone the repo, then install runtime to `/opt/speculator`

Clone on the VPS, build, then use the custom `install-runtime` script (not `pnpm deploy`) to copy runtime files and install production deps:

```bash
git clone git@github.com:igor-filipenko/speculator.git ~/speculator-src
cd ~/speculator-src
pnpm install
pnpm build
sudo pnpm install-runtime -- /opt/speculator
# edit secrets once:
sudo nano /opt/speculator/.env
sudo chmod 600 /opt/speculator/.env
```

`pnpm install-runtime -- <path>` copies `dist/`, `package.json`, `pnpm-lock.yaml`, `.env.example`, runs `pnpm install --prod` in the target, and **preserves** an existing `.env` / `signals.jsonl`.

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
  signals.jsonl
```

### 4. Monitor logs

```bash
# Follow live ticks, fills, and errors
journalctl -u speculator -f

# Recent history
journalctl -u speculator --since "1 hour ago"

# JSONL signal history (WorkingDirectory)
tail -f /opt/speculator/signals.jsonl
```

### 5. Redeploy after `git pull` (one shot)

From the **source clone** on the VPS:

```bash
git pull && pnpm install && pnpm build && \
  sudo pnpm install-runtime -- /opt/speculator && \
  sudo systemctl restart speculator
```

Change `/opt/speculator` if you use another runtime path.

Useful controls: `sudo systemctl stop speculator` · `sudo systemctl restart speculator` · `sudo systemctl disable speculator`.

## Strategy (v1)

EMA crossover + RSI filter, one virtual long per pair (`flat → long → flat`):

| Mode | Timeframe | EMA | RSI filter |
|------|-----------|-----|------------|
| `intraday` | 15m | 9 / 21 | BUY if RSI &lt; 70; SELL if RSI &gt; 30 |
| `swing` | 4h | 12 / 26 | same |

Paper fills are **simulated** (no on-chain fees, slippage, or MEV).

## Project layout

```
deploy/
  speculator.service       # systemd unit template
scripts/
  install-runtime.mjs      # copy runtime + pnpm install --prod to a path
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
