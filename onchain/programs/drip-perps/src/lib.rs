//! Drip — on-chain permissionless perps DEX (devnet PROTOTYPE).
//!
//! Wraps the percolator-style solvency engine (see engine.rs) in a Solana program:
//!  - real USDC custody in a program-owned vault (SPL CPI)
//!  - real on-chain Pyth pull-oracle prices (PriceUpdateV2)
//!  - mark-to-market, funding, liquidation & the H haircut all enforced on-chain
//!
//! ⚠️ UNAUDITED PROTOTYPE. Devnet / test funds only. Do NOT deploy to mainnet with
//! real funds without a professional audit (the engine it ports is itself unaudited).
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

pub mod state;
pub mod engine;
pub mod errors;

use crate::engine::*;
use crate::errors::DripError;
use crate::state::*;

declare_id!("Dr1pPerpsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

const PRICE_MAX_AGE: u64 = 60; // seconds
const EXCHANGE_SEED: &[u8] = b"exchange";
const VAULT_SEED: &[u8] = b"vault";

/// normalize a Pyth price (price * 10^expo) to our PRICE_SCALE (1e9) i128.
fn norm_price(price: i64, expo: i32) -> i128 {
    let p = price as i128;
    // target = p * 10^expo * PRICE_SCALE
    let shift = expo + 9; // because PRICE_SCALE = 1e9
    if shift >= 0 {
        p.saturating_mul(10i128.saturating_pow(shift as u32))
    } else {
        p / 10i128.saturating_pow((-shift) as u32)
    }
}

#[program]
pub mod drip_perps {
    use super::*;

    /// One-time: create the exchange + the program-owned USDC vault.
    pub fn init_exchange(
        ctx: Context<InitExchange>,
        maint_bps: u16,
        fee_bps: u16,
        liq_fee_bps: u16,
        max_move_bps: u16,
    ) -> Result<()> {
        let ex = &mut ctx.accounts.exchange;
        ex.authority = ctx.accounts.authority.key();
        ex.usdc_mint = ctx.accounts.usdc_mint.key();
        ex.vault = ctx.accounts.vault.key();
        ex.insurance = 0;
        ex.capital_tot = 0;
        ex.pnl_pos_tot = 0;
        ex.market_count = 0;
        ex.maint_bps = maint_bps;
        ex.fee_bps = fee_bps;
        ex.liq_fee_bps = liq_fee_bps;
        ex.max_move_bps = max_move_bps;
        ex.bump = ctx.bumps.exchange;
        ex.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Authority adds a market bound to a Pyth feed id (hex string, no 0x).
    pub fn init_market(ctx: Context<InitMarket>, symbol: [u8; 8], feed_hex: String, max_lev: u16) -> Result<()> {
        let m = &mut ctx.accounts.market;
        m.exchange = ctx.accounts.exchange.key();
        m.symbol = symbol;
        m.feed_id = get_feed_id_from_hex(&feed_hex).map_err(|_| DripError::WrongFeed)?;
        m.max_lev = max_lev;
        m.funding_rate_e9 = 0;
        m.p_last = 0;
        m.last_slot = 0;
        m.long = Side::fresh();
        m.short = Side::fresh();
        m.bump = ctx.bumps.market;
        ctx.accounts.exchange.market_count += 1;
        Ok(())
    }

    /// Deposit real USDC into the vault → credited to the user's free collateral.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, DripError::BadSize);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        let c = &mut ctx.accounts.collateral;
        if c.owner == Pubkey::default() { c.owner = ctx.accounts.owner.key(); c.bump = ctx.bumps.collateral; }
        c.free = c.free.checked_add(amount).ok_or(DripError::Overflow)?;
        Ok(())
    }

    /// Withdraw free collateral back to the user's wallet. Blocked if it would
    /// push the vault below (capital + insurance) — solvency is enforced on-chain.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let c = &mut ctx.accounts.collateral;
        require!(amount > 0 && amount <= c.free, DripError::InsufficientCollateral);
        let ex = &ctx.accounts.exchange;
        let vault_after = ctx.accounts.vault.amount.saturating_sub(amount);
        require!(vault_after as u128 >= ex.capital_tot as u128 + ex.insurance as u128, DripError::SolvencyBreach);

        c.free -= amount;
        let seeds: &[&[u8]] = &[EXCHANGE_SEED, &[ex.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.exchange.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    /// Permissionless crank: mark a market to the latest Pyth price + accrue funding.
    pub fn crank(ctx: Context<Crank>, funding_rate_e9: i64) -> Result<()> {
        let ex = &ctx.accounts.exchange;
        let m = &mut ctx.accounts.market;
        let pf = &ctx.accounts.price_update;
        let price = pf
            .get_price_no_older_than(&Clock::get()?, PRICE_MAX_AGE, &m.feed_id)
            .map_err(|_| DripError::StalePrice)?;
        let target = norm_price(price.price, price.exponent);
        // keeper supplies a clamped funding rate; engine bounds the price move itself.
        m.funding_rate_e9 = funding_rate_e9.clamp(-800_000, 800_000);
        if m.p_last == 0 { m.p_last = target; } else { apply_mark(m, target, ex.max_move_bps); }
        m.last_slot = Clock::get()?.slot;
        recover(m);
        Ok(())
    }

    /// Open a leveraged position. Margin = size/lev locked from free collateral;
    /// taker fee → insurance; position snapshots the current A/K/F indices.
    pub fn open_position(ctx: Context<OpenPosition>, side: u8, size_usdc: u64, lev: u16) -> Result<()> {
        require!(size_usdc > 0, DripError::BadSize);
        let ex = &mut ctx.accounts.exchange;
        let m = &mut ctx.accounts.market;
        let s = if side == SIDE_SHORT { SIDE_SHORT } else { SIDE_LONG };
        require!(m.side(s).mode == MODE_NORMAL, DripError::SideInRecovery);
        require!(lev >= 1 && lev <= m.max_lev, DripError::BadLeverage);
        require!(m.p_last > 0, DripError::StalePrice);

        let pos = &mut ctx.accounts.position;
        require!(!pos.is_open, DripError::PositionOpen);

        let margin = size_usdc / lev as u64;
        let fee = ((size_usdc as i128 * ex.fee_bps as i128) / BPS) as u64;
        let c = &mut ctx.accounts.collateral;
        require!(c.free >= margin + fee, DripError::InsufficientCollateral);
        c.free -= margin + fee;
        ex.insurance = ex.insurance.checked_add(fee).ok_or(DripError::Overflow)?;
        ex.capital_tot = ex.capital_tot.checked_add(margin).ok_or(DripError::Overflow)?;

        // basis (micro-tokens) = size * PRICE_SCALE / price
        let basis = ((size_usdc as i128 * PRICE_SCALE) / m.p_last) as u128;
        let sd = m.side_mut(s);
        sd.oi = sd.oi.checked_add(basis).ok_or(DripError::Overflow)?;

        pos.owner = ctx.accounts.owner.key();
        pos.market = m.key();
        pos.side = s;
        pos.basis = basis;
        pos.a_basis = sd.a;
        pos.k_snap = sd.k;
        pos.f_snap = sd.f;
        pos.epoch = sd.epoch;
        pos.margin = margin;
        pos.pnl = 0;
        pos.reserve = 0;
        pos.entry = m.p_last;
        pos.open_slot = Clock::get()?.slot;
        pos.is_open = true;
        pos.bump = ctx.bumps.position;
        Ok(())
    }

    /// Close a position. Settles index PnL, applies the haircut on positive PnL,
    /// pays out to free collateral, returns margin, closes OI.
    pub fn close_position(ctx: Context<ModifyPosition>) -> Result<()> {
        let ex = &mut ctx.accounts.exchange;
        let m = &mut ctx.accounts.market;
        let pos = &mut ctx.accounts.position;
        require!(pos.is_open, DripError::NoPosition);
        let s = pos.side;

        let prev_pos = pos_pnl_pos(pos);
        settle(pos, m.side(s));
        update_pnl_pos_tot(ex, prev_pos, pos_pnl_pos(pos)); // reflect settle delta in ΣPnL⁺
        let eff_oi = pos.basis.min(m.side(s).oi);

        let h = {
            let vb = ctx.accounts.vault.amount;
            haircut(vb, ex.capital_tot, ex.insurance, ex.pnl_pos_tot)
        };
        let fee = ((risk_notional(pos, m.side(s), m.p_last) as i128 * ex.fee_bps as i128) / BPS) as u64;
        let payout = engine::withdrawable(pos, h.0, h.1).saturating_sub(fee);

        // book-keeping: closing removes this position's capital + profit claim
        update_pnl_pos_tot(ex, pos_pnl_pos(pos), 0);
        ex.capital_tot = ex.capital_tot.saturating_sub(pos.margin);
        ex.insurance = ex.insurance.saturating_add(fee);
        // reduce OI
        { let sd = m.side_mut(s); sd.oi = sd.oi.saturating_sub(eff_oi); }
        recover(m);

        // pay out to free collateral
        let c = &mut ctx.accounts.collateral;
        c.free = c.free.checked_add(payout).ok_or(DripError::Overflow)?;

        // close
        pos.is_open = false;
        pos.basis = 0;
        pos.pnl = 0;
        pos.margin = 0;
        Ok(())
    }

    /// Permissionless liquidation: anyone can crank-then-liquidate an underwater
    /// position. Deficit is spent from insurance, remainder socialized via K (ADL).
    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        let ex = &mut ctx.accounts.exchange;
        let m = &mut ctx.accounts.market;
        let pos = &mut ctx.accounts.position;
        require!(pos.is_open, DripError::NoPosition);
        let s = pos.side;

        let prev_pos = pos_pnl_pos(pos);
        settle(pos, m.side(s));
        update_pnl_pos_tot(ex, prev_pos, pos_pnl_pos(pos));
        require!(is_liquidatable(pos, m.side(s), m.p_last, ex.maint_bps), DripError::NotLiquidatable);

        let notional = risk_notional(pos, m.side(s), m.p_last);
        let liq_fee = ((notional as i128 * ex.liq_fee_bps as i128) / BPS) as u64;
        let equity = pos.margin as i128 + pos.pnl;
        let payout = (equity - liq_fee as i128).max(0) as u64; // to owner, usually ~0
        let deficit = if equity < 0 { (-equity) as u64 } else { 0 };
        let eff_oi = pos.basis.min(m.side(s).oi);

        // aggregates: closing removes this position's capital + profit claim
        update_pnl_pos_tot(ex, pos_pnl_pos(pos), 0);
        ex.capital_tot = ex.capital_tot.saturating_sub(pos.margin);
        // spend insurance against the deficit; remainder socializes via ADL
        let pay = deficit.min(ex.insurance);
        ex.insurance -= pay;
        let uninsured = deficit - pay;
        adl_shrink_and_socialize(m, s, eff_oi, uninsured);
        recover(m);

        // return any residual equity to the owner's free collateral
        let c = &mut ctx.accounts.collateral;
        c.free = c.free.checked_add(payout).ok_or(DripError::Overflow)?;

        pos.is_open = false;
        pos.basis = 0;
        pos.pnl = 0;
        pos.margin = 0;
        Ok(())
    }
}

// ----- aggregate helpers -----
fn pos_pnl_pos(pos: &Position) -> u128 { if pos.pnl > 0 { pos.pnl as u128 } else { 0 } }
/// keep ΣPnL⁺ in sync when a position's positive-pnl contribution changes.
fn update_pnl_pos_tot(ex: &mut Exchange, old_pos: u128, new_pos: u128) {
    ex.pnl_pos_tot = ex.pnl_pos_tot.saturating_sub(old_pos).saturating_add(new_pos);
}

// ===================== Accounts =====================

#[derive(Accounts)]
pub struct InitExchange<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = Exchange::LEN, seeds = [EXCHANGE_SEED], bump)]
    pub exchange: Account<'info, Exchange>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init, payer = authority, seeds = [VAULT_SEED], bump,
        token::mint = usdc_mint, token::authority = exchange,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(symbol: [u8; 8])]
