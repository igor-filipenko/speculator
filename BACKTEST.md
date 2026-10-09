# Backtest Guide

Replay OHLCV candles through the active strategy with emulated Jupiter fills.  
Three analysis modes: plain backtest, Monte Carlo path sampling, and walk-forward validation.

---

## Quick start

```bash
# Last 30 days, metrics only
pnpm backtest

# Custom window, print trades + chart
pnpm backtest -- --from 01-09-2026 --to 30-09-2026 --verbose

# Different strategy
pnpm backtest -- --from 01-09-2026 --to 30-09-2026 --strategy donchian

# Force-refresh OHLCV cache from GeckoTerminal
pnpm backtest -- --from 01-09-2026 --to 30-09-2026 --force-refresh
```

---

## CLI flags

| Flag                 | Description                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- |
| `--from <date>`      | Range start. Formats: `YYYY-MM-DD` or `DD-MM-YYYY` (UTC)                            |
| `--to <date>`        | Range end inclusive (exclusive in code). Requires `--from`                          |
| `--strategy <name>`  | Override `STRATEGY` from `.env` (`bollinger` \| `donchian`)                         |
| `--force-refresh`    | Delete cached candles and re-fetch from GeckoTerminal                               |
| `--verbose` / `-v`   | Print every simulated fill + ASCII chart                                            |
| `--monte-carlo <n>`  | Run N additional replays with randomised intra-bar paths (≥ 1)                      |
| `--walk-forward <n>` | Split period into N sequential folds (≥ 2; mutually exclusive with `--monte-carlo`) |

---

## Output fields

```
=== Backtest SOL/USDC | bollinger (15m BB14×1.4 ADX32 RSI50 tStop2) ===
Candles: 2658 | 2026-09-01T00:00:00.000Z → 2026-09-30T23:45:01.000Z
Start: 100.00 USDC → End equity: 184.43 USDC (+84.43%)
Buy & hold: 114.42 USDC (+14.42%) | vs hold: +70.01 USDC (+70.01% pp)
Realized P&L: 84.4275 USDC | Trades: 584 (292 round-trips: 168 long, 124 short; win rate +92.47%)
Round-trip hold: min 3m | max 2d 8h | avg 37m
Max drawdown: 2.96% | duration: 2d 3h
Risk metrics — Sharpe: +28.37 | Sortino: +51.53 | Profit factor: 4.00
Simulated costs — slippage: 34.7892 | pool fees: 16.1122 | priority: 6.2229 | perps: 16.9952 USDC
```

| Field               | What it means                                                                  |
| ------------------- | ------------------------------------------------------------------------------ |
| **End equity**      | Portfolio value at last candle close                                           |
| **Buy & hold**      | Same capital deployed at first bar close, exited at last — same emulated costs |
| **vs hold**         | Strategy return minus B&H return (percentage points)                           |
| **win rate**        | Completed round-trips with positive P&L / total round-trips                    |
| **Round-trip hold** | Duration between open fill and close fill (min / max / avg)                    |
| **Max drawdown**    | Peak-to-trough drop from equity peak; `duration` = longest time below peak     |
| **Sharpe**          | Annualised Sharpe from per-bar returns (risk-free = 0)                         |
| **Sortino**         | Same but only penalises downside returns                                       |
| **Profit factor**   | Sum of winning P&L / \|sum of losing P&L\|; > 1.5 is acceptable, > 3 is strong |
| **Simulated costs** | Broken out: slippage + pool fee + Solana priority fee + Jupiter perps fee      |

---

## Intra-bar path

Each candle is walked as a sequence of 5 deterministic ticks:

- **Green candle** (`close ≥ open`): `Open → Low → Mid → High → Close`
- **Red candle** (`close < open`): `Open → High → Mid → Low → Close`

This is a **conservative** (pessimistic) ordering for long positions: the Low is visited before the High, so trailing stops can fire early before the price moves up. The base backtest result is therefore a lower bound on real-world performance.

