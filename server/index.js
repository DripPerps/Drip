// IVY — a permissionless perps DEX powered by a faithful (simulated) port of the
// PERCOLATOR risk engine (dcccrypto/percolator, spec v16.8.3). DEMO / simulation.
//
// The point of percolator is STRUCTURAL SOLVENCY, implemented with three invariants:
//   1. H  — Haircut ratio (backed exits): capital is senior, profit is junior.
//           Residual = V - (C_tot + I). Profits are paid at H = min(Residual, ΣPnL+)/ΣPnL+.
//           "No user can ever withdraw more value than actually exists on the balance sheet."
//   2. A/K/F — lazy per-side indices: queue-free ADL / funding / mark socialization, O(1)/account.
//           K_side += A_side*ΔP (mark);  F_side ±= A_side*funding;  liq shrinks A; deficit shifts K.
//   3. Bounded cranks: |ΔP|*1e4 <= max_move_bps*dt*P_last  (oracle/funding can't blow OI in one slot).
//   + Side-recovery state machine: Normal → DrainOnly (A<MIN_A) → ResetPending (OI=0, epoch++) → Normal.
//
// SIMULATED off-chain with floats (the real engine is no_std fixed-point, formally verified —
// 471 Kani proofs). No real custody. $IVY = gov/fee token (Robinhood Chain). Dependency-free Node.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const PORT = process.env.PORT || 8105;
const ROOT = path.join(__dirname, '..');
const DATA_PATH = process.env.DATA_PATH || path.join(ROOT, 'data.json');
const TOKEN = 'IVY';
const IVY_MINT = process.env.IVY_MINT || '';
const SEED_USDC = +(process.env.SEED_USDC || 10000);

// On-chain (Phase 1.5): set these once the Anchor program is deployed to enable
// the "Devnet" mode that routes trades through the program via wallet. Until then
// CHAIN is null and the site stays in off-chain demo mode.
const CHAIN = process.env.IVY_PROGRAM_ID ? {
  programId: process.env.IVY_PROGRAM_ID,
  usdcMint: process.env.USDC_MINT || '',
  cluster: process.env.SOLANA_CLUSTER || 'devnet',
  rpc: process.env.SOLANA_RPC || '',
  ivyMint: IVY_MINT,
} : null;

// ---- engine config (analogues of the spec's cfg_* knobs) ----
const FEE = 0.0006;                 // taker fee
const MAINT_BPS = 50;               // cfg_maintenance_bps  (0.5% maintenance margin)
const LIQ_FEE_BPS = 50;             // cfg_liquidation_fee_bps
const MAX_MOVE_BPS = 800;           // cfg_max_price_move_bps_per_slot (bounded crank / bad-tick clamp)
const MIN_A = 0.25;                 // MIN_A_SIDE → DrainOnly
const MIN_MM = 1;                   // cfg_min_nonzero_mm_req
const WARMUP = 25;                  // admission/warmup slots for fresh profit (reserves R_i)
const SEC = 1;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const id6 = () => { let s = ''; for (const x of randomBytes(6)) s += B58[x % 58]; return s; };
const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));

// ---------- markets (each holds two side-states) ----------
// Real LIVE prices from Pyth (Hermes) — these are canonical on-chain oracle prices.
const PYTH = 'https://hermes.pyth.network/v2/updates/price/latest';
const FEED = {
  BONK: '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
  WIF: '4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
  POPCAT: 'b9312a7ee50e189ef045aa3c7842e099b061bd9bdc99ac645956c3b660dc8cce',
  PNUT: '116da895807f81f6b5c5f01b109376e7f6834dc8b51365ab7cdfa66634340e54',
  GOAT: 'f7731dc812590214d3eb4343bfb13d1b4cfa9b1d4e020644b5d5d8e07d60c66c',
  MOODENG: 'ffff73128917a90950cd0473fd2551d7cd274fd5a6cc45641881bbcc6ee73417',
  FARTCOIN: '58cd29ef0e714c5affc44f269b2c1899a52da4169d7acc147b9da692e6953608',
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
};
// Robinhood-native listings — no Pyth feed exists for these, so they mark to a
// PINNED deep-liquidity DEX pair (DexScreener pair address, NOT a per-token
// search — pinning the exact pair is what avoids the mispriced-pair problem).
const DSPAIR = {
  JUGGERNAUT: '0x588b0785f50063260003B7790C42f1eF74902746', // vs WETH · ~$450k liq
  CASHCAT: '0xA70fc67C9F69da90B63a0e4C05D229954574E313',    // vs WETH · ~$5.6M liq
};
function side() { return { A: 1, K: 0, F: 0, OI: 0, epoch: 0, mode: 'Normal', K0: 0, F0: 0 }; }
const MKT = [
  ['BONK', 0.0000043, 8], ['WIF', 0.15, 4], ['POPCAT', 0.046, 4], ['PNUT', 0.042, 4],
  ['GOAT', 0.0124, 5], ['MOODENG', 0.038, 5], ['FARTCOIN', 0.123, 4], ['SOL', 68, 2],
  ['JUGGERNAUT', 0.0102, 5], ['CASHCAT', 0.111, 4],
].map(([sym, px, dp]) => ({
  sym, feed: FEED[sym], ds: DSPAIR[sym], src: FEED[sym] ? 'pyth' : 'dex', px, P_last: px, base: px, dp,
  maxLev: sym === 'SOL' ? 50 : sym === 'JUGGERNAUT' ? 10 : 20, fundingRate: (Math.random() - .5) * 4e-5,
  seenLive: false, live: false, lastTs: 0, dayRef: { price: px, ts: Date.now() },
  hist: [], long: side(), short: side(),
}));
const M = (s) => MKT.find((m) => m.sym === s);
let PRICE_OK = false, LAST_OK = 0;

