'use strict';
const $ = (id) => document.getElementById(id);
const api = (u, b) => fetch(u, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : undefined).then((r) => r.json());

let wallet = localStorage.getItem('drip_w') || '';
let sel = 'BONK';                 // selected market
let side = 'long';
let MK = [];                       // markets snapshot
let CUR = null;                    // current market detail (px, hist, dp...)
let A = null;                      // account
let M = null;                      // metrics
// ---- on-chain (Phase 1.5) ----
let cfg = null, CHAIN = null, chainMode = false;
const chainHist = {};              // local price history per market (chain has no server hist)

// ---------- formatting ----------
const dpOf = (s) => { const m = MK.find((x) => x.sym === s); return m ? m.dp : 4; };
function usd(n, d = 2) { if (n == null || !isFinite(n)) return '—'; const neg = n < 0; const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); return (neg ? '-$' : '$') + v; }
function cnt(n) { if (n == null || !isFinite(n)) return '—'; const a = Math.abs(n); if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'; return '$' + n.toFixed(0); }
function px(n, dp) { if (n == null || !isFinite(n)) return '—'; return '$' + (+n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
function signed(n, d = 2) { if (n == null || !isFinite(n)) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(d); }
function toast(msg, kind) { const t = $('toast'); t.textContent = msg; t.className = 'toast on' + (kind ? ' ' + kind : ''); clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = 'toast'), 2600); }

// ---------- wallet ----------
function setConnected() { $('connect').textContent = wallet ? (wallet.slice(0, 4) + '…' + wallet.slice(-4)) : 'Connect'; }
$('connect').onclick = async () => {
  if (chainMode) {
    try { const pk = await CHAIN.connect(); wallet = pk; setConnected(); toast('wallet connected', 'ok'); await loadAccount(); }
    catch (e) { toast(e.message || 'connect failed', 'err'); }
    return;
  }
  if (wallet) $('waddr').value = wallet; $('wmodal').classList.add('on');
};
$('wmodal').onclick = (e) => { if (e.target.id === 'wmodal') $('wmodal').classList.remove('on'); };
$('wsave').onclick = async () => {
  const v = $('waddr').value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(v)) return toast('paste a valid 0x wallet address', 'err');
  wallet = v; localStorage.setItem('drip_w', v); setConnected(); $('wmodal').classList.remove('on'); toast('connected', 'ok'); await loadAccount();
};
function needWallet() { if (!wallet) { $('wmodal').classList.add('on'); return true; } return false; }

