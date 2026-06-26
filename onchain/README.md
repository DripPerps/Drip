# Drip — on-chain perps DEX (devnet prototype)

A real Solana program that turns Drip from a paper simulator into an **on-chain
perpetual-futures exchange**: real USDC custody, real Pyth oracle prices verified
on-chain, and the **percolator-style solvency engine** (H haircut · A/K/F lazy side
indices · bounded cranks · side-recovery) enforced inside the program.

> ⚠️ **UNAUDITED PROTOTYPE — devnet / test funds only.** This ports an engine that
> is itself explicitly unaudited ("Do NOT use with real funds"). Do **not** deploy
> to mainnet with real user funds without professional audits + legal review. Perps
> are regulated derivatives. This is Phase-1 proof-of-product, not a finished protocol.

## What it does

| Instruction | What happens on-chain |
|---|---|
| `init_exchange` | Creates the exchange + a program-owned USDC **vault** PDA |
| `init_market` | Registers a market bound to a **Pyth feed id** |
| `deposit` / `withdraw` | Moves real USDC between wallet and vault; **withdraw is solvency-gated** (vault can't drop below capital + insurance) |
| `crank` | Verifies the latest **Pyth price** on-chain, marks to market (`K += A·ΔP`), accrues funding — permissionless |
| `open_position` | Locks margin, snapshots the A/K/F indices, charges fee → insurance |
| `close_position` | Settles index PnL, applies the **haircut H** to positive PnL, pays out |
| `liquidate` | Permissionless; spends insurance against the deficit, **socializes the remainder via K and shrinks A** (queue-free ADL) |

The haircut uses running aggregates (`capital_tot`, `pnl_pos_tot`) stored on the
exchange so solvency is O(1) — no iterating accounts. `Residual = V − (C_tot + I)`,
profits pay at `H = min(Residual, ΣPnL⁺) / ΣPnL⁺`. Same invariant as the off-chain engine.

## Layout

```
programs/drip-perps/src/
  state.rs    Exchange · Market · Side(A/K/F) · Collateral · Position  (i128 fixed-point)
  engine.rs   effective_pos · apply_mark · settle · haircut · liquidation/ADL · recovery
  errors.rs
  lib.rs      instruction handlers + Anchor account contexts
keeper/keeper.js     posts Pyth updates → cranks every market → sweeps liquidations
migrations/init.js   creates exchange + the 8 markets after deploy
tests/drip-perps.ts  anchor test (init/deposit)
```

## Toolchain (one-time)

This machine has **Rust** but not the Solana/Anchor tools. Install them:

```bash
# Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
# Anchor via avm
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.30.1 && avm use 0.30.1
# a devnet wallet
solana-keygen new -o ~/.config/solana/id.json
solana config set --url devnet && solana airdrop 5
```

> On Windows, build under **WSL2 (Ubuntu)** — the Solana BPF toolchain targets Linux.
> `wsl --install`, then run everything above inside the WSL shell.

## Build → deploy → run

```bash
cd onchain
anchor build                 # compiles the BPF program + generates the IDL
anchor keys sync             # writes the real program id into lib.rs + Anchor.toml
anchor build                 # rebuild with the synced id
anchor deploy --provider.cluster devnet

npm install
# USDC on devnet: make your own test mint, or use a faucet USDC mint
USDC_MINT=<devnet_usdc_mint> ANCHOR_WALLET=~/.config/solana/id.json npm run init
ANCHOR_WALLET=~/.config/solana/id.json npm run keeper   # starts cranking live Pyth prices
```

After that the program is live on devnet: deposit test USDC, open/close positions,
and watch the keeper mark prices + liquidate. `anchor test` runs the unit test.

## Wiring the website to it (Phase 1.5)

The off-chain site (`../`) stays as the fast UI. To make it trade the real program,
swap the `/api/open|close|deposit` calls for client-side Anchor txns (Phantom signs),
and read positions/markets from on-chain accounts instead of the JS ledger. The
percolator math is identical on both sides, so the UI doesn't change — only the
data source does.

## Honest status & the road to mainnet

- ✅ Real custody, real on-chain Pyth prices, real engine — **on devnet**.
- ⛔ Before mainnet/real funds: **audit** (engine + wrapper), extend the Kani-style
  proofs, seed real vault/insurance capital, harden keepers, and get **legal/regulatory
  counsel** (perps = regulated derivatives; geofencing + offshore entity is standard).
- The i128 fixed-point here is a prototype: validate rounding/overflow under `anchor test`
  with adversarial inputs before trusting it with value.
