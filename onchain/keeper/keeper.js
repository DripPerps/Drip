/**
 * Drip keeper — posts Pyth price updates, cranks each market, and liquidates
 * underwater positions. Permissionless: anyone can run this against the program.
 *
 *   npm i @coral-xyz/anchor @solana/web3.js @pythnetwork/pyth-solana-receiver
 *   ANCHOR_WALLET=~/.config/solana/id.json RPC=https://api.devnet.solana.com node keeper.js
 *
 * Funding rate here is a simple model value (paper-market style). A production
 * keeper would derive it from the long/short OI skew and clamp per config.
 */
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { PythSolanaReceiver } = require('@pythnetwork/pyth-solana-receiver');
const fs = require('fs');

const RPC = process.env.RPC || 'https://api.devnet.solana.com';
const HERMES = 'https://hermes.pyth.network/v2/updates/price/latest';
const CRANK_MS = 4000;

// markets: symbol → Pyth feed id (hex, no 0x). Must match what init_market registered.
const FEEDS = {
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  BONK: '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
  WIF: '4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
  POPCAT: 'b9312a7ee50e189ef045aa3c7842e099b061bd9bdc99ac645956c3b660dc8cce',
  PNUT: '116da895807f81f6b5c5f01b109376e7f6834dc8b51365ab7cdfa66634340e54',
  GOAT: 'f7731dc812590214d3eb4343bfb13d1b4cfa9b1d4e020644b5d5d8e07d60c66c',
  MOODENG: 'ffff73128917a90950cd0473fd2551d7cd274fd5a6cc45641881bbcc6ee73417',
  FARTCOIN: '58cd29ef0e714c5affc44f269b2c1899a52da4169d7acc147b9da692e6953608',
};
const sym8 = (s) => { const b = Buffer.alloc(8); Buffer.from(s).copy(b); return b; };

async function main() {
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET, 'utf8'))));
  const connection = new Connection(RPC, 'confirmed');
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);
  const program = anchor.workspace.DripPerps; // resolves from target/idl after `anchor build`
  const receiver = new PythSolanaReceiver({ connection, wallet });

  const [exchange] = PublicKey.findProgramAddressSync([Buffer.from('exchange')], program.programId);

  async function fetchUpdate(feed) {
    const r = await fetch(`${HERMES}?ids[]=${feed}&encoding=base64`);
    const j = await r.json();
    return j.binary.data[0];
  }

  async function crankMarket(symbol, feed) {
    const [market] = PublicKey.findProgramAddressSync([Buffer.from('market'), sym8(symbol)], program.programId);
    const data = await fetchUpdate(feed);
    const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
    await builder.addPostPriceUpdates([data]);
    await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
      const priceUpdate = getPriceUpdateAccount('0x' + feed);
      const ix = await program.methods
        .crank(new anchor.BN(0)) // funding_rate_e9 (model 0 for prototype; set from OI skew in prod)
        .accounts({ exchange, market, priceUpdate })
        .instruction();
      return [{ instruction: ix, signers: [] }];
    });
    const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50000 });
    await receiver.provider.sendAll(txs);
    console.log(new Date().toISOString(), 'cranked', symbol);
  }

  async function sweepLiquidations() {
    const positions = await program.account.position.all();
    for (const p of positions) {
      if (!p.account.isOpen) continue;
      try {
        await program.methods.liquidate()
          .accounts({
            keeper: wallet.publicKey,
            exchange,
            market: p.account.market,
            collateral: PublicKey.findProgramAddressSync([Buffer.from('collateral'), p.account.owner.toBuffer()], program.programId)[0],
            position: p.publicKey,
          })
          .rpc();
        console.log('liquidated', p.publicKey.toBase58());
      } catch (e) { /* NotLiquidatable / healthy — skip */ }
    }
  }

  console.log('keeper up · exchange', exchange.toBase58());
  for (;;) {
    for (const [sym, feed] of Object.entries(FEEDS)) {
      try { await crankMarket(sym, feed); } catch (e) { console.error('crank', sym, e.message); }
    }
    try { await sweepLiquidations(); } catch (e) { console.error('liq sweep', e.message); }
    await new Promise((r) => setTimeout(r, CRANK_MS));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