// ---------- data ----------
async function loadMarkets() {
  MK = chainMode ? await CHAIN.fetchMarkets() : await api('/api/markets');
  renderMlist();
  const m = MK.find((x) => x.sym === sel);
  if (m) updateHead(m);
}
function renderMlist() {
  $('mlist').innerHTML = MK.map((m) => {
    const cls = m.change >= 0 ? 'up' : 'down';
    return `<div class="mrow ${m.sym === sel ? 'on' : ''}" data-m="${m.sym}">
      <div><div class="s">${m.sym}</div><div class="lev">${m.maxLev}× max</div></div>
      <div><div class="p">${px(m.px, m.dp)}</div><div class="c ${cls}">${signed(m.change)}%</div></div>
    </div>`;
  }).join('');
}
function updateHead(m) {
  const cls = m.change >= 0 ? 'up' : 'down';
  $('m-sym').textContent = m.sym + '-PERP';
  $('m-lev').textContent = m.maxLev + '× max';
  $('m-price').textContent = px(m.px, m.dp);
  $('m-price').className = 'price ' + cls;
  $('m-chg').textContent = signed(m.change) + '%'; $('m-chg').className = 'v ' + cls;
  $('m-fund').textContent = signed(m.funding, 4) + '%'; $('m-fund').className = 'v ' + (m.funding >= 0 ? 'up' : 'down');
  $('c-sym').textContent = m.sym + '/USD · Pyth oracle';
  $('levmax').textContent = 'max ' + m.maxLev + '×';
  $('lev').max = m.maxLev; if (+$('lev').value > m.maxLev) { $('lev').value = m.maxLev; }
}
async function loadMarket() {
  CUR = chainMode ? await CHAIN.fetchMarket(sel) : await api('/api/market/' + sel);
  if (chainMode && CUR && !CUR.error) { // chain has no server-side history → build it locally
    const arr = chainHist[sel] || (chainHist[sel] = []);
    arr.push(CUR.px); if (arr.length > 120) arr.shift(); CUR.hist = arr.slice();
  }
  if (CUR && !CUR.error) { drawChart(); updateOrderReadout(); renderSides(); }
}
function modeTag(m) { return m === 'Normal' ? 'Normal' : `<span class="badge-drain">${m}</span>`; }
function renderSides() {
  if (!CUR || !CUR.long) return; const dp = CUR.dp;
  const L = CUR.long, S = CUR.short;
  $('sd-long').innerHTML = 'A ' + L.A.toFixed(2) + ' · ' + modeTag(L.mode);
  $('sd-short').innerHTML = 'A ' + S.A.toFixed(2) + ' · ' + modeTag(S.mode);
  $('sd-loi').textContent = 'OI ' + cnt(L.OI * CUR.px);
  $('sd-soi').textContent = 'OI ' + cnt(S.OI * CUR.px);
  $('m-oi').textContent = cnt((L.OI + S.OI) * CUR.px);
}
async function loadMetrics() {
  M = chainMode ? await CHAIN.fetchMetrics() : await api('/api/metrics');
  if (M.mint) { $('cabar').style.display = 'flex'; $('ca-mint').textContent = M.mint; }
  const hpct = (M.haircut * 100);
  $('h-oi').textContent = cnt(M.oi); $('h-tr').textContent = M.traders; $('h-res').textContent = cnt(M.residual); $('h-hc').textContent = hpct.toFixed(1) + '%';
  $('h-hc').className = 'v mono ' + (M.haircut >= 0.999 ? 'up' : 'down');
  // solvency engine panel
  $('e-h').textContent = hpct.toFixed(1) + '%';
  $('e-v').textContent = cnt(M.vault); $('e-c').textContent = cnt(M.capital); $('e-i').textContent = cnt(M.insurance);
  $('e-res').textContent = cnt(M.residual); $('e-pnl').textContent = cnt(M.profit); $('e-pend').textContent = cnt(M.pending);
  const stress = M.haircut < 0.999;
  $('e-h').className = 'hval mono' + (stress ? ' stress' : '');
  $('e-hfill').className = 'hfill' + (stress ? ' stress' : ''); $('e-hfill').style.width = Math.max(4, hpct).toFixed(1) + '%';
  $('e-hsub').textContent = stress
    ? 'vault stressed — open profits are paid at ' + hpct.toFixed(1) + '% until losers settle. capital is always whole.'
    : 'profits currently backed at 100% — exits fully funded.';
  const hb = $('hbanner');
  if (stress) { hb.classList.add('on'); hb.innerHTML = '⚠ <b>Backed exits active:</b> profit claims ($' + cnt(M.profit).replace('$', '') + ') exceed the residual buffer ($' + cnt(M.residual).replace('$', '') + '). Profits pay at <b>' + hpct.toFixed(1) + '%</b> — by design, the exchange stays solvent and senior capital is never touched.'; }
  else hb.classList.remove('on');
  // stat cards
  $('s-oi').textContent = cnt(M.oi); $('s-v').textContent = cnt(M.vault); $('s-ins').textContent = cnt(M.insurance); $('s-drip').textContent = '$' + (M.dripPrice || 0).toFixed(6);
  $('lb').innerHTML = (M.leaderboard && M.leaderboard.length) ? M.leaderboard.map((r, i) =>
    `<div class="r"><span class="rk">${i + 1}</span><span class="w">${r.wallet}</span><span class="o">${r.open} open</span><span class="pnl ${r.realized >= 0 ? 'up' : 'down'}">${usd(r.realized)}</span></div>`
  ).join('') : '<div class="empty">no trades yet — be the first</div>';
}
async function loadAccount() {
  if (chainMode) {
    if (!CHAIN.me) { A = null; renderAccount(); return; }
    try { A = await CHAIN.fetchAccount(MK); } catch (e) { A = null; }
    renderAccount(); return;
  }
  if (!wallet) { A = null; renderAccount(); return; }
  const r = await api('/api/account', { wallet });
  if (r.error) { toast(r.error, 'err'); A = null; } else A = r;
  renderAccount();
}
function renderAccount() {
  $('bal').textContent = A ? usd(A.usdc) : '—';
  $('free').textContent = 'free ' + (A ? usd(A.usdc) : '—');
  $('a-real').textContent = A ? usd(A.realized) : '—';
  $('a-real').className = A && A.realized < 0 ? 'down' : 'up';
  $('a-lp').textContent = A ? ((A.H * 100).toFixed(1) + '%') : '—';
  const pos = (A && A.positions) || [];
  $('pos-count').textContent = pos.length; $('postbody').innerHTML = '';
  if (!pos.length) { $('postbody').innerHTML = `<tr><td colspan="9" class="empty">${wallet ? 'No open positions — place a trade.' : 'Connect a wallet to trade.'}</td></tr>`; }
  else $('postbody').innerHTML = pos.map((p) => {
    const dp = dpOf(p.sym);
    const adl = p.adl > 0.005 ? `<br><span style="font-size:9px;color:var(--gold)">ADL −${(p.adl * 100).toFixed(0)}%</span>` : '';
    return `<tr>
      <td style="font-family:Inter;font-weight:700">${p.sym}</td>
      <td><span class="sd ${p.side}">${p.side.toUpperCase()} ${p.lev}×</span>${adl}</td>
      <td>${usd(p.size)}</td><td>${px(p.entry, dp)}</td><td>${px(p.mark, dp)}</td>
      <td class="down">${px(p.liq, dp)}</td>
      <td class="${p.pnl >= 0 ? 'up' : 'down'}">${usd(p.pnl)}<br><span style="font-size:10px;opacity:.7">${signed(p.roe, 1)}%</span></td>
      <td>${usd(p.withdraw)}</td>
      <td><button class="xbtn" data-close="${p.id}">Close</button></td>
    </tr>`;
  }).join('');
  updateOrderReadout();
}

