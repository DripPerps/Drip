//! On-chain state for Drip perps.
//!
//! Fixed-point conventions (all i128 unless noted):
//!   PRICE_SCALE = 1e9   → a price of $68.74 is stored as 68_740_000_000.
//!   ADL_ONE     = 1e9   → side index A starts at 1.0 == ADL_ONE (no deleverage).
//!   Money (USDC) is in native base units (1e6 = $1), matching the USDC mint's 6 decimals.
//!   `basis` is position size in micro-tokens: basis = size_usdc * PRICE_SCALE / entry_price.
//!       so notional_usdc = basis * price / PRICE_SCALE.
use anchor_lang::prelude::*;

pub const PRICE_SCALE: i128 = 1_000_000_000; // 1e9
pub const ADL_ONE: i128 = 1_000_000_000; // 1e9
pub const BPS: i128 = 10_000;
pub const MIN_A: i128 = ADL_ONE / 4; // 0.25 → DrainOnly below this

pub const SIDE_LONG: u8 = 0;
pub const SIDE_SHORT: u8 = 1;

pub const MODE_NORMAL: u8 = 0;
pub const MODE_DRAIN: u8 = 1;
pub const MODE_RESET: u8 = 2;

/// Per-side lazy indices (the A/K/F of the percolator engine).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct Side {
    pub a: i128,     // deleverage index (ADL_ONE == no ADL)
    pub k: i128,     // accumulated mark   (price units)
    pub f: i128,     // accumulated funding (price units)
    pub oi: u128,    // open interest in micro-tokens
    pub epoch: u64,  // bumped on side reset
    pub mode: u8,    // MODE_*
    pub k0: i128,    // epoch-start K snapshot (for stale settlement)
    pub f0: i128,
}
impl Side {
    pub fn fresh() -> Self {
        Side { a: ADL_ONE, k: 0, f: 0, oi: 0, epoch: 0, mode: MODE_NORMAL, k0: 0, f0: 0 }
    }
    pub const LEN: usize = 16 + 16 + 16 + 16 + 8 + 1 + 16 + 16;
}

/// Global exchange / balance sheet. Maintains the running aggregates the
/// haircut needs so solvency is O(1) (no iterating accounts on-chain).
#[account]
pub struct Exchange {
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,       // vault token account (authority = exchange PDA)
    pub insurance: u64,      // I
    pub capital_tot: u64,    // C_tot  (Σ locked margin)
    pub pnl_pos_tot: u128,   // ΣPnL⁺  (running sum of positive position PnL)
    pub market_count: u32,
    pub maint_bps: u16,      // maintenance margin rate
    pub fee_bps: u16,        // taker fee
    pub liq_fee_bps: u16,    // liquidation fee
    pub max_move_bps: u16,   // bounded-crank per-update clamp
    pub bump: u8,
    pub vault_bump: u8,
}
impl Exchange {
    pub const LEN: usize = 8 + 32 * 3 + 8 + 8 + 16 + 4 + 2 * 4 + 1 + 1;
}

/// One perp market, keyed by Pyth feed id.
#[account]
pub struct Market {
    pub exchange: Pubkey,
    pub symbol: [u8; 8],
    pub feed_id: [u8; 32],   // Pyth price feed id
    pub max_lev: u16,
    pub funding_rate_e9: i64, // per-crank funding rate (×1e9)
    pub p_last: i128,         // last marked price (PRICE_SCALE)
    pub last_slot: u64,
    pub long: Side,
    pub short: Side,
    pub bump: u8,
}
impl Market {
    pub const LEN: usize = 8 + 32 + 8 + 32 + 2 + 8 + 16 + 8 + Side::LEN * 2 + 1;
    pub fn side(&self, s: u8) -> &Side { if s == SIDE_LONG { &self.long } else { &self.short } }
    pub fn side_mut(&mut self, s: u8) -> &mut Side { if s == SIDE_LONG { &mut self.long } else { &mut self.short } }
}

/// Per-user free collateral (USDC not locked in a position).
#[account]
pub struct Collateral {
    pub owner: Pubkey,
    pub free: u64,
    pub bump: u8,
}
impl Collateral { pub const LEN: usize = 8 + 32 + 8 + 1; }

/// One open position per (user, market).
#[account]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: u8,
    pub basis: u128,      // micro-tokens
    pub a_basis: i128,    // snapshot of A at open
    pub k_snap: i128,
    pub f_snap: i128,
    pub epoch: u64,
    pub margin: u64,      // C locked
    pub pnl: i128,        // settled index PnL (signed, USDC base units)
    pub reserve: u64,     // R (warmup) — reserved fresh profit
    pub entry: i128,      // entry price (PRICE_SCALE), display
    pub open_slot: u64,
    pub is_open: bool,
    pub bump: u8,
}
impl Position { pub const LEN: usize = 8 + 32 * 2 + 1 + 16 + 16 * 3 + 8 + 8 + 16 + 8 + 16 + 8 + 1 + 1; }
