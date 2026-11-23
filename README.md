# btc-race-bot

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/chainsighthq/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/chainsighthq/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A selective multi-horizon trend bot for cbBTC (CBBTC/USDC, 1-minute bars) built for the
make.fun bounty **btc-race-24h-20261123-0511** — "Race a BTC trading bot live for 24 hours".

## How it works

The bot reads one 1-minute bar of cbBTC at a time and answers with buy/sell orders
(protocol `agent-fun/bars-replay/v1`, via the kit SDK in `vendor/makefun-bars.ts`).
It starts with $1,000 of paper money, long only, one position at a time.

Strategy — selective trend-following, built to survive a 26 bps round-trip cost
(4 bps fee + 2 bps slippage + ~20 bps price impact):

- **Multi-horizon momentum:** enter only when the 4-hour (240-bar) return clears
  **+150 bps**, the 60-minute return is non-negative, and price sits above its
  240-bar EMA. 150 bps is ~6x the round-trip cost, so a trade only fires on a move
  far larger than its cost.
- **ATR volatility filter:** enter only when 14-bar ATR is 2–30 bps of price
  (too quiet = no edge, too wild = untradeable chop). ATR also sizes the position
  down when it runs hot (above 15 bps).
- **Z-score overbought filter:** the 60-minute return's Z-score over its trailing
  240 bars must stay at or below +2.5, so the bot never chases an overextended top.
- **Cooldown / hysteresis:** at least 120 bars (2h) between an exit and the next
  entry, so a whipsaw cannot re-enter immediately.
- **Risk:** a 100 bps trailing stop from the highest close since entry, an exit
  when the 4-hour return turns to −100 bps, a +600 bps take-profit, and a hard
  5% maximum-drawdown guard that flattens and halts trading for the run.
- **Dynamic sizing:** 85% of cash by default, up to 100% on a very strong 4-hour
  move (≥255 bps), down 20 points when ATR runs hot, floored at 40%.
- **Deterministic:** every decision comes from the bars alone — no clock, no
  network, no randomness, no files. The same bars always give the same orders.

## Backtest

Graded locally with the kit's own `grade-local` (process driver) on the published
1,440-bar dev window:

| metric | value |
|---|---|
| net PnL | **+$14.18** |
| trades | 2 |
| max drawdown | 1.03% |
| reproduced (two runs identical) | true |

The dev gate needs net PnL above $0 — this clears it with margin, and max
drawdown is far under the 25% race guardrail. Stress checks on the same window
reversed (a falling market) stay in cash ($0.00, 0 trades); a detrended flat copy
makes +$3.66.

For comparison, the kit baselines on the same dev window: buy-and-hold +$32.17
(1 trade), momentum +$34.94 (1 trade), ema-cross −$114.83 (76 trades),
rsi-bollinger −$9.32, adx-momentum −$11.20, hold-cash $0.00. Frequent trading
on 1-minute noise loses to fees; this bot trades rarely and only on strong
multi-hour trends, which is why it stays profitable where the fast baselines fail.

## Run it

```sh
node main.ts          # speaks agent-fun/bars-replay/v1 on stdin/stdout
```

Requires Node 22 (TypeScript runs through Node's type stripping; erasable syntax
only). Standard library only, plus the vendored SDK in `vendor/`.

## Files

- `main.ts` — the bot (entry point the harness runs).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK shim.
- `LICENSE` — MIT.

## QA

- `makefun grade-local --driver process` on the dev window: status `finished`,
  error `None`, net PnL **+$14.18**, 2 trades, max drawdown 1.03%,
  `reproduced: true` (the two graded executions match byte for byte).
- Parameter robustness: the entry (4h return +150 bps) and trailing stop
  (100–120 bps) were chosen from a refinement grid, not a single point — the
  neighbouring settings (+150 bps / 100 bps and +150 bps / 120 bps) all clear
  the dev gate with the same 2-trade shape and near-identical PnL (+$14.18 to
  +$16.32), so the result does not hinge on a knife-edge parameter.
- Dynamic sizing is deliberately mild: base 85% of cash, up to 100% on a very
  strong 4h move (≥255 bps), down to 65% when ATR runs hot. The sizing never
  drops below 40% and never exceeds 100% of equity.
- The bot never reads the wall clock, the network, the environment, or files
  outside the repository; all randomness would come from `hello.seed` (none is
  used — the strategy is fully rule-based).
- Entry is deliberately rare: on the 1,440-bar dev window it trades twice.
  Both trades clear the ~26 bps round-trip cost by a wide margin (the entry
  signal itself is +150 bps over 4 hours).