// ---------- chart ----------
function drawChart() {
  const cv = $('chart'); if (!cv || !CUR || !CUR.hist) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const H = CUR.hist.slice(); if (H.length < 2) return;
  const pad = { l: 8, r: 64, t: 24, b: 22 };
  let lo = Math.min(...H), hi = Math.max(...H); if (lo === hi) { hi = lo * 1.001 || 1; lo = lo * 0.999; }
  const span = hi - lo; lo -= span * 0.12; hi += span * 0.12;
  const X = (i) => pad.l + (w - pad.l - pad.r) * (i / (H.length - 1));
  const Y = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));
  const up = H[H.length - 1] >= H[0];
  const col = up ? '#1fe3a4' : '#ff4d5e';
  // grid
  c.strokeStyle = 'rgba(255,255,255,.04)'; c.lineWidth = 1; c.font = "10px 'JetBrains Mono'"; c.textBaseline = 'middle';
  for (let g = 0; g <= 4; g++) {
    const yy = pad.t + (h - pad.t - pad.b) * g / 4; const val = hi - (hi - lo) * g / 4;
    c.beginPath(); c.moveTo(pad.l, yy); c.lineTo(w - pad.r, yy); c.stroke();
    c.fillStyle = '#5b626e'; c.textAlign = 'left'; c.fillText(px(val, CUR.dp).replace('$', ''), w - pad.r + 6, yy);
  }
  // area fill
  const grad = c.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, up ? 'rgba(31,227,164,.22)' : 'rgba(255,77,109,.22)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  c.beginPath(); c.moveTo(X(0), Y(H[0])); for (let i = 1; i < H.length; i++) c.lineTo(X(i), Y(H[i]));
  c.lineTo(X(H.length - 1), h - pad.b); c.lineTo(X(0), h - pad.b); c.closePath(); c.fillStyle = grad; c.fill();
  // line
  c.beginPath(); c.moveTo(X(0), Y(H[0])); for (let i = 1; i < H.length; i++) c.lineTo(X(i), Y(H[i]));
  c.strokeStyle = col; c.lineWidth = 2; c.shadowColor = col; c.shadowBlur = 8; c.lineJoin = 'round'; c.stroke(); c.shadowBlur = 0;
  // last price dot + label
  const lx = X(H.length - 1), ly = Y(H[H.length - 1]);
  c.fillStyle = col; c.beginPath(); c.arc(lx, ly, 3.5, 0, 7); c.fill();
  c.fillStyle = col; c.fillRect(w - pad.r, ly - 9, pad.r, 18);
  c.fillStyle = '#06120d'; c.font = "600 10px 'JetBrains Mono'"; c.textAlign = 'center';
  c.fillText(px(H[H.length - 1], CUR.dp).replace('$', ''), w - pad.r / 2, ly);
  // position lines for selected market
  if (A && A.positions) for (const p of A.positions.filter((x) => x.sym === sel)) {
    [['entry', p.entry, 'rgba(139,147,161,.6)'], ['liq', p.liq, 'rgba(255,77,109,.7)']].forEach(([lbl, v, cc]) => {
      if (v < lo || v > hi) return; const yy = Y(v);
      c.strokeStyle = cc; c.lineWidth = 1; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(pad.l, yy); c.lineTo(w - pad.r, yy); c.stroke(); c.setLineDash([]);
      c.fillStyle = cc; c.textAlign = 'left'; c.font = "9px 'JetBrains Mono'"; c.fillText(lbl, pad.l + 3, yy - 6);
    });
  }
}