// first sighting seeds the market (no mark); subsequent ticks mark-to-market
function seedOrMark(m, px) {
  if (!(px > 0)) return;
  if (!m.seenLive || m.bootCatch) {            // first sight (or first tick after restart): re-anchor, do NOT mark
    if (!m.seenLive) { m.base = px; m.dayRef = { price: px, ts: Date.now() }; }
    m.px = m.P_last = px; m.seenLive = true; m.bootCatch = false;
  } else applyMark(m, px);
  m.live = true; m.lastTs = Date.now();
  if (Date.now() - m.dayRef.ts > 864e5) m.dayRef = { price: px, ts: Date.now() };
}
// pull live Pyth prices for oracle-fed markets
async function fetchPrices() {
  try {
    const q = MKT.filter((m) => m.feed).map((m) => 'ids[]=' + m.feed).join('&');
    const r = await fetch(PYTH + '?' + q, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json(); const by = {};
    for (const p of j.parsed || []) by[p.id.replace(/^0x/, '')] = Number(p.price.price) * Math.pow(10, p.price.expo);
    for (const m of MKT) { if (m.feed) seedOrMark(m, by[m.feed]); }
    PRICE_OK = true; LAST_OK = Date.now();
  } catch (e) { PRICE_OK = false; }
}
// pull live prices for Robinhood-native markets from their PINNED DEX pairs
async function fetchDexPrices() {
  const ds = MKT.filter((m) => m.ds);
  if (!ds.length) return;
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/pairs/robinhood/' + ds.map((m) => m.ds).join(','), { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json(); const by = {};
    for (const p of j.pairs || []) by[(p.pairAddress || '').toLowerCase()] = +p.priceUsd;
    for (const m of ds) seedOrMark(m, by[m.ds.toLowerCase()]);
  } catch (e) { /* transient — pinned pairs keep last good price */ }
}

// ---------- state ----------
// positions are isolated sub-accounts; V (vault) + I (insurance) + the haircut are GLOBAL.
let db = { wallets: {}, pos: [], V: 35000, I: 8000, mkt: null };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))); } catch (e) {}
if (!db.wallets) db.wallets = {}; if (!db.pos) db.pos = [];
if (db.V == null) db.V = 35000; if (db.I == null) db.I = 8000;
// restore per-market side indices + price refs so persisted positions stay consistent across restarts
if (db.mkt) for (const s of db.mkt) { const m = M(s.sym); if (!m) continue; m.long = s.long; m.short = s.short; m.P_last = s.P_last; m.base = s.base; m.dayRef = s.dayRef; m.seenLive = true; m.bootCatch = true; }
function snapMkt() { return MKT.map((m) => ({ sym: m.sym, long: m.long, short: m.short, P_last: m.P_last, base: m.base, dayRef: m.dayRef })); }
let saveT = null; const save = () => { if (saveT) return; saveT = setTimeout(() => { saveT = null; db.mkt = snapMkt(); try { fs.writeFileSync(DATA_PATH, JSON.stringify(db)); } catch (e) {} }, 1000); };
const isWallet = (s) => /^0x[a-fA-F0-9]{40}$/.test(s);
function W(a) { return db.wallets[a] || (db.wallets[a] = { usdc: SEED_USDC, realized: 0 }); }
const num = (v, hi) => { let n = +v; if (!isFinite(n) || n <= 0) return 0; return hi != null ? Math.min(n, hi) : n; };