---

## Monte Carlo (`--monte-carlo <n>`)

Reruns the same candle series N times with randomised intra-bar price orderings.  
Each run uses a deterministic seeded PRNG (Mulberry32, seed = run index), making results reproducible.

```bash
pnpm backtest -- --from 01-09-2026 --to 30-09-2026 --monte-carlo 200
```

```
Monte Carlo (200 runs, randomized intra-bar paths):
  Return     p5=+191.85%  p50=+211.83%  p95=+231.64%  mean=+212.44%
  Sharpe     p5= +37.23  p50= +39.38  p95= +40.94  mean= +39.24
  Max DD     p5=  +2.82%  p50=  +3.23%  p95=  +3.23%  mean=  +3.17%
  Profit fac p5=   5.40  p50=   6.53  p95=   7.07  mean=   6.35
```

### How to read

- **p50 (median)** — expected outcome under random intra-bar ordering
- **p5** — pessimistic scenario (5th percentile); if p5 < 0%, there exist path orderings where the strategy loses money
- **p95** — optimistic scenario
- **Gap between base and p50** — typically 2–3× for mean-reversion strategies; the deterministic path visits Low before High on green candles, so it is more pessimistic than average. Real performance likely falls between base and p50.

### Red flags

- `p5 < 0%` — strategy can go to a loss with unlucky intra-bar ordering
- `p95 − p5 > 100 pp` — high path-sensitivity; results are fragile
- `p50 >> base × 3` — strategy is unusually dependent on price ordering within bars

---

## Walk-forward validation (`--walk-forward <n>`)

Splits the full period into N sequential windows and runs an **independent** backtest on each (separate portfolio, starting from `PAPER_CASH_USDC`). Tests whether the strategy performs consistently across different market regimes.

```bash
pnpm backtest -- \
  --from 01-07-2026 --to 30-09-2026 \
  --strategy bollinger \
  --walk-forward 6
```

```
=== Walk-Forward SOL/USDC | bollinger (15m BB14×1.4 ADX32 RSI50 tStop2) ===
Period: 2026-07-01 → 2026-09-30 | 6 folds × ~1488 candles each

Fold  Period                   Candles     Return       vs B&H   Sharpe   Max DD     PF
   1  2026-07-01 → 2026-07-15     1488    +12.34%    +3.21% pp  +15.32    2.11%   2.45
   2  2026-07-16 → 2026-07-31     1488     +8.45%   -1.23% pp  +12.44    3.45%   1.89
   3  2026-08-01 → 2026-08-15     1488    +38.67%   -2.10% pp  +16.39    3.87%   2.53
   4  2026-08-16 → 2026-08-31     1488    +25.43%   +10.21% pp  +22.17   2.45%   3.12
   5  2026-09-01 → 2026-09-14     1329    +41.23%   +27.11% pp  +30.44   1.99%   4.51
   6  2026-09-15 → 2026-09-30     1329    +19.23%   +14.21% pp  +22.47   2.45%   3.78
─────────────────────────────────────────────────────────────────────────────────────────
 OOS  6-fold compound             8712   +233.17%   +52.34% pp  +19.87   3.87%   3.06

Consistency: 5/6 folds beat B&H | 6/6 positive returns | Worst: fold 2 (-1.23% pp vs B&H)
```

### How to read

| Column                   | Meaning                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| **Return**               | Strategy return for that fold only (independent portfolio)             |
| **vs B&H**               | Strategy return minus B&H for **that fold's sub-period** (pp)          |
| **Sharpe / Max DD / PF** | Per-fold values                                                        |
| **OOS compound**         | `(1+r₁) × (1+r₂) × … × (1+rₙ) − 1` as if reinvesting capital each fold |
| **OOS vs B&H**           | OOS compound return minus B&H for the **full period**                  |
| **OOS Sharpe**           | Arithmetic mean of fold Sharpes (approximation)                        |
| **OOS Max DD**           | Maximum of fold max DDs (lower bound — portfolios reset between folds) |
| **OOS PF**               | Arithmetic mean of fold profit factors                                 |