// ---------- order panel ----------
document.querySelectorAll('.ls button').forEach((b) => b.onclick = () => {
  side = b.dataset.side;
  document.querySelectorAll('.ls button').forEach((x) => x.classList.toggle('on', x === b));
  updateOrderReadout();
});
$('lev').oninput = () => { $('levv').textContent = $('lev').value + '×'; updateOrderReadout(); };
$('size').oninput = updateOrderReadout;
document.querySelectorAll('.pcts button').forEach((b) => b.onclick = () => {
  if (!A) return needWallet(); const lev = +$('lev').value;
  $('size').value = (A.usdc * (+b.dataset.pct / 100) * lev * 0.99).toFixed(2); updateOrderReadout();
});
function updateOrderReadout() {
  const m = MK.find((x) => x.sym === sel); if (!m) return;
  const dp = m.dp, size = +$('size').value || 0, lev = +$('lev').value;
  const entry = m.px, margin = size / lev, fee = size * 0.0006, mm = 0.005;
  const liq = side === 'long' ? entry * (1 - 1 / lev) / (1 - mm) : entry * (1 + 1 / lev) / (1 + mm);
  $('r-entry').textContent = px(entry, dp);
  $('r-margin').textContent = usd(margin);
  $('r-liq').textContent = px(liq, dp);
  $('r-fee').textContent = usd(fee);
  const btn = $('submit');
  btn.className = 'bigbtn ' + side;
  btn.textContent = (side === 'long' ? 'Long ' : 'Short ') + sel;
}
$('submit').onclick = async () => {
  const size = +$('size').value || 0; if (size <= 0) return toast('enter a size', 'err');
  if (chainMode) {
    if (!CHAIN.me) return toast('connect wallet first', 'err');
    try { toast('confirm in wallet…'); await CHAIN.open(sel, side, size, +$('lev').value); toast(side.toUpperCase() + ' ' + sel + ' opened on-chain', 'ok'); await loadAccount(); loadMetrics(); }
    catch (e) { toast(e.message || 'transaction failed', 'err'); }
    return;
  }
  if (needWallet()) return;
  const r = await api('/api/open', { wallet, market: sel, side, sizeUsd: size, lev: +$('lev').value });
  if (r.error) return toast(r.error, 'err');
  A = r; renderAccount(); loadMetrics(); drawChart();
  toast(side.toUpperCase() + ' ' + sel + ' opened @ ' + px(MK.find((x) => x.sym === sel).px, dpOf(sel)), 'ok');
};