// ---------- engine primitives ----------
const effPos = (p, m) => { const S = m[p.side]; if (S.epoch !== p.epoch) return 0; return p.basis * S.A / p.a_basis; };

// (1) bounded crank: apply a REAL oracle price → mark-to-market + funding via the lazy indices
function applyMark(m, target) {
  if (!(target > 0)) return;
  const cap = (MAX_MOVE_BPS / 1e4) * m.P_last;           // sanity clamp: reject absurd single-tick jumps
  const dP = clamp(-cap, cap, target - m.P_last);
  const px = m.P_last + dP;
  // mark: K_side += A_side * ΔP  (only sides that have OI)
  if (m.long.OI > 0) m.long.K += m.long.A * dP;
  if (m.short.OI > 0) m.short.K -= m.short.A * dP;
  // funding: model-based (paper market — no real perp funding feed), only when BOTH sides hold OI
  if (m.long.OI > 0 && m.short.OI > 0) {
    m.fundingRate = clamp(-8e-4, 8e-4, m.fundingRate + (Math.random() - .5) * 3e-5);
    const f = m.P_last * m.fundingRate;
    m.long.F -= m.long.A * f;
    m.short.F += m.short.A * f;
  }
  m.px = px; m.P_last = px;
  m.hist.push(+px); if (m.hist.length > 180) m.hist.shift();
}

// (2) O(1) per-account settlement from K/F snapshot deltas → realized PnL; warmup reserves
function settle(p, m) {
  const S = m[p.side];
  if (S.epoch !== p.epoch) { p.basis = 0; return; }       // stale (post side-reset) → zeroed
  const dPnl = (p.basis / p.a_basis) * ((S.K - p.k_snap) + (S.F - p.f_snap));
  p.PNL += dPnl; p.k_snap = S.K; p.f_snap = S.F;
  if (dPnl > 0) p.R += dPnl;                               // fresh profit enters reserve (pending)
  if (p.R > 0) p.R = Math.max(0, p.R - p.R / WARMUP);      // matures over WARMUP slots
}

function riskNotional(p, m) { return Math.abs(effPos(p, m)) * m.px; }
function mmReq(p, m) { return Math.max(riskNotional(p, m) * MAINT_BPS / 1e4, MIN_MM); }

// (3) liquidation + ADL: shrink A on the liquidated side, socialize deficit into opposing K
function liquidate(p, m, idx) {
  const S = m[p.side], opp = m[p.side === 'long' ? 'short' : 'long'];
  const eff = Math.abs(effPos(p, m));
  const fee = riskNotional(p, m) * LIQ_FEE_BPS / 1e4;
  const equity = p.C + p.PNL;
  const payout = Math.max(0, equity - fee);
  const w = W(p.wallet); w.usdc += payout; w.realized += payout - p.C; db.V -= payout;
  const OIb = S.OI; S.OI = Math.max(0, S.OI - eff);
  let D = Math.max(0, -equity);                            // uninsured deficit
  if (D > 0) { const pay = Math.min(D, db.I); db.I -= pay; D -= pay; }
  if (D > 0 && opp.OI > 1e-9) opp.K += (-D / opp.OI);      // socialize into opposing side's K
  if (OIb > 1e-9) { S.A = S.A * (S.OI / OIb); if (S.A < MIN_A) S.mode = 'DrainOnly'; }
  db.pos.splice(idx, 1);
}

// (+) side-recovery state machine
function recover(m) {
  for (const key of ['long', 'short']) {
    const S = m[key];
    if (S.OI <= 1e-9 && (S.mode === 'DrainOnly' || S.A < 1)) {
      S.K0 = S.K; S.F0 = S.F; S.epoch += 1; S.A = 1; S.OI = 0; S.mode = 'Normal';
    }
  }
}

function tick() {
  for (const p of db.pos) settle(p, M(p.sym));
  for (let i = db.pos.length - 1; i >= 0; i--) {
    const p = db.pos[i], m = M(p.sym);
    if (effPos(p, m) === 0 && p.basis !== 0) { /* dust */ }
    if (Math.max(0, p.C + p.PNL) <= mmReq(p, m) && Math.abs(effPos(p, m)) > 1e-12) liquidate(p, m, i);
  }
  for (const m of MKT) recover(m);
  bots();
  save();
}

