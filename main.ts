// Cleanest Paper Bot — v2: early-entry + pullback-bounce paper trader
// for the pump.fun Sharpe Sprint (agent-fun/replay/v2).
//
// Self-contained: stdlib only, no network, no model calls, no imports of any
// kit file. It speaks the replay protocol directly over stdin/stdout:
//   harness -> bot: {"type":"hello",...} then {"type":"batch",...} then {"type":"done",...}
//   bot -> harness: one {"type":"reply","seq":n,"orders":[...]} per batch.
//
// Why v1 lost money (dev grade-local: net PnL -1.11 SOL, win rate 26%):
//   v1 chased coins already up >= 8% and waited for +25% / -12% exits.
//   Expectancy was negative before fees: 0.26*25% - 0.74*12% ~= -2.4% per
//   trade, and ~0.0007 SOL of fees per 0.03 SOL round trip (~2.3%) made it
//   worse. The loss was expectancy, not size.
//
// v2 fixes the expectancy, not the stake (still 0.03 SOL, identical stakes):
//   - Enter EARLY, not late: buy a fresh coin up only >= 3% from first
//     sighting (3+ trades, latest tick not down, not yet up more than 15%),
//     so the entry catches the rise instead of buying its top; OR buy the
//     bounce: a coin that ran >= 10% then pulled back >= 7% from its peak
//     and is ticking up again.
//   - Bank winners sooner and cut losers sooner: take profit +12%, stop
//     loss -6%, trailing exit -5% from the peak since entry, hard time exit
//     after 900 slots. With TP/SL = 2:1 the break-even win rate before fees
//     is 33%; after the ~2.3% fee drag it is ~40% — far below v1's ~39%
//     break-even at a 26% realised win rate, and early/bounce entries are
//     the setups most likely to clear it on a bonding curve, where the
//     first leg up is the most reliable move a fresh coin makes.
//   - Stay selective: one round trip per mint, at most 5 open positions,
//     and entries only while the coin is still actively trading (a trade
//     within the last 300 slots), so dead coins never get bought and fee
//     drag comes only from live setups.
//   - Every round trip still clears the 0.01 SOL minimum by 3x; max
//     drawdown is bounded by the -6% stop on 0.03 SOL stakes.
//   - Fully deterministic: every decision is a pure function of the events
//     the harness has delivered, so two runs on the same window agree.

type U64 = string;

interface Curve {
  mint: string;
  createdSlot: number | null;
  vt: bigint; // virtual token reserves
  vq: bigint; // virtual quote (SOL) reserves
  realQ: bigint; // real SOL reserves
  reservesSlot: number;
  trades: number;
  complete: boolean;
  firstPrice: number; // SOL per token at first sight
  firstSlot: number; // slot of first sighting
  peakPrice: number; // highest price seen since first sighting
  prevPrice: number; // price at the previous observation
  price: number; // latest SOL per token
  lastTradeSlot: number; // slot of the most recent trade
  seen: boolean;
}