// ---------- close / market select ----------
document.addEventListener('click', async (e) => {
  const mr = e.target.closest('[data-m]');
  if (mr) { sel = mr.dataset.m; renderMlist(); const m = MK.find((x) => x.sym === sel); if (m) updateHead(m); await loadMarket(); updateOrderReadout(); return; }
  const cb = e.target.closest('[data-close]');
  if (cb) {
    if (chainMode) {
      try { toast('confirm in wallet…'); await CHAIN.close(cb.dataset.close); toast('position closed on-chain', 'ok'); await loadAccount(); loadMetrics(); }
      catch (e2) { toast(e2.message || 'transaction failed', 'err'); }
      return;
    }
    const r = await api('/api/close', { wallet, id: cb.dataset.close });
    if (r.error) return toast(r.error, 'err');
    A = r; renderAccount(); loadMetrics(); drawChart();
    toast('closed · ' + (r.closedPnl >= 0 ? 'profit ' : 'loss ') + usd(r.closedPnl), r.closedPnl >= 0 ? 'ok' : 'err');
  }
});

$('ca-copy').onclick = () => { if (M && M.mint) { navigator.clipboard.writeText(M.mint); toast('CA copied', 'ok'); } };

// ---------- on-chain mode wiring ----------
async function setMode(devnet) {
  if (devnet) {
    try {
      if (!CHAIN) { const mod = await import('/client/src/chain.js'); CHAIN = await mod.initChain(cfg.chain); }
      chainMode = true; wallet = ''; setConnected();
      document.getElementById('chainfunds').style.display = 'flex';
      $('free').textContent = 'connect wallet';
      toast('Devnet mode — connect wallet to trade on-chain', 'ok');
    } catch (e) { toast(e.message || 'on-chain unavailable', 'err'); document.getElementById('net-demo').click(); return; }
  } else {
    chainMode = false; wallet = localStorage.getItem('drip_w') || ''; setConnected();
    document.getElementById('chainfunds').style.display = 'none';
  }
  document.querySelectorAll('.netbtn').forEach((b) => b.classList.toggle('on', (b.id === 'net-devnet') === devnet));
  await loadMarkets(); await loadMarket(); await loadMetrics();
  if (chainMode) { if (CHAIN.me) await loadAccount(); else renderAccount(); }
  else if (wallet) await loadAccount(); else renderAccount();
}
async function chainFund(isDeposit) {
  if (!CHAIN || !CHAIN.me) return toast('connect wallet first', 'err');
  const v = parseFloat(window.prompt((isDeposit ? 'Deposit' : 'Withdraw') + ' USDC amount:', '100'));
  if (!v || v <= 0) return;
  try { toast('confirm in wallet…'); await (isDeposit ? CHAIN.deposit(v) : CHAIN.withdraw(v)); toast((isDeposit ? 'deposited ' : 'withdrew ') + v + ' USDC', 'ok'); await loadAccount(); loadMetrics(); }
  catch (e) { toast(e.message || 'transaction failed', 'err'); }
}

// ---------- boot + loops ----------
setConnected();
(async function boot() {
  cfg = await api('/api/config');
  if (cfg && cfg.chain && cfg.chain.programId) {
    const nt = document.getElementById('nettoggle'); if (nt) nt.style.display = 'inline-flex';
    document.getElementById('net-demo').onclick = () => setMode(false);
    document.getElementById('net-devnet').onclick = () => setMode(true);
    document.getElementById('cf-dep').onclick = () => chainFund(true);
    document.getElementById('cf-wd').onclick = () => chainFund(false);
  }
  await loadMarkets(); await loadMarket(); await loadMetrics();
  if (wallet) await loadAccount(); else renderAccount();
})();
window.addEventListener('resize', drawChart);
// fast loop: selected market price + chart + live PnL
setInterval(async () => { await loadMarkets(); await loadMarket(); if (wallet || (chainMode && CHAIN && CHAIN.me)) await loadAccount(); }, 1500);
// slow loop: protocol metrics
setInterval(loadMetrics, 4000);
