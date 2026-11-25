// Pump.fun replay bot: early-momentum breakout with strict exits.
//
// Strategy (paper trading on the agent-fun/replay/v2 harness):
// - Watch every new bonding curve. Track its price (virtual SOL reserves /
//   virtual token reserves) from the TradeEvents in each batch.
// - Buy once per coin, early, when the price breaks out: it has risen at
//   least 5% above its own low since creation, it is within 3% of its own
//   high, and it has traded enough to show real interest (>= 6 trades).
//   The breakout must still hold on a later batch (confirmation): a
//   one-slot spike that reverses at once is noise, not momentum. And the
//   coin must be hot: at least 15 trades within 5,000 slots of first sight
//   — quiet coins drift, the big moves happen where the flow is.
//   One buy per coin keeps the book spread across many distinct coins, which
//   is what the minimum bar (20 coins x >= 0.01 SOL round trip) rewards.
// - Size: 0.05 SOL per coin, capped by the harness size cap (1% of the real
//   SOL reserve), never below 0.02 SOL. At most 5 open positions.
// - Exit the full position on any of: +15% take-profit from the entry price,
//   -8% stop-loss from the entry price, a trailing stop once up 10% (sell on
//   a 15% fall from the peak), or a time stop: still below entry after
//   1,500 slots — recycle the slot into a fresh coin.
// - The replay flattens whatever is left at the end, so no position can be
//   stranded. Fees are ~1.25% of size per side plus a fixed tx fee, so the
//   take-profit is set well above the round-trip cost (~3% of stake).
//
// Determinism: no clock, no environment, no randomness — every decision is
// a pure function of the hello message and the batches seen so far, so the
// two grading executions produce identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per coin
const MIN_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 100n; // 0.02 SOL floor
const MAX_SLIPPAGE_BPS = 500; // 5% — refuse a fill that moved too far in latency
const SELL_SLIPPAGE_BPS = 1000; // 10% on exits, so a fast exit still lands

const BREAKOUT_PCT = 1.05; // price >= 5% above its own low
const NEAR_HIGH_PCT = 0.97; // ...and within 3% of its own high
const MIN_TRADES = 6; // trades seen before a coin may be bought
const TAKE_PROFIT = 1.15; // sell at +15% from entry
const STOP_LOSS = 0.92; // sell at -8% from entry
const TRAIL_TRIGGER = 1.10; // trailing stop arms once up 10%
const TRAIL_DROP = 0.85; // ...then sell on a 15% fall from the peak
const MAX_HOLD_SLOTS = 1500; // time stop: below entry after this long, exit

interface CoinTrack {
  low: number;
  high: number;
  trades: number;
  bought: boolean;
  entryPrice: number;
  entrySlot: number;
  peak: number;
  /** Slot the breakout was first seen; a buy needs it to still hold later. */
  breakoutSlot: number;
  /** Slot this coin was first seen, for the hot-coin age check. */
  firstSlot: number;
}

const tracks = new Map<string, CoinTrack>();

function priceOf(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves === 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const orders: Array<BuyInput | SellInput> = [];
    const caps = state.hello.caps;
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // Refresh tracked stats from this batch's events, then decide exits first
    // (freeing position slots) and entries after.
    const seen = new Set<string>();
    for (const event of batch.events) {
      if (event.event === 'CompleteEvent') {
        tracks.delete(event.mint);
        continue;
      }
      const mint = event.mint;
      if (seen.has(mint)) continue;
      seen.add(mint);
      const price = priceOf(state, mint);
      if (price === null || price <= 0) continue;
      let track = tracks.get(mint);
      if (track === undefined) {
        track = {
          low: price,
          high: price,
          trades: 0,
          bought: false,
          entryPrice: 0,
          entrySlot: 0,
          peak: price,
          breakoutSlot: 0,
          firstSlot: batch.slot,
        };
        tracks.set(mint, track);
      }
      if (event.event === 'TradeEvent') track.trades += 1;
      if (price < track.low) track.low = price;
      if (price > track.high) track.high = price;
      if (track.bought && price > track.peak) track.peak = price;
    }

    // Exits: sell the full position on take-profit, stop-loss, trailing
    // stop, or the time stop. Sell orders are decided from the latest marks.
    for (const [mint, holding] of state.positions) {
      const track = tracks.get(mint);
      const price = priceOf(state, mint);
      if (track === undefined || !track.bought || price === null) continue;
      const entry = track.entryPrice;
      const heldSlots = batch.slot - track.entrySlot;
      const takeProfit = price >= entry * TAKE_PROFIT;
      const stopLoss = price <= entry * STOP_LOSS;
      const trailing =
        track.peak >= entry * TRAIL_TRIGGER && price <= track.peak * TRAIL_DROP;
      const timeStop = heldSlots >= MAX_HOLD_SLOTS && price < entry;
      if (takeProfit || stopLoss || trailing || timeStop) {
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        track.bought = false;
        slots += 1;
      }
    }

    // Entries: one breakout buy per fresh coin, in batch event order.
    for (const event of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (event.event !== 'TradeEvent' && event.event !== 'CreateEvent') continue;
      const mint = event.mint;
      const track = tracks.get(mint);
      if (track === undefined || track.bought) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (track.trades < MIN_TRADES) continue;
      const price = priceOf(state, mint);
      if (price === null) continue;
      const breakout = price >= track.low * BREAKOUT_PCT && price >= track.high * NEAR_HIGH_PCT;
      if (!breakout) {
        track.breakoutSlot = 0;
        continue;
      }
      // Confirmation: a one-slot spike that reverses at once is noise — the
      // breakout must still be true on a later batch before any SOL goes in.
      if (track.breakoutSlot === 0) {
        track.breakoutSlot = batch.slot;
        continue;
      }
      if (batch.slot <= track.breakoutSlot) continue;
      // Hot-coin filter: only buy coins that are actively traded while young
      // (>= 15 trades within 5000 slots of first sight). Quiet coins drift;
      // the big moves happen where the flow is.
      if (track.trades < 15 || batch.slot - track.firstSlot > 5000) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + txFee) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      track.bought = true;
      track.entryPrice = price;
      track.entrySlot = batch.slot;
      track.peak = price;
      free -= amount + txFee;
      slots -= 1;
    }

    return orders;
  },
});
