# Tuning strategy parameters with `pnpm tune`

This guide explains how `tune` works, how to run it, and how to decide whether a strategy has an edge or only fits the past. `tune` is offline. It never calls live Jupiter, never writes a portfolio, and never rewrites strategy defaults.

Flag reference lives in [README.md](./README.md). This file covers process and judgment.

## What tune does

`tune` answers one question: if I had picked parameters using only the past, how would they have done on the next unseen period?

1. **Load candles once** for the pair over the requested span (Timescale cache first, then the vendor set by `CANDLE_SOURCE`). Wicks far beyond the candle body are clamped on read, so vendor spikes do not fake profits.
2. **Split into equal chunks** and build anchored walk-forward folds. `N` chunks give `N - 1` folds. Fold `k` trains on every chunk before the test chunk, then tests on the next one. The first chunk is train-only.
3. **Sample the search space** on each train window. A full factorial runs when it fits in `--max-trials`, otherwise a seeded Latin hypercube. Each trial is a full backtest replay with emulated Jupiter fees and slippage.
4. **Gate trials.** A trial is feasible only if it passes all of: `--min-trades`, `--max-dd`, `--min-return`, `--min-pf`. Infeasible trials cannot win.
5. **Pick a stable winner, not the best point.** The winner is the feasible set with the best median Sharpe across itself and its one-step neighbors on the grid. A lone lucky spike has bad neighbors and loses. Neighbors of the top 3 leaders are scored extra so they can be judged.
6. **Replay that one set on the next fold** (out-of-sample, OOS). The same fold is also replayed with today's defaults as a baseline.
7. **Stitch the OOS folds** and report compounded return, mean Sharpe, positive-fold count, and a verdict.

Only the OOS numbers matter. In-sample (IS) numbers are always flattering.

## Running it

Use clean data. Binance candles are the cleanest source for SOL; Birdeye 15m has heavy spikes.

```bash
# Quick look (defaults: 365 days, 4 folds, 96 trials)
pnpm tune

# A serious run: 2 years, 6 folds, stricter gates, explicit seed
WATCHLIST=SOL/USDC CANDLE_SOURCE=binance pnpm tune -- \
  --from 2024-11-03 --to 2026-10-29 \
  --folds 6 --max-trials 200 --min-trades 30 --max-dd 20 --seed 1
```

Rules of thumb:

- **Span.** Use at least a year, preferably two, covering both up and down regimes. A fold shorter than about two months rarely holds enough trades.
- **Folds.** 5 to 6 folds. Fewer folds make the verdict coarse. More folds make each test window too short.
- **`--min-trades`.** Raise it until the winners have enough trades to mean something (about 30 on the train window for 15m/1h strategies). The default of 8 is a smoke-test value.
- **`--max-trials`.** More trials give a better map but more selection bias. The neighborhood winner rule helps, it does not remove the bias.
- **Seeds.** Run at least 3 seeds. Different seeds sample different points of the same space. If the verdict flips between seeds, the result is noise.
- **Long runs.** A 2-year, 200-trial run takes tens of minutes per seed. Launch it detached and read the log afterwards:

```bash
setsid nohup bash -c 'for s in 1 2 3; do
  WATCHLIST=SOL/USDC CANDLE_SOURCE=binance pnpm tune -- \
    --from 2024-11-03 --to 2026-10-29 --folds 6 --max-trials 200 \
    --min-trades 30 --max-dd 20 --seed $s > /tmp/tune_$s.log 2>&1
done' >/dev/null 2>&1 & disown
```

## Reading the report

Per fold:

```text
Fold 4 train 2024-11-03 → 2025-11-01 | test 2025-11-01 → 2026-03-02 (238 trials)
  selected: timeframe=15m period=14 stdDev=2.5 ...
  IS  sharpe 2.45 | return 11.68% | dd 4.12% | trades 36
  OOS sharpe 0.71 | return 0.85% | dd 1.60% | trades 10
  baseline OOS sharpe -3.52 | return -15.32% | dd 17.33% | trades 71
```

- `selected`: the neighborhood winner chosen on the train window.
- `IS`: how that set did on the data it was chosen on. Expect it to look great.
- `OOS`: the same set on the unseen next window. This is the honest number.
- `baseline`: today's defaults on the same test window.

Summary lines:

- `OOS compounded return: search X% | defaults Y%`: stitched track of all test windows.
- `Positive test folds: k/n`: how many test windows ended above zero.
- `Next params`: the last fold's winner. It is a candidate, not a recommendation.
- `Keep defaults: ...`: the tool's verdict with reasons.

### The verdict

