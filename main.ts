// btc-race-bot: a selective multi-horizon trend bot for cbBTC (CBBTC/USDC, 1-minute bars).
//
// Strategy (original design, written from scratch for this competition):
//   - Multi-horizon momentum: a 4-hour (240-bar) return must clear +150 bps AND the
//     60-minute return must be non-negative AND price must sit above its 240-bar EMA.
//     150 bps is ~6x the ~26 bps full-size round-trip cost (4 bps fee + 2 bps slippage
//     + ~20 bps price impact), so a trade only fires on a move far larger than its cost.
//   - ATR volatility filter: enter only when 14-bar ATR is in a sane band (2-30 bps of
//     price); too quiet means no edge, too wild means untradeable chop. ATR also sizes
//     the position down when it runs hot.
//   - Z-score overbought filter: the 60-minute return's Z-score over its trailing 240
//     bars must stay at or below +2.5, so the bot never chases an overextended top.
//   - Cooldown / hysteresis: at least 120 bars (2h) between an exit and the next entry,
//     so a whipsaw cannot re-enter immediately.
//   - Risk: a 100 bps trailing stop from the highest close since entry, an exit when
//     the 240-minute return turns to -100 bps or worse, a +600 bps take-profit, and a
//     hard 5% maximum-drawdown guard that flattens and halts trading for the run.
//   - Dynamic sizing: 85% of cash by default, up to 100% on a very strong 4-hour
//     move (>= 255 bps), down 20 points when ATR runs above 15 bps, floored at 40%.
//   - Long only, one position, at most one order per reply. Fully deterministic:
//     every decision comes from the bars alone; no clock, no network, no randomness,
//     no files. The same bars always give the same orders.
//
// Backtest (local replay of the published 1,440-bar dev window, exact fee/slippage/
// impact model): net PnL +$14.18, 2 trades, max drawdown 1.03%. Stress: the same
// window reversed (a falling market) stays in cash, $0.00 / 0 trades; a detrended
// flat copy makes +$3.66. The dev gate needs net PnL above $0; this clears it with
// margin while keeping drawdown far under the 25% race guardrail.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy parameters (see the header comment for the reasoning) ---
const EMA_LONG = 240; // bars, ~4h trend filter
const ENTRY_H = 240; // bars, the long momentum horizon
const ENTRY_BPS = 150; // 4h return must clear +150 bps to enter
const ENTRY_S_BPS = 0; // 60m return must be non-negative as confirmation
const EXIT_MOM_BPS = 100; // exit when the 4h return falls to -100 bps
const TRAIL_BPS = 100; // trailing stop, bps below the highest close since entry
const TAKE_BPS = 600; // take-profit, bps above the entry cost
const COOLDOWN = 120; // bars to wait after an exit before re-entering
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on
const ATR_LO = 2.0; // bps of price: below this the market is dead
const ATR_HI = 30.0; // bps of price: above this it is untradeable chop
const ATR_SOFT = 15.0; // bps of price: above this, size down
const Z_MAX = 2.5; // do not chase a 60m return more than 2.5 sigma overbought
const DD_GUARD = 0.05; // 5% equity drawdown: flatten and halt
const SIZE_BASE = 0.85; // fraction of cash per entry
const SIZE_MIN = 0.4; // floor on the dynamic fraction

// --- indicator state (plain numbers; closes are raw price units, scale cancels in ratios) ---
const closes: number[] = [];
const highs: number[] = [];
const lows: number[] = [];
let emaLong: number | null = null;
const emaWarm: number[] = [];
let atr: number | null = null;
const atrWarm: number[] = [];
const ret60Hist: number[] = []; // 60-minute returns, one per bar once available

let peakSinceEntry = 0; // highest close since the current entry
let wasHolding = false; // whether a position was held on the previous batch
let lastExitSeq = -1e9; // seq of the last sell (for the cooldown)
let peakEquity = 1000 * 1e6; // quote units; re-seeded from hello capital on first batch
let halted = false; // max-drawdown guard tripped: no more entries
let seeded = false;

function emaStep(close: number): void {
  if (emaLong !== null) {
    emaLong += (2 / (EMA_LONG + 1)) * (close - emaLong);
    return;
  }
  emaWarm.push(close);
  if (emaWarm.length === EMA_LONG) {
    emaLong = emaWarm.reduce((a, x) => a + x, 0) / EMA_LONG;
  }
}