### Consistency line

```
Consistency: 5/6 folds beat B&H | 6/6 positive returns | Worst: fold 2 (−1.23% pp vs B&H)
```

- **N/N beat B&H** — how many folds outperformed passive holding
- **N/N positive** — how many folds had a positive return
- **Worst fold** — identifies which sub-period was weakest and by how much

### Technical note

HTF (4h) and MTF (1h) candles span the **full window** and are shared across all folds. `syncMarketIndicators` uses `atTime` filtering, so fold 3 sees HTF history from folds 1 and 2 — matching live behaviour where indicators are built from all available history.

---

## Full analysis workflow

### Step 1 — Baseline backtest

```bash
pnpm backtest -- --from 01-09-2026 --to 30-09-2026 --verbose
```

Check:

- `vs B&H` positive?
- `avg hold` > 15 minutes? (shorter → transaction costs dominate in live trading)
- `Profit factor` > 1.5?
- `win rate` < 90%? (higher → suspiciously over-fitted or very specific regime)

### Step 2 — Monte Carlo (path uncertainty)

```bash
pnpm backtest -- --from 01-09-2026 --to 30-09-2026 --monte-carlo 200
```

Check:

- `p5 Return` > 0%?
- Ratio `p50 / base` < 3×? (larger → high path dependence)
- `p95 − p5` range reasonable (< 100 pp for monthly period)?

### Step 3 — Walk-forward (temporal consistency)

```bash
pnpm backtest -- --from 01-07-2026 --to 30-09-2026 --walk-forward 6
```

Check:

- `≥ 4/6 folds beat B&H` (≥ 67%)?
- `6/6 positive returns`?
- Look at the worst fold — which market regime caused it?

### Step 4 — Cross-strategy comparison

```bash
pnpm backtest -- --from 01-07-2026 --to 30-09-2026 --strategy bollinger --walk-forward 6
pnpm backtest -- --from 01-07-2026 --to 30-09-2026 --strategy donchian --walk-forward 6
```

Compare by `N/N folds beat B&H`, not by total return. Total return can be inflated by a single lucky fold.

### Step 5 — HTF sensitivity

```bash
pnpm backtest -- --from 01-07-2026 --to 30-09-2026 --walk-forward 6
HTF=1d pnpm backtest -- --from 01-07-2026 --to 30-09-2026 --walk-forward 6
```

If results differ substantially between `HTF=4h` and `HTF=1d`, the strategy is sensitive to the trend filter — lower confidence.

---

## Pre-live checklist

```
□ walk-forward (≥ 6 folds): ≥ 4/6 beat B&H, all folds positive
□ Profit factor (base) > 1.5
□ Max drawdown < 10%
□ Monte Carlo p5 (Return) > 0%
□ avg hold > 15 minutes
□ Tested on a trending period AND a ranging period — at least one good result
□ Simulated costs < 30% of gross profit (check "Simulated costs" total)
```

---

## Caveats

- **Deterministic path is pessimistic for longs**: base return is a lower bound; real performance is between base and Monte Carlo p50.
- **Win rate > 90%** suggests either a very specific period or overfitting. Test across more months.
- **Sharpe > 10** is unrealistically high for real markets — it reflects the smooth bar-level returns of a high-frequency strategy, not true risk-adjusted performance.
- **Walk-forward uses fixed parameters**: it tests temporal consistency of the current `.env` settings, not parameter optimisation. It is an honest out-of-sample test only if parameters were not already tuned on the same window.
- **1 month of data** is statistically insufficient for robust conclusions. Use at least 3 months with 6+ walk-forward folds.
- **No slippage on HTF candles**: the market indicators (ADX, EMA trend, ATR) are computed from cached candles, not live quotes — their accuracy depends on GeckoTerminal data quality.
