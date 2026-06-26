// Drip on-chain client (Phase 1.5) — talks to the deployed Anchor program with Phantom.
//
// This activates ONLY once the program is built + deployed (see ../onchain). It needs:
//   1. the generated IDL at  /client/idl/drip_perps.json   (copy from onchain/target/idl/)
//   2. the program id + usdc mint + cluster in /api/config → chain { programId, usdcMint, cluster }
// Until then the site stays in off-chain demo mode and never imports this file.
//
// No build step: dependencies are pulled as browser ESM from esm.sh.
import { Buffer } from 'https://esm.sh/buffer@6.0.3';
globalThis.Buffer = globalThis.Buffer || Buffer;
import { Connection, PublicKey, SystemProgram } from 'https://esm.sh/@solana/web3.js@1.95.8?bundle';
import { AnchorProvider, Program, BN } from 'https://esm.sh/@coral-xyz/anchor@0.30.1?bundle';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from 'https://esm.sh/@solana/spl-token@0.4.8?bundle';

const PRICE_SCALE = 1_000_000_000n; // 1e9
const USDC = 1_000_000n;            // 1e6
const enc = (s) => { const b = Buffer.alloc(8); Buffer.from(s).copy(b); return b; };
const big = (bnOrNum) => BigInt(bnOrNum.toString());
const toUsd = (baseUnits) => Number(big(baseUnits)) / 1e6;

