// Smoke test for main.ts v2 — synthetic hello/batch/done over stdin.
// Price model: price = vq / vt with vt fixed at 1e9. Base price 0.001 SOL/token.
const { spawn } = require('node:child_process');

const VT = '1000000000';
const REAL = '5000000000'; // 5 SOL real reserves -> cap 1% = 0.05 SOL >= 0.03 stake
function trade(mint, slot, price) {
  return {
    event: 'TradeEvent',
    mint,
    slot,
    virtual_token_reserves: VT,
    virtual_sol_reserves: String(Math.round(price * 1e9)),
    real_sol_reserves: REAL,
  };
}
function create(mint, slot, price) {
  return {
    event: 'CreateEvent',
    mint,
    slot,
    virtual_token_reserves: VT,
    virtual_sol_reserves: String(Math.round(price * 1e9)),
  };
}
const hello = {
  type: 'hello',
  capital: { lamports: '10000000000' },
  caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100 },
  latency_slots: 2,
  fees: { base_fee_lamports: '5000', priority_fee_lamports: '100000' },
};
const P0 = 0.001;
const msgs = [hello];
// Batch 1: coin A created, coin B created, coin C created (all at P0).
msgs.push({ type: 'batch', seq: 1, slot: 100, events: [create('A', 100, P0), create('B', 100, P0), create('C', 100, P0)], account: { cash_lamports: '10000000000', positions: [] } });
// Batch 2-4: A ticks up 1%, 2%, 3% (3 trades) -> early entry should fire on batch 4 (3rd trade).
// B ticks up 1%, 2% only (no entry: <3% and <3 trades). C flat.
msgs.push({ type: 'batch', seq: 2, slot: 101, events: [trade('A', 101, P0 * 1.01), trade('B', 101, P0 * 1.01)], account: { cash_lamports: '10000000000', positions: [] } });
msgs.push({ type: 'batch', seq: 3, slot: 102, events: [trade('A', 102, P0 * 1.02), trade('B', 102, P0 * 1.02)], account: { cash_lamports: '10000000000', positions: [] } });
msgs.push({ type: 'batch', seq: 4, slot: 103, events: [trade('A', 103, P0 * 1.03)], account: { cash_lamports: '10000000000', positions: [] } });
// Batch 5: buy fill for A at 0.00103 (30M lamports -> 29126213 tokens), then A rises to +12% vs buy price.
msgs.push({ type: 'batch', seq: 5, slot: 104, fills: [{ side: 'buy', mint: 'A', status: 'filled', token_amount: '29126213', quote_lamports: '30000000' }], events: [trade('A', 104, 0.00103 * 1.12)], account: { cash_lamports: '9970000000', positions: [{ mint: 'A', token_amount: '29126213' }] } });
// Batch 6: sell fill for A. B now runs +18% (past the 15% early-entry cap,
// so no early buy) then pulls back to 92% of peak and ticks up -> bounce entry.
msgs.push({ type: 'batch', seq: 6, slot: 105, fills: [{ side: 'sell', mint: 'A', status: 'filled', token_amount: '29126213', quote_lamports: '33600000' }], events: [trade('B', 105, P0 * 1.18), trade('B', 105, P0 * 1.18), trade('B', 105, P0 * 1.18)], account: { cash_lamports: '10036000000', positions: [] } });
msgs.push({ type: 'batch', seq: 7, slot: 106, events: [trade('B', 106, P0 * 1.18 * 0.92)], account: { cash_lamports: '10036000000', positions: [] } });
msgs.push({ type: 'batch', seq: 8, slot: 107, events: [trade('B', 107, P0 * 1.18 * 0.93)], account: { cash_lamports: '10036000000', positions: [] } });
// Batch 9: buy fill for B, then B crashes -7% vs buy price -> stop loss sell.
msgs.push({ type: 'batch', seq: 9, slot: 108, fills: [{ side: 'buy', mint: 'B', status: 'filled', token_amount: '29000000', quote_lamports: '30000000' }], events: [trade('B', 108, 0.0010345 * 0.93)], account: { cash_lamports: '10006000000', positions: [{ mint: 'B', token_amount: '29000000' }] } });
// Batch 10: C jumps +20% in one go (too far, too late) -> no early entry; done.
msgs.push({ type: 'batch', seq: 10, slot: 109, events: [trade('C', 109, P0 * 1.1), trade('C', 109, P0 * 1.15), trade('C', 109, P0 * 1.2)], account: { cash_lamports: '10006000000', positions: [{ mint: 'B', token_amount: '29000000' }] } });
msgs.push({ type: 'done' });

const bot = spawn('node', ['main.ts'], { cwd: __dirname });
let out = '';
bot.stdout.on('data', (d) => (out += d));
bot.stderr.on('data', (d) => process.stderr.write(d));
bot.on('close', (code) => {
  const replies = out.trim().split('\n').map((l) => JSON.parse(l));
  const checks = [];
  const orders = (seq) => replies.find((r) => r.seq === seq)?.orders ?? [];
  const has = (seq, side, mint) => orders(seq).some((o) => o.side === side && o.mint === mint);
  checks.push(['seq2 no buy (only +1%)', !has(2, 'buy', 'A') && !has(2, 'buy', 'B')]);
  checks.push(['seq3 no buy (only +2%)', !has(3, 'buy', 'A')]);
  checks.push(['seq4 EARLY buy A at +3%', has(4, 'buy', 'A') && orders(4)[0].quote_lamports === '30000000']);
  checks.push(['seq5 TP sell A at +12%', has(5, 'sell', 'A')]);
  checks.push(['seq6 no buy B at +18% (past early cap)', !has(6, 'buy', 'B')]);
  checks.push(['seq7 no bounce buy yet (still falling)', !has(7, 'buy', 'B')]);
  checks.push(['seq8 BOUNCE buy B after pullback + uptick', has(8, 'buy', 'B')]);
  checks.push(['seq9 SL sell B at -7%', has(9, 'sell', 'B')]);
  checks.push(['seq10 no buy C at +20% (chased too far)', !has(10, 'buy', 'C')]);
  checks.push(['all replies have seq + orders array', replies.every((r) => r.type === 'reply' && Array.isArray(r.orders))]);
  let fail = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fail++; }
  console.log(fail === 0 ? 'SMOKE TEST: ALL PASS' : `SMOKE TEST: ${fail} FAILURES`);
  process.exit(fail === 0 ? 0 : 1);
});
for (const m of msgs) bot.stdin.write(JSON.stringify(m) + '\n');
bot.stdin.end();
