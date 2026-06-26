# IDL drop-point

After `anchor build`, copy the generated IDL here so the on-chain client can load it:

```
cp ../../onchain/target/idl/drip_perps.json ./drip_perps.json
```

Then set these env vars on the server to flip on **Devnet** mode in the UI:

```
DRIP_PROGRAM_ID=<deployed program id>
USDC_MINT=<devnet usdc mint>
SOLANA_CLUSTER=devnet
SOLANA_RPC=<optional custom rpc>
```

`client/src/chain.js` fetches `/client/idl/drip_perps.json` at runtime; until this file
exists and the env vars are set, the site stays in off-chain demo mode and never imports it.
