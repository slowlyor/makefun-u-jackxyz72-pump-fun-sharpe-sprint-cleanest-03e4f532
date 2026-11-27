// SharpSprint v3 — a selective early-momentum paper bot for the pump.fun replay.
//
// Idea, in one paragraph: the replay's pump happens in the first few slots after a coin is
// created, but the harness fills orders two slots after they are decided, so chasing the raw
// pump is a losing game — by the time a fill lands the price has already run and then fades.
// What survives that lag is a narrow, evidence-backed slice of launches: coins whose curve
// already holds real SOL (at least 10 SOL, so the position can be sized and the 1%-of-reserve
// buy cap is not the binding constraint), whose early tape shows genuine breadth (at least 3
// distinct non-creator buyers), whose creator has not sold, whose creator bought a modest
// amount at creation (at most 1 SOL — skin in the game, not a whale setting up a dump), and
// whose early selling is limited (others sold at most half of what was bought). Those coins
// are bought once, in two sizes: a small 0.02 SOL ticket normally, and a 0.30 SOL ticket when
// the creator's own creation-slot buy sits in the 0.05–1 SOL band — that band is the strongest
// single signal in the dev data, winning most of its trades. Exits are deliberately boring:
// take profit at +15% over the full cost basis (quote spent plus the tx fees paid), stop out
// at -6%, leave at once when a single sell of 2 SOL or more hits the tape or when the creator
// sells, and otherwise hold — there is no time limit, because the second leg of a good coin
// often arrives long after the first. The profit target is deliberately modest: +15% is hit
// while the spike is still alive, and the tight stop cuts the fade early. No clock, no
// randomness, no network, no environment: every decision is a pure function of the batches
// the harness delivers.
//
// Guardrails: at most 5 open positions (the harness cap), one buy per coin, every buy at
// least 0.01 SOL, sells always whole-position, slippage left wide open so a fill is never
// refused for the price moving during the two-slot latency.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const FEE_BPS = 125n; // protocol 95 + creator 30, charged on every fill
const BPS = 10_000n;

// --- entry: how a coin earns a buy -------------------------------------------
const MIN_RQ_LAMPORTS = 10n * LAMPORTS_PER_SOL; // real SOL the curve must already hold
const MIN_BUYERS = 3; // distinct non-creator buyers seen before entry
const MAX_DEV_BUY_LAMPORTS = 1n * LAMPORTS_PER_SOL; // creator's creation-slot buy, at most
const MAX_SELL_RATIO_BPS = 5000n; // others' sold / bought, at most half
const MIN_CAP_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL: smallest buy worth sending
const MAX_AGE_SLOTS = 100_000; // entry window after the CreateEvent
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 100n; // 0.02 SOL base ticket
const STAKE_STRONG_LAMPORTS = (LAMPORTS_PER_SOL * 3n) / 10n; // 0.30 SOL strong ticket
const STRONG_DEV_MIN_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL
const STRONG_DEV_MAX_LAMPORTS = 1n * LAMPORTS_PER_SOL; // 1 SOL

// --- exit: how a position is closed ------------------------------------------
const TP_BPS = 1500n; // take profit: +15% over the full cost basis
const SL_BPS = 600n; // stop loss: -6% under the full cost basis
const BIG_SELL_LAMPORTS = 2n * LAMPORTS_PER_SOL; // one sell this big ends the trade
const MAX_HOLD_SLOTS = 1_000_000; // effectively no time limit