// ---------- haircut (global) ----------
function solvency() {
  let C_tot = 0, pnlPos = 0, pendR = 0;
  for (const p of db.pos) { C_tot += p.C; if (p.PNL > 0) pnlPos += p.PNL; pendR += Math.max(0, p.R); }
  const residual = db.V - (C_tot + db.I);
  const H = pnlPos > 1e-9 ? clamp(0, 1, residual / pnlPos) : 1;
  return { V: db.V, I: db.I, C_tot, pnlPos, residual, H, pendR };
}
const withdrawable = (p, H) => p.C + Math.min(0, p.PNL) + Math.max(0, p.PNL) * H;

// ---------- bots (keep both sides alive so funding + ADL have life) ----------
const BOTW = ['Bot1xPercoLPdemoaaaaaaaaaaaaaaaaaaaaa1', 'Bot2xPercoLPdemoaaaaaaaaaaaaaaaaaaaaa2', 'Bot3xPercoLPdemoaaaaaaaaaaaaaaaaaaaaa3', 'Bot4xPercoLPdemoaaaaaaaaaaaaaaaaaaaaa4'];
function bots() {
  if (Math.random() < 0.25 && db.pos.filter((p) => p.wallet.startsWith('Bot')).length < 10) {
    const m = MKT[Math.floor(Math.random() * MKT.length)];
    const sd = Math.random() < 0.5 ? 'long' : 'short';
    if (m[sd].mode !== 'Normal') return;
    openPos(BOTW[Math.floor(Math.random() * BOTW.length)], m.sym, sd, 400 + Math.random() * 2600, 3 + Math.floor(Math.random() * 12), true);
  }
  if (Math.random() < 0.12) { const bp = db.pos.filter((p) => p.wallet.startsWith('Bot')); if (bp.length) closePos(bp[Math.floor(Math.random() * bp.length)].id); }
}

// ---------- open / close ----------
function openPos(wallet, sym, sd, sizeUsd, lev, isBot) {
  const m = M(sym); if (!m) return { error: 'bad market' };
  const S = m[sd]; if (S.mode !== 'Normal') return { error: sd + ' side in recovery — closes only' };
  const w = W(wallet); const size = num(sizeUsd); if (!size) return { error: 'enter a size' };
  lev = clamp(1, m.maxLev, +lev || 1);
  const margin = size / lev, fee = size * FEE;
  if (!isBot && w.usdc < margin + fee) return { error: 'not enough USDC for margin + fee' };
  w.usdc -= margin + fee; db.V += margin; db.I += fee;     // margin → vault, fee → insurance
  const basis = size / m.px;
  S.OI += basis;
  db.pos.push({ id: id6(), wallet, sym, side: sd, basis, a_basis: S.A, k_snap: S.K, f_snap: S.F, epoch: S.epoch, C: margin, PNL: 0, R: 0, entry: m.px, ts: Date.now() });
  return { ok: true };
}
function closePos(id) {
  const i = db.pos.findIndex((p) => p.id === id); if (i < 0) return { error: 'no position' };
  const p = db.pos[i], m = M(p.sym); settle(p, m);
  const H = solvency().H, eff = Math.abs(effPos(p, m));
  const fee = Math.abs(effPos(p, m)) * m.px * FEE;
  const pay = Math.max(0, withdrawable(p, H) - fee);
  const w = W(p.wallet); w.usdc += pay; w.realized += pay - p.C; db.V -= pay; db.I += fee;
  m[p.side].OI = Math.max(0, m[p.side].OI - eff);
  db.pos.splice(i, 1);
  return { ok: true, closedPnl: pay - p.C, haircut: H };
}