`Keep defaults` is printed unless all three hold:

1. mean OOS Sharpe beats the defaults,
2. compounded OOS return is positive,
3. at least two thirds of the test folds are positive.

Read the wording carefully. `Keep defaults` means "do not trust the tuned set", not "the defaults are good". If the defaults lose money OOS, neither choice is deployable. Compare the `defaults` figures too.

## Is the strategy working?

Passing the verdict is the minimum, not proof. Treat a strategy as working only if the following all hold. The first three are enforced by the verdict, the rest are manual checks.

1. **Positive OOS after costs.** Compounded OOS return is above zero with fees, slippage, and perps costs included (backtest already emulates them).
2. **Most folds positive.** At least two thirds of test folds, and no single fold carrying the whole result. Remove the best fold. If the total goes negative, there is no edge.
3. **Beats the defaults and the market.** Compare against buy-and-hold on the same span (`pnpm backtest` prints a hold benchmark and excess vs hold). A long-only strategy in a bull market looks good for free.
4. **IS and OOS are in the same ballpark.** IS Sharpe 3 against OOS Sharpe 0 is overfitting. A large gap means the search found noise.
5. **Stable across seeds.** Run seeds 1, 2, 3. Compounded OOS and positive-fold count should agree in sign and rough size. One seed at +8% and another at -16% means no result.
6. **Stable parameters.** The selected sets should cluster. If `timeframe` flips between folds, or `stopAtr` jumps from 1.5 to 4, the response surface is flat or noisy and any single set is arbitrary. Note that late folds share most of their training data, so agreement there is weak evidence.
7. **Enough trades.** OOS folds with 10 to 20 trades are anecdotes. Sum trades across folds before trusting a mean.
8. **Reasonable risk.** OOS drawdown stays within what you would actually tolerate, and is not close to `--max-dd`.
9. **A mechanism.** You can say why the edge should exist (mean reversion in ranges, with a gate to avoid fading strong moves). An edge with no story is usually overfit.
10. **Survives a final holdout.** Reserve the most recent weeks or months, never use them in `tune`, then run one plain `pnpm backtest` with the chosen params. Look once. If you tweak and look again, it is no longer a holdout.

If the answer to 1 to 5 is no, change the strategy instead of adding more knobs. More axes raise the number of lucky combinations, not the odds of a real edge.

## Common failure modes

| Symptom                           | Likely cause                                    | What to do                                                                  |
| --------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| IS +100%, OOS negative            | Selection bias from many trials                 | Raise gates, cut axes, require seed agreement                               |
| Wildly different results per seed | No real edge, or too few trades                 | Raise `--min-trades`, add seeds, widen the span                             |
| Winner differs every fold         | Flat or noisy response surface                  | Fix most knobs at sensible values and tune only one or two                  |
| Great result on one fold only     | One regime (for example a single trend)         | Drop that fold, check the rest                                              |
| Huge returns on a tiny pair       | Data spikes or unrealistic costs                | Use clean candles; check the liquidity tier in emulated costs               |
| `selected: none`                  | No feasible set with an evaluated neighbor      | Loosen gates only if the reason is real, otherwise the strategy fails there |
| OOS trades near zero              | Gates or filters too strict for the test window | Lower `--min-trades` slightly or widen the window                           |

## Ablation: does a knob help?

To test one knob, do not read it off tuned winners. Fix every other parameter, then backtest the full span once per level and compare return, drawdown, trade count, and win rate. A knob that only helps when the search also moves the others is not carrying weight.

## After a good result

1. Confirm with the holdout (point 10 above).
2. Run `pnpm paper` for a few weeks with the new params. Paper fills are simulated Jupiter quotes, so it checks live data paths and signal timing, not slippage on a real fill.
3. Only then change that strategy's `*ParamsFor` in its mode file.
4. Go live with small size. Compare live fills to the backtest cost model. A persistent gap means the model is optimistic.

`tune` does not change defaults for you. Applying a result is always a manual edit.

## Limits to remember

- The default replay walks synthetic ticks inside each candle, so the order of a stop and a target inside one bar is an approximation. `pnpm tune -- --quotes 1m` steps each signal bar on real minute closes, the same path as `pnpm backtest -- --quotes 1m`.
- Costs use fixed tiers (`SOL/USDC` is liquid) and a perps fee snapshot. Large size or thin pairs will fill worse.
- Only pairs with a Jupiter Perps market (SOL, ETH, BTC) can short. Other pairs are long-only in backtest and live.
- One position per pair, no leverage. Results do not transfer to other sizing rules.
- Past regimes do not repeat on schedule. A strategy can pass every check above and still stop working.