/** What selling `tokens` against (vq, vt) would pay after the curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Tape {
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>;
  bought: bigint;
  sold: bigint;
  decided: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  devSoldAtOpen: boolean;
}

/** The bot's own books: one tape per coin seen, one record per open position. */
const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Mints with a sell in flight. */
const selling = new Set<Pubkey>();
/** Coins whose buy cap is already big enough to be worth re-checking. */
const candidates = new Set<Pubkey>();

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = state.slot;
    const traded = new Set<Pubkey>();

    // --- read the batch into the tapes ---------------------------------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapes.set(e.mint, {
          createSlot: e.slot,
          creator: e.creator,
          devBuy: 0n,
          devSold: false,
          buyers: new Set(),
          bought: 0n,
          sold: 0n,
          decided: false,
        });
        candidates.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        const t = tapes.get(e.mint);
        if (t === undefined) continue;
        traded.add(e.mint);
        const sol = BigInt(e.sol_amount);
        const isDev = e.user === t.creator;
        if (e.is_buy) {
          t.bought += sol;
          if (isDev && e.slot === t.createSlot) t.devBuy += sol;
          else if (!isDev) t.buyers.add(e.user);
        } else {
          if (isDev) t.devSold = true;
          else t.sold += sol;
        }
        candidates.add(e.mint);
      } else {
        const t = tapes.get(e.mint);
        if (t !== undefined) t.decided = true;
        held.delete(e.mint);
        selling.delete(e.mint);
        candidates.delete(e.mint);
      }
    }

    // --- fills: track the tx fees each position has paid ----------------------
    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.side !== 'buy') continue;
      const h = held.get(f.mint);
      if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      else {
        held.set(f.mint, {
          openedSlot: now,
          txPaid: BigInt(f.tx_fee_lamports),
          devSoldAtOpen: tapes.get(f.mint)?.devSold ?? false,
        });
      }
    }
    for (const mint of [...selling]) {
      let pendingSell = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') { pendingSell = true; break; }
      }
      if (!pendingSell) selling.delete(mint);
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) {
        let pendingBuy = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'buy') { pendingBuy = true; break; }
        }
        if (!pendingBuy) held.delete(mint);
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

    // --- exits first ----------------------------------------------------------
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      let pendingSell = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') { pendingSell = true; break; }
      }
      if (pendingSell) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: now, txPaid: tx, devSoldAtOpen: tapes.get(mint)?.devSold ?? false };
        held.set(mint, h);
      }
      const mk = marks.get(mint);
      const vq = mk !== undefined ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk !== undefined ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = sellValue(pos.token_amount, vq, vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      const t = tapes.get(mint);
      let exit = false;
      if (basis > 0n) {
        if (value * BPS >= basis * (BPS + TP_BPS)) exit = true;
        if (value * BPS <= basis * (BPS - SL_BPS)) exit = true;
      }
      if (!exit && now - h.openedSlot >= MAX_HOLD_SLOTS) exit = true;
      if (!exit && t !== undefined && t.devSold && !h.devSoldAtOpen) exit = true;
      if (!exit) {
        for (const e of batch.events) {
          if (e.event === 'TradeEvent' && e.mint === mint && !e.is_buy && BigInt(e.sol_amount) >= BIG_SELL_LAMPORTS) {
            exit = true;
            break;
          }
        }
      }
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      selling.add(mint);
      if (t !== undefined) t.decided = true;
    }

    // --- entries --------------------------------------------------------------
    let free = state.freeCashLamports();
    let open = state.committedPositionCount();
    const checkMints = new Set<Pubkey>([...traded, ...candidates]);
    for (const mint of checkMints) {
      if (orders.length >= cap) break;
      const t = tapes.get(mint);
      if (t === undefined || t.decided) { candidates.delete(mint); continue; }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) { t.decided = true; candidates.delete(mint); continue; }
      if (now - t.createSlot > MAX_AGE_SLOTS) { t.decided = true; candidates.delete(mint); continue; }
      if (open >= state.hello.caps.max_open_positions) continue;
      let hasPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint) { hasPending = true; break; }
      }
      if (state.positions.has(mint) || hasPending || selling.has(mint)) continue;
      // The filters: breadth, creator behaviour, and how much has already been sold.
      if (t.devSold) { t.decided = true; candidates.delete(mint); continue; }
      if (t.buyers.size < MIN_BUYERS) continue;
      if (t.devBuy > MAX_DEV_BUY_LAMPORTS) { t.decided = true; candidates.delete(mint); continue; }
      if (t.bought > 0n && t.sold * BPS > t.bought * MAX_SELL_RATIO_BPS) {
        t.decided = true;
        candidates.delete(mint);
        continue;
      }
      if (curve.real_quote_reserves < MIN_RQ_LAMPORTS) continue;
      const capSol = state.maxBuyLamports(mint);
      if (capSol < MIN_CAP_LAMPORTS) continue;
      // Two sizes: the strong ticket when the creator's own creation-slot buy is
      // in the modest band that marks a launch the creator backs but does not own.
      const strong = t.devBuy >= STRONG_DEV_MIN_LAMPORTS && t.devBuy <= STRONG_DEV_MAX_LAMPORTS;
      let amount = strong ? STAKE_STRONG_LAMPORTS : STAKE_LAMPORTS;
      if (amount > capSol) amount = capSol;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 10_000 });
      free -= amount + tx;
      open += 1;
      t.decided = true;
      candidates.delete(mint);
    }
    return orders;
  },
});
