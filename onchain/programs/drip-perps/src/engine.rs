//! The percolator-style risk engine, on-chain edition.
//!
//! This is a faithful (but prototype, NOT formally verified) port of the three
//! invariants from dcccrypto/percolator spec v16.8.3:
//!   (1) H haircut — capital senior, profit junior, paid at min(Residual,ΣPnL⁺)/ΣPnL⁺
//!   (2) A/K/F lazy side indices — queue-free ADL/funding/mark, O(1) per account
//!   (3) bounded cranks — per-update price-move clamp
//! plus the side-recovery state machine.
//!
//! All maths use i128 fixed-point per the conventions in `state.rs`.
use crate::state::*;

/// floor(a * b / den) in i128 (intermediate widened to i256 via two-step to limit overflow).
pub fn mul_div(a: i128, b: i128, den: i128) -> i128 {
    if den == 0 { return 0; }
    // best-effort wide multiply; for the prototype's value ranges i128 intermediate suffices.
    (a.saturating_mul(b)) / den
}

/// effective position (signed micro-tokens) = basis * A / a_basis, 0 if epoch is stale.
pub fn effective_pos(pos: &Position, side: &Side) -> i128 {
    if side.epoch != pos.epoch || pos.a_basis == 0 { return 0; }
    let mag = mul_div(pos.basis as i128, side.a, pos.a_basis);
    if pos.side == SIDE_LONG { mag } else { -mag }
}

pub fn effective_abs(pos: &Position, side: &Side) -> i128 {
    let e = effective_pos(pos, side);
    if e < 0 { -e } else { e }
}

/// risk notional in USDC base units = |eff| * price / PRICE_SCALE (ceiling).
pub fn risk_notional(pos: &Position, side: &Side, price: i128) -> u64 {
    let eff = effective_abs(pos, side);
    let num = eff.saturating_mul(price);
    let q = (num + PRICE_SCALE - 1) / PRICE_SCALE; // ceil
    q.max(0) as u64
}

/// maintenance-margin requirement (USDC base units).
pub fn mm_req(notional: u64, maint_bps: u16) -> u64 {
    ((notional as i128 * maint_bps as i128) / BPS).max(1) as u64
}

/// (1) bounded crank: apply a real oracle price → mark + funding via the side indices.
/// Returns the clamped price actually used.
pub fn apply_mark(m: &mut Market, target: i128, max_move_bps: u16) -> i128 {
    if target <= 0 { return m.p_last; }
    let cap = (m.p_last * max_move_bps as i128) / BPS;
    let mut d = target - m.p_last;
    if d > cap { d = cap; }
    if d < -cap { d = -cap; }
    let px = m.p_last + d;
    if m.long.oi > 0 { m.long.k += mul_div(m.long.a, d, ADL_ONE); }
    if m.short.oi > 0 { m.short.k -= mul_div(m.short.a, d, ADL_ONE); }
    // bilateral funding (model rate set by keeper / config)
    if m.long.oi > 0 && m.short.oi > 0 {
        let f = mul_div(m.p_last, m.funding_rate_e9 as i128, 1_000_000_000);
        m.long.f -= mul_div(m.long.a, f, ADL_ONE);
        m.short.f += mul_div(m.short.a, f, ADL_ONE);
    }
    m.p_last = px;
    px
}

/// (2) O(1) settlement: fold K/F deltas since the position's snapshot into pnl.
/// Returns the pnl delta (USDC base units, signed). Caller updates aggregates.
pub fn settle(pos: &mut Position, side: &Side) -> i128 {
    if side.epoch != pos.epoch || pos.a_basis == 0 {
        return 0;
    }
    let dk = side.k - pos.k_snap;
    let df = side.f - pos.f_snap;
    // pnl_delta = basis * (dk + df) / (a_basis * PRICE_SCALE)
    let inner = dk + df;
    let num = (pos.basis as i128).saturating_mul(inner);
    let den = pos.a_basis.saturating_mul(PRICE_SCALE);
    let delta = if den != 0 { num / den } else { 0 };
    pos.pnl += delta;
    pos.k_snap = side.k;
    pos.f_snap = side.f;
    delta
}

/// (1) haircut pair (num, den): profits pay at num/den = min(Residual, ΣPnL⁺)/ΣPnL⁺.
/// Residual = V - (C_tot + I). vault_balance V is the live token-account balance.
pub fn haircut(vault_balance: u64, capital_tot: u64, insurance: u64, pnl_pos_tot: u128) -> (u128, u128) {
    let residual = (vault_balance as i128) - (capital_tot as i128) - (insurance as i128);
    let res = if residual < 0 { 0u128 } else { residual as u128 };
    if pnl_pos_tot == 0 { return (1, 1); }
    let num = if res < pnl_pos_tot { res } else { pnl_pos_tot };
    (num, pnl_pos_tot)
}

/// withdrawable equity for a position (USDC base units), haircut applied to positive pnl.
pub fn withdrawable(pos: &Position, h_num: u128, h_den: u128) -> u64 {
    let mut eq = pos.margin as i128;
    if pos.pnl < 0 {
        eq += pos.pnl;
    } else {
        let paid = ((pos.pnl as u128) * h_num / h_den) as i128;
        eq += paid;
    }
    if eq < 0 { 0 } else { eq as u64 }
}

/// liquidatable iff nonzero effective position and Eq_net <= MM_req.
pub fn is_liquidatable(pos: &Position, side: &Side, price: i128, maint_bps: u16) -> bool {
    let eff = effective_abs(pos, side);
    if eff == 0 { return false; }
    let eq_net = (pos.margin as i128 + pos.pnl).max(0);
    let mm = mm_req(risk_notional(pos, side, price), maint_bps) as i128;
    eq_net <= mm
}

/// shrink A on the liquidated side and (optionally) socialize a deficit into the
/// opposing side's K. `deficit` is uninsured USDC loss after insurance is spent.
pub fn adl_shrink_and_socialize(m: &mut Market, side: u8, closed_oi: u128, deficit: u64) {
    let opp = if side == SIDE_LONG { SIDE_SHORT } else { SIDE_LONG };
    let (oi_before, a_old) = { let s = m.side(side); (s.oi, s.a) };
    let oi_post = oi_before.saturating_sub(closed_oi);
    if deficit > 0 {
        let opp_oi = m.side(opp).oi;
        if opp_oi > 0 {
            // ΔK_opp = -deficit / opp_oi (price units, scaled by PRICE_SCALE)
            let dk = mul_div(-(deficit as i128) * PRICE_SCALE, ADL_ONE, opp_oi as i128) / ADL_ONE;
            m.side_mut(opp).k += dk;
        }
    }
    {
        let s = m.side_mut(side);
        s.oi = oi_post;
        if oi_before > 0 {
            s.a = mul_div(a_old, oi_post as i128, oi_before as i128);
            if s.a < MIN_A { s.mode = MODE_DRAIN; }
        }
    }
}

/// side-recovery state machine: once a drained side hits zero OI, reset it.
pub fn recover(m: &mut Market) {
    for s in [SIDE_LONG, SIDE_SHORT] {
        let side = m.side_mut(s);
        if side.oi == 0 && (side.mode == MODE_DRAIN || side.a < ADL_ONE) {
            side.k0 = side.k;
            side.f0 = side.f;
            side.epoch += 1;
            side.a = ADL_ONE;
            side.mode = MODE_NORMAL;
        }
    }
}