export async function initChain(cfg) {
  const phantom = window.phantom?.solana || window.solana;
  if (!phantom || !phantom.isPhantom) throw new Error('Phantom wallet not found — install it to trade on devnet');

  const connection = new Connection(cfg.rpc || `https://api.${cfg.cluster || 'devnet'}.solana.com`, 'confirmed');
  const idl = await fetch('/client/idl/drip_perps.json').then((r) => { if (!r.ok) throw new Error('IDL not found — build & deploy the program first'); return r.json(); });

  let provider, program, me;
  const usdcMint = new PublicKey(cfg.usdcMint);
  const programId = new PublicKey(cfg.programId);
  const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const exchangePda = pda([Buffer.from('exchange')]);
  const vaultPda = pda([Buffer.from('vault')]);
  const marketPda = (sym) => pda([Buffer.from('market'), enc(sym)]);
  const collateralPda = (owner) => pda([Buffer.from('collateral'), owner.toBuffer()]);
  const positionPda = (owner, market) => pda([Buffer.from('position'), owner.toBuffer(), market.toBuffer()]);

  async function connect() {
    const res = await phantom.connect();
    me = new PublicKey(res.publicKey.toString());
    provider = new AnchorProvider(connection, { publicKey: me, signTransaction: (t) => phantom.signTransaction(t), signAllTransactions: (t) => phantom.signAllTransactions(t) }, { commitment: 'confirmed' });
    program = new Program(idl, provider);
    return me.toBase58();
  }

  // ---- writes ----
  async function deposit(amountUsd) {
    const amt = new BN(Math.round(amountUsd * 1e6));
    const userUsdc = getAssociatedTokenAddressSync(usdcMint, me);
    return program.methods.deposit(amt).accounts({
      owner: me, exchange: exchangePda, collateral: collateralPda(me), vault: vaultPda,
      userUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
  }
  async function withdraw(amountUsd) {
    const amt = new BN(Math.round(amountUsd * 1e6));
    const userUsdc = getAssociatedTokenAddressSync(usdcMint, me);
    return program.methods.withdraw(amt).accounts({
      owner: me, exchange: exchangePda, collateral: collateralPda(me), vault: vaultPda,
      userUsdc, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
  }
  async function open(sym, side, sizeUsd, lev) {
    const market = marketPda(sym);
    return program.methods.openPosition(side === 'short' ? 1 : 0, new BN(Math.round(sizeUsd * 1e6)), lev).accounts({
      owner: me, exchange: exchangePda, market, collateral: collateralPda(me),
      position: positionPda(me, market), systemProgram: SystemProgram.programId,
    }).rpc();
  }
  async function close(sym) {
    const market = marketPda(sym);
    return program.methods.closePosition().accounts({
      owner: me, exchange: exchangePda, market, collateral: collateralPda(me),
      position: positionPda(me, market), vault: vaultPda,
    }).rpc();
  }

  // ---- reads (mapped into the same shapes the UI renderers expect) ----
  function priceOf(m) { return Number(big(m.pLast)) / 1e9; }
  function effPos(p, side) {
    if (big(side.epoch) !== big(p.epoch) || big(p.aBasis) === 0n) return 0n;
    return big(p.basis) * big(side.a) / big(p.aBasis);
  }
  async function fetchMarkets() {
    const all = await program.account.market.all();
    return all.map(({ account: m }) => {
      const sym = Buffer.from(m.symbol).toString('utf8').replace(/\0+$/, '');
      return { sym, px: priceOf(m), dp: sym === 'SOL' ? 2 : sym === 'BONK' ? 7 : 4, change: 0,
        funding: Number(big(m.fundingRateE9)) / 1e7, maxLev: m.maxLev,
        longMode: ['Normal', 'DrainOnly', 'ResetPending'][m.long.mode], shortMode: ['Normal', 'DrainOnly', 'ResetPending'][m.short.mode] };
    });
  }
  async function fetchMarket(sym) {
    const m = await program.account.market.fetch(marketPda(sym));
    const side = (s) => ({ A: Number(big(s.a)) / 1e9, K: Number(big(s.k)), F: Number(big(s.f)), OI: Number(big(s.oi)) / 1e6 * priceOf(m), epoch: Number(big(s.epoch)), mode: ['Normal', 'DrainOnly', 'ResetPending'][s.mode] });
    return { sym, px: priceOf(m), dp: sym === 'SOL' ? 2 : sym === 'BONK' ? 7 : 4, change: 0, funding: Number(big(m.fundingRateE9)) / 1e7, maxLev: m.maxLev, hist: [], long: side(m.long), short: side(m.short) };
  }
  async function fetchExchange() {
    const ex = await program.account.exchange.fetch(exchangePda);
    let vaultBal = 0n; try { const v = await connection.getTokenAccountBalance(vaultPda); vaultBal = BigInt(v.value.amount); } catch (e) {}
    const residual = vaultBal - big(ex.capitalTot) - big(ex.insurance);
    const pnlPos = big(ex.pnlPosTot);
    const H = pnlPos > 0n ? Math.min(1, Math.max(0, Number(residual) / Number(pnlPos))) : 1;
    return { ex, vaultBal, residual, pnlPos, H };
  }
  async function fetchMetrics() {
    const { ex, vaultBal, residual, pnlPos, H } = await fetchExchange();
    return { token: 'DRIP', mint: cfg.dripMint || '', oi: 0, traders: ex.marketCount,
      vault: toUsd(vaultBal), insurance: toUsd(ex.insurance), capital: toUsd(ex.capitalTot),
      profit: Number(pnlPos) / 1e6, residual: Number(residual) / 1e6, haircut: H, pending: 0,
      dripPrice: 0.002, leaderboard: [], onchain: true };
  }
  async function fetchAccount(markets) {
    const free = await program.account.collateral.fetchNullable(collateralPda(me));
    const { H } = await fetchExchange();
    const positions = [];
    for (const mk of markets) {
      const market = marketPda(mk.sym);
      const p = await program.account.position.fetchNullable(positionPda(me, market));
      if (!p || !p.isOpen) continue;
      const m = await program.account.market.fetch(market);
      const side = p.side === 1 ? m.short : m.long;
      const eff = effPos(p, side);
      const px = priceOf(m);
      const sizeUsd = Number(eff < 0n ? -eff : eff) / 1e6 * px;
      const pnl = Number(big(p.pnl)) / 1e6;
      const margin = toUsd(p.margin);
      positions.push({ id: mk.sym, sym: mk.sym, side: p.side === 1 ? 'short' : 'long',
        size: sizeUsd, lev: +(margin > 0 ? sizeUsd / margin : 0).toFixed(1), collateral: margin,
        entry: Number(big(p.entry)) / 1e9, mark: px, liq: 0, pnl,
        withdraw: margin + (pnl < 0 ? pnl : pnl * H), reserved: 0, roe: margin > 0 ? pnl / margin * 100 : 0,
        adl: 1 - Number(big(side.a)) / 1e9 });
    }
    return { wallet: me.toBase58(), usdc: free ? toUsd(free.free) : 0, realized: 0, positions, H };
  }

  return { connect, deposit, withdraw, open, close, fetchMarkets, fetchMarket, fetchMetrics, fetchAccount, get me() { return me?.toBase58(); } };
}