interface MyPosition {
  mint: string;
  tokens: bigint;
  costLamports: bigint;
  buyPrice: number; // SOL per token actually paid
  peakPrice: number;
  buySlot: number;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;
const STAKE_LAMPORTS = 30_000_000n; // 0.03 SOL per buy
const MIN_STAKE_LAMPORTS = 10_000_000n; // never buy below 0.01 SOL (the round-trip minimum)
// Early-momentum entry: up >= 3% from first sight, not yet up more than 15%.
const ENTER_RISE = 1.03;
const ENTER_RISE_MAX = 1.15;
const MIN_TRADES_EARLY = 3;
// Pullback-bounce entry: ran >= 10%, pulled back >= 7% from peak, ticking up.
const BOUNCE_RUN = 1.1;
const BOUNCE_PULLBACK = 0.93;
const EPS = 1.002; // tolerance for float boundary comparisons on price ratios
const MIN_TRADES_BOUNCE = 5;
// Entries only while the coin is still actively trading.
const MAX_IDLE_SLOTS = 300;
const TAKE_PROFIT = 1.12; // +12%
const STOP_LOSS = 0.94; // -6%
const TRAIL_DROP = 0.95; // -5% from peak since entry
const MAX_HOLD_SLOTS = 900;
const MAX_OPEN = 5;
const MAX_NEW_BUYS_PER_BATCH = 2; // never fill the whole book in one batch
const MAX_ORDERS_PER_BATCH = 16;
const BUY_SLIPPAGE_BPS = 5000;
const SELL_SLIPPAGE_BPS = 5000;

function priceOf(c: Curve): number {
  if (c.vt === 0n || c.vq === 0n) return 0;
  return Number(c.vq) / Number(c.vt);
}

function toU64(n: bigint): U64 {
  return n.toString();
}

// ---------------------------------------------------------------- bot state

let capitalLamports = 0n;
let maxOpenPositions = MAX_OPEN;
let maxOrderBps = 100; // bps of real reserve per reply per mint
let txFeeLamports = 105_000n; // base 5000 + priority 100000 (hello overrides)
let latencySlots = 2;

const curves = new Map<string, Curve>();
const myPositions = new Map<string, MyPosition>();
const traded = new Set<string>(); // mints already bought once (one round trip each)
const pendingBuy = new Map<string, bigint>(); // mint -> quoted lamports in flight
const pendingSell = new Set<string>(); // mints with a sell in flight
let cashLamports = 0n;
let nextClient = 1;

function clientId(): string {
  return `o${nextClient++}`;
}

function curveFor(mint: string, slot: number): Curve {
  let c = curves.get(mint);
  if (c === undefined) {
    c = {
      mint,
      createdSlot: null,
      vt: 0n,
      vq: 0n,
      realQ: 0n,
      reservesSlot: slot,
      trades: 0,
      complete: false,
      firstPrice: 0,
      firstSlot: slot,
      peakPrice: 0,
      prevPrice: 0,
      price: 0,
      lastTradeSlot: slot,
      seen: false,
    };
    curves.set(mint, c);
  }
  return c;
}

function observeReserves(c: Curve, vt: bigint, vq: bigint, realQ: bigint, slot: number): void {
  if (slot < c.reservesSlot) return;
  c.vt = vt;
  c.vq = vq;
  c.realQ = realQ;
  c.reservesSlot = slot;
  const p = priceOf(c);
  if (p > 0) {
    if (!c.seen) {
      c.firstPrice = p;
      c.firstSlot = slot;
      c.prevPrice = p;
      c.peakPrice = p;
      c.seen = true;
    } else {
      c.prevPrice = c.price;
      if (p > c.peakPrice) c.peakPrice = p;
    }
    c.price = p;
  }
}

// ---------------------------------------------------------------- batch logic

interface Order {
  side: 'buy' | 'sell';
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

function onBatch(batch: any): Order[] {
  const slot: number = batch.slot;
  const orders: Order[] = [];

  // 1. Resolve fills: clear pending, record buy cost basis, drop sold positions.
  for (const f of batch.fills ?? []) {
    if (f.side === 'buy') {
      pendingBuy.delete(f.mint);
      if (f.status === 'filled' && BigInt(f.token_amount) > 0n) {
        const tokens = BigInt(f.token_amount);
        const spent = BigInt(f.quote_lamports);
        const buyPrice = Number(spent) / Number(tokens);
        const pos = myPositions.get(f.mint);
        if (pos !== undefined) {
          pos.tokens = tokens;
          pos.costLamports = spent;
          pos.buyPrice = buyPrice;
          pos.peakPrice = Math.max(pos.peakPrice, buyPrice);
        } else {
          myPositions.set(f.mint, {
            mint: f.mint,
            tokens,
            costLamports: spent,
            buyPrice,
            peakPrice: buyPrice,
            buySlot: slot,
          });
        }
        traded.add(f.mint);
      }
    } else {
      pendingSell.delete(f.mint);
      if (f.status === 'filled') myPositions.delete(f.mint);
    }
  }

  // 2. Account is truth for cash and holdings.
  if (batch.account !== undefined) {
    cashLamports = BigInt(batch.account.cash_lamports);
    const held = new Set<string>();
    for (const p of batch.account.positions ?? []) {
      held.add(p.mint);
      const pos = myPositions.get(p.mint);
      if (pos !== undefined) pos.tokens = BigInt(p.token_amount);
    }
    // Harness closes (complete/flatten) remove positions without a sell fill.
    for (const mint of [...myPositions.keys()]) {
      if (!held.has(mint)) myPositions.delete(mint);
    }
  }

  // 3. Marks, then events, update curves and prices.
  for (const m of batch.marks ?? []) {
    const c = curves.get(m.mint);
    if (c !== undefined) {
      observeReserves(c, BigInt(m.virtual_token_reserves), BigInt(m.virtual_quote_reserves), BigInt(m.real_quote_reserves), m.slot);
    }
  }
  for (const e of batch.events ?? []) {
    if (e.event === 'CreateEvent') {
      const c = curveFor(e.mint, e.slot);
      c.createdSlot = e.slot;
      observeReserves(c, BigInt(e.virtual_token_reserves), BigInt(e.virtual_sol_reserves), 0n, e.slot);
    } else if (e.event === 'TradeEvent') {
      const c = curveFor(e.mint, e.slot);
      observeReserves(c, BigInt(e.virtual_token_reserves), BigInt(e.virtual_sol_reserves), BigInt(e.real_sol_reserves), e.slot);
      c.trades += 1;
      c.lastTradeSlot = e.slot;
    } else if (e.event === 'CompleteEvent') {
      const c = curveFor(e.mint, e.slot);
      c.complete = true;
    }
  }

  // 4. Exits first: free slots and lock in the exit band before entering.
  // Cash in the account still holds the stake of buys in flight (they fill
  // 2 slots after the decision), so reserve those amounts plus their tx fees
  // before sizing anything new; likewise reserve one tx fee per pending sell.
  let freeCash = cashLamports;
  for (const stake of pendingBuy.values()) freeCash -= stake + txFeeLamports;
  for (const _m of pendingSell) freeCash -= txFeeLamports;
  for (const [mint, pos] of [...myPositions.entries()]) {
    if (pendingSell.has(mint)) continue;
    const c = curves.get(mint);
    if (c === undefined || c.complete || c.price <= 0) continue;
    if (c.price > pos.peakPrice) pos.peakPrice = c.price;
    const up = c.price / pos.buyPrice;
    const offPeak = c.price / pos.peakPrice;
    const stale = slot - pos.buySlot > MAX_HOLD_SLOTS;
    if (up >= TAKE_PROFIT || up <= STOP_LOSS || offPeak <= TRAIL_DROP || stale) {
      if (pos.tokens <= 0n) continue;
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      orders.push({
        side: 'sell',
        client_id: clientId(),
        mint,
        token_amount: toU64(pos.tokens),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      pendingSell.add(mint);
      freeCash -= txFeeLamports;
    }
  }

  // 5. Entries: early momentum or pullback bounce, one small stake each.
  const openCount =
    myPositions.size + [...pendingBuy.keys()].filter((m) => !myPositions.has(m)).length;
  let slotsLeft = Math.max(0, maxOpenPositions - openCount);
  let buysThisBatch = 0;
  if (slotsLeft > 0) {
    for (const c of curves.values()) {
      if (slotsLeft <= 0 || buysThisBatch >= MAX_NEW_BUYS_PER_BATCH || orders.length >= MAX_ORDERS_PER_BATCH) break;
      if (c.complete || !c.seen || c.price <= 0) continue;
      if (myPositions.has(c.mint) || pendingBuy.has(c.mint) || traded.has(c.mint)) continue;
      // Only actively trading coins: no stale entries on dead curves.
      if (slot - c.lastTradeSlot > MAX_IDLE_SLOTS) continue;
      // Latest tick must not be falling into the entry.
      if (c.price < c.prevPrice) continue;
      const early =
        c.trades >= MIN_TRADES_EARLY &&
        c.price >= c.firstPrice * ENTER_RISE &&
        c.price <= c.firstPrice * ENTER_RISE_MAX;
      const bounce =
        c.trades >= MIN_TRADES_BOUNCE &&
        c.peakPrice >= c.firstPrice * BOUNCE_RUN &&
        c.price <= c.peakPrice * BOUNCE_PULLBACK * EPS &&
        c.price >= c.firstPrice; // still above launch: no dead-coin floor bounce
      if (!early && !bounce) continue;
      // Size cap: at most maxOrderBps of the real SOL reserve this reply.
      const cap = (c.realQ * BigInt(maxOrderBps)) / 10_000n;
      if (cap < MIN_STAKE_LAMPORTS) continue;
      const stake = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (freeCash < stake + txFeeLamports) continue;
      const id = clientId();
      orders.push({
        side: 'buy',
        client_id: id,
        mint: c.mint,
        quote_lamports: toU64(stake),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      pendingBuy.set(c.mint, stake);
      freeCash -= stake + txFeeLamports;
      slotsLeft -= 1;
      buysThisBatch += 1;
    }
  }

  return orders;
}

// ---------------------------------------------------------------- protocol loop

function onHello(hello: any): void {
  capitalLamports = BigInt(hello.capital.lamports);
  cashLamports = capitalLamports;
  maxOpenPositions = hello.caps.max_open_positions;
  maxOrderBps = hello.caps.max_order_bps_of_real_reserve;
  latencySlots = hello.latency_slots;
  txFeeLamports =
    BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
  void latencySlots;
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.length === 0) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === 'hello') {
      onHello(msg);
    } else if (msg.type === 'batch') {
      const orders = onBatch(msg);
      process.stdout.write(
        JSON.stringify({ type: 'reply', seq: msg.seq, orders }) + '\n',
      );
    } else if (msg.type === 'done') {
      process.exit(0);
    }
  }
});