// ---------- views ----------
function sideView(S) { return { A: S.A, K: S.K, F: S.F, OI: S.OI, epoch: S.epoch, mode: S.mode }; }
const chg = (m) => (m.px / m.dayRef.price - 1) * 100;
function markets() { return MKT.map((m) => ({ sym: m.sym, src: m.src, px: m.px, dp: m.dp, change: chg(m), funding: m.fundingRate * 100, maxLev: m.maxLev, live: m.live, longMode: m.long.mode, shortMode: m.short.mode })); }
function marketDetail(sym) { const m = M(sym); if (!m) return null; return { sym: m.sym, src: m.src, px: m.px, dp: m.dp, change: chg(m), funding: m.fundingRate * 100, maxLev: m.maxLev, live: m.live, hist: m.hist.slice(-120), long: sideView(m.long), short: sideView(m.short) }; }
function account(addr) {
  const w = W(addr), s = solvency();
  const positions = db.pos.filter((p) => p.wallet === addr).map((p) => {
    const m = M(p.sym), eff = effPos(p, m);
    return { id: p.id, sym: p.sym, side: p.side, basis: p.basis, eff, size: Math.abs(eff) * m.px, lev: +(Math.abs(p.basis * p.entry) / p.C).toFixed(1), collateral: p.C, entry: p.entry, mark: m.px, liq: liqEstimate(p, m), pnl: p.PNL, withdraw: withdrawable(p, s.H), reserved: Math.max(0, p.R), roe: p.PNL / p.C * 100, adl: 1 - m[p.side].A };
  });
  return { wallet: addr, usdc: w.usdc, realized: w.realized, positions, H: s.H };
}
function liqEstimate(p, m) {
  // solve  C + PnL + basis*(liq - mark) = basis*liq*mm  for liq  (mm = maintenance rate)
  const mm = MAINT_BPS / 1e4, b = Math.abs(p.basis), mark = m.px;
  if (b < 1e-12) return 0;
  if (p.side === 'long') return Math.max(0, (b * mark - p.C - p.PNL) / (b * (1 - mm)));
  return (p.C + p.PNL + b * mark) / (b * (1 + mm));
}
function metrics() {
  const s = solvency();
  let oi = 0; for (const m of MKT) oi += (m.long.OI + m.short.OI) * m.px;
  const lb = Object.entries(db.wallets).filter(([a]) => !a.startsWith('Bot')).map(([a, w]) => ({ wallet: a.slice(0, 4) + '…' + a.slice(-4), realized: w.realized, open: db.pos.filter((p) => p.wallet === a).length }))
    .filter((x) => x.realized !== 0 || x.open > 0).sort((a, b) => b.realized - a.realized).slice(0, 8);
  return { token: TOKEN, mint: IVY_MINT, oi, traders: Object.keys(db.wallets).filter((a) => !a.startsWith('Bot')).length, openPositions: db.pos.length,
    priceLive: PRICE_OK, priceSource: 'Pyth + DEX',
    vault: s.V, insurance: s.I, capital: s.C_tot, profit: s.pnlPos, residual: s.residual, haircut: s.H, pending: s.pendR, dripPrice: +(0.002 + Math.max(0, s.residual) / 2e7).toFixed(6), leaderboard: lb };
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.woff2': 'font/woff2' };
function serve(req, res) { let u = decodeURIComponent(req.url.split('?')[0]); if (u === '/') u = '/client/landing.html'; if (u === '/app' || u === '/app/' || u === '/trade' || u === '/testnet') u = '/client/index.html'; if (u === '/docs' || u === '/docs/') u = '/client/docs.html'; const f = path.normalize(path.join(ROOT, u)); if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); } fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); }); }
function json(res, c, o) { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }
function body(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e4) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/api/config') return json(res, 200, { token: TOKEN, mint: IVY_MINT, network: 'robinhood-chain', priceLive: PRICE_OK, priceSource: 'Pyth + DEX', lastPrice: LAST_OK, maint_bps: MAINT_BPS, maxMoveBps: MAX_MOVE_BPS, markets: MKT.map((m) => ({ sym: m.sym, maxLev: m.maxLev, dp: m.dp, src: m.src })), chain: CHAIN });
  if (u === '/api/markets') return json(res, 200, markets());
  if (u === '/api/metrics') return json(res, 200, metrics());
  if (u.startsWith('/api/market/')) { const d = marketDetail(u.split('/')[3]); return d ? json(res, 200, d) : json(res, 404, { error: 'no market' }); }
  if (req.method === 'POST') {
    const d = await body(req);
    if (u === '/api/account') { if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'paste a valid 0x wallet' }); return json(res, 200, account(d.wallet)); }
    if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'connect a wallet first' });
    if (u === '/api/open') { const r = openPos(d.wallet, d.market, d.side === 'short' ? 'short' : 'long', d.sizeUsd, d.lev); if (r.error) return json(res, 200, r); save(); return json(res, 200, Object.assign({ ok: true }, account(d.wallet))); }
    if (u === '/api/close') { const p = db.pos.find((x) => x.id === d.id && x.wallet === d.wallet); if (!p) return json(res, 200, { error: 'no position' }); const r = closePos(d.id); if (r.error) return json(res, 200, r); save(); return json(res, 200, Object.assign({ ok: true, closedPnl: r.closedPnl }, account(d.wallet))); }
  }
  serve(req, res);
});

(async () => {
  await fetchPrices(); await fetchDexPrices();                          // seed real prices before accepting traffic
  server.listen(PORT, () => console.log('IVY × percolator engine on :' + PORT + ' — ' + MKT.length + ' markets · Pyth live=' + PRICE_OK));
  setInterval(fetchPrices, 2500); setInterval(fetchDexPrices, 4000);               // live oracle refresh
  setInterval(tick, SEC * 1000);                // settle / liquidate / recover
})();