pub struct InitMarket<'info> {
    #[account(mut, address = exchange.authority)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    #[account(init, payer = authority, space = Market::LEN, seeds = [b"market", symbol.as_ref()], bump)]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    #[account(init_if_needed, payer = owner, space = Collateral::LEN, seeds = [b"collateral", owner.key().as_ref()], bump)]
    pub collateral: Account<'info, Collateral>,
    #[account(mut, address = exchange.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = exchange.usdc_mint, token::authority = owner)]
    pub user_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    #[account(mut, seeds = [b"collateral", owner.key().as_ref()], bump = collateral.bump, has_one = owner)]
    pub collateral: Account<'info, Collateral>,
    #[account(mut, address = exchange.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = exchange.usdc_mint, token::authority = owner)]
    pub user_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Crank<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    #[account(mut, has_one = exchange)]
    pub market: Account<'info, Market>,
    pub price_update: Account<'info, PriceUpdateV2>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    #[account(mut, has_one = exchange)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"collateral", owner.key().as_ref()], bump = collateral.bump, has_one = owner)]
    pub collateral: Account<'info, Collateral>,
    #[account(
        init_if_needed, payer = owner, space = Position::LEN,
        seeds = [b"position", owner.key().as_ref(), market.key().as_ref()], bump
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ModifyPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    #[account(mut, has_one = exchange)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"collateral", owner.key().as_ref()], bump = collateral.bump, has_one = owner)]
    pub collateral: Account<'info, Collateral>,
    #[account(mut, seeds = [b"position", owner.key().as_ref(), market.key().as_ref()], bump = position.bump, has_one = owner, has_one = market)]
    pub position: Account<'info, Position>,
    #[account(mut, address = exchange.vault)]
    pub vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    /// permissionless — anyone can call
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    #[account(mut, has_one = exchange)]
    pub market: Account<'info, Market>,
    /// CHECK: collateral PDA of the position owner, derived & validated by seeds
    #[account(mut, seeds = [b"collateral", position.owner.as_ref()], bump = collateral.bump)]
    pub collateral: Account<'info, Collateral>,
    #[account(mut, seeds = [b"position", position.owner.as_ref(), market.key().as_ref()], bump = position.bump, has_one = market)]
    pub position: Account<'info, Position>,
}
