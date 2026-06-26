# Drip — permissionless perps on Solana

Permissionless perpetual-futures on any Solana token, built on a **percolator-style risk
engine** that makes the exchange *structurally solvent*. Capital is senior, profit is junior —
**no account can ever withdraw more value than actually exists.**

> **Status:** testnet / paper-traded on **real Pyth oracle prices**. The engine, marks, funding,
> liquidations and the haircut are all genuinely live; positions & USDC are simulated, so nothing
> is at risk. The on-chain Anchor program is built (devnet). Real custody opens after an audit.
> **Live:** https://dripperps.xyz

## Why it can't go insolvent

Three invariants (faithful to the percolator design):

- **H — the haircut (backed exits).** `Residual = V − (C + I)`. Profits are paid at
  `H = min(Residual, ΣPnL⁺) / ΣPnL⁺`. Capital is senior; profit is junior. Withdrawals can never
  exceed the vault's real balance.
- **A / K / F — lazy side indices (queue-free ADL).** Mark, funding and socialized losses accrue
  into per-side accumulators. A liquidation shrinks the side's `A`; a deficit shifts `K` — everyone
  on that side absorbs a tiny, fair, proportional slice. No ADL victim queue, O(1) per account.
- **Bounded cranks.** Repricing is capped per slot (`|ΔP| ≤ budget`), so an oracle spike can't
  blow open interest through unbudgeted loss.

Plus a self-healing side-recovery state machine — no admin, no governance switch.

## Layout

```
server/    dependency-free Node engine (8 markets, real Pyth prices, the solvency engine)
client/    the landing page + the live trading terminal (/app)
onchain/   the on-chain Anchor program (devnet prototype) + keeper — see onchain/README.md
```

Run locally: `node server/index.js` → http://localhost:8105

## Honest disclaimer

This is a **demo / simulation**. It is **unaudited**. Perpetual futures with leverage are
extremely high-risk and can be liquidated to zero. Do not treat any of this as financial advice,
and do not use it with real funds until it has been independently audited.

---

[dripperps.xyz](https://dripperps.xyz) · [x.com/DripPerps](https://x.com/DripPerps) · **$DRIP**
