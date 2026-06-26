use anchor_lang::prelude::*;

#[error_code]
pub enum DripError {
    #[msg("market side is in recovery — closes only")]
    SideInRecovery,
    #[msg("leverage out of range for this market")]
    BadLeverage,
    #[msg("size must be positive")]
    BadSize,
    #[msg("not enough free collateral for margin + fee")]
    InsufficientCollateral,
    #[msg("withdrawal would breach exchange solvency")]
    SolvencyBreach,
    #[msg("position already open for this market")]
    PositionOpen,
    #[msg("no open position")]
    NoPosition,
    #[msg("position is healthy — not liquidatable")]
    NotLiquidatable,
    #[msg("oracle price feed mismatch for this market")]
    WrongFeed,
    #[msg("oracle price is stale")]
    StalePrice,
    #[msg("math overflow")]
    Overflow,
}