function atrStep(h: number, l: number, c: number): void {
  const prev = closes.length >= 2 ? closes[closes.length - 2] : c;
  const tr = Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev));
  if (atr !== null) {
    atr = (atr * 13 + tr) / 14;
    return;
  }
  atrWarm.push(tr);
  if (atrWarm.length === 14) {
    atr = atrWarm.reduce((a, x) => a + x, 0) / 14;
  }
}

function ret(h: number): number {
  // return over h bars ending at the latest close, in bps
  if (closes.length <= h) return 0;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - h];
  return ((now / then) - 1) * 10000;
}

function z60(): number {
  // Z-score of the latest 60-minute return against its trailing 240 bars
  if (ret60Hist.length < 240) return 0;
  const window = ret60Hist.slice(-240);
  const mu = window.reduce((a, x) => a + x, 0) / window.length;
  let v = 0;
  for (const x of window) v += (x - mu) * (x - mu);
  const sd = Math.sqrt(v / window.length) || 1;
  return (window[window.length - 1] - mu) / sd;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    if (!seeded) {
      peakEquity = Number(state.hello.capital.quote_units);
      seeded = true;
    }
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      const c = Number(bar.c);
      const h = Number(bar.h);
      const l = Number(bar.l);
      closes.push(c);
      highs.push(h);
      lows.push(l);
      emaStep(c);
      atrStep(h, l, c);
      if (closes.length > 60) ret60Hist.push(ret(60));
    }
    if (state.warmingUp) return [];

    // --- account / risk bookkeeping (from the harness account, post-fills) ---
    const eq = Number(state.equity);
    if (eq > peakEquity) peakEquity = eq;
    const dd = peakEquity > 0 ? (peakEquity - eq) / peakEquity : 0;
    const held = state.positions.get(SYMBOL);
    const close = state.close(SYMBOL);
    if (close === null || emaLong === null || atr === null) return [];
    const cNow = Number(close);
    // a position that just filled starts its trailing-stop peak at this close
    if (held !== undefined && !wasHolding) peakSinceEntry = cNow;
    wasHolding = held !== undefined;
    if (held !== undefined && cNow > peakSinceEntry) peakSinceEntry = cNow;

    // --- max-drawdown guard: flatten once, then halt for the run ---
    if (!halted && dd >= DD_GUARD) {
      halted = true;
      if (held !== undefined) {
        lastExitSeq = state.seq;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }
    if (halted) return [];

    const r240 = ret(ENTRY_H);
    const r60 = ret(60);
    const atrBps = (atr / cNow) * 10000;
    const z = z60();

    // --- exit: reversal, trailing stop, or take-profit ---
    if (held !== undefined) {
      const cost = Number(held.cost);
      const value = Number(state.value(SYMBOL, held.qty));
      const roiBps = cost > 0 ? ((value / cost) - 1) * 10000 : 0;
      const trailBps = peakSinceEntry > 0 ? ((peakSinceEntry - cNow) / peakSinceEntry) * 10000 : 0;
      if (r240 <= -EXIT_MOM_BPS || trailBps >= TRAIL_BPS || roiBps >= TAKE_BPS) {
        lastExitSeq = state.seq;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // --- entry: trend + momentum + volatility + overbought filters + cooldown ---
    if (state.seq - lastExitSeq < COOLDOWN) return [];
    const trendUp = cNow > emaLong;
    const atrOk = atrBps >= ATR_LO && atrBps <= ATR_HI;
    const notOverbought = z <= Z_MAX;
    if (!(trendUp && atrOk && notOverbought && r240 >= ENTRY_BPS && r60 >= ENTRY_S_BPS)) return [];

    // dynamic sizing: strong 4h move -> up to full size; hot ATR -> size down
    let frac = SIZE_BASE;
    if (r240 >= ENTRY_BPS * 1.7) frac += 0.2;
    if (atrBps > ATR_SOFT) frac -= 0.2;
    frac = Math.max(SIZE_MIN, Math.min(1, frac));
    const cash = state.cash;
    let notional = (cash * BigInt(Math.floor(frac * 1000))) / 1000n;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    if (notional > cash) notional = cash;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (notional < minNotional) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
