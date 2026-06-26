/**
 * One-time setup after deploy: create the exchange + the 8 markets.
 *   ANCHOR_WALLET=~/.config/solana/id.json RPC=https://api.devnet.solana.com \
 *   USDC_MINT=<devnet-usdc-mint> node migrations/init.js
 */
const anchor = require('@coral-xyz/anchor');
const { PublicKey, Keypair } = require('@solana/web3.js');
const fs = require('fs');

const MARKETS = [
  ['SOL', 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', 50],
  ['BONK', '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419', 20],
  ['WIF', '4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc', 20],
  ['POPCAT', 'b9312a7ee50e189ef045aa3c7842e099b061bd9bdc99ac645956c3b660dc8cce', 20],
  ['PNUT', '116da895807f81f6b5c5f01b109376e7f6834dc8b51365ab7cdfa66634340e54', 20],
  ['GOAT', 'f7731dc812590214d3eb4343bfb13d1b4cfa9b1d4e020644b5d5d8e07d60c66c', 20],
  ['MOODENG', 'ffff73128917a90950cd0473fd2551d7cd274fd5a6cc45641881bbcc6ee73417', 20],
  ['FARTCOIN', '58cd29ef0e714c5affc44f269b2c1899a52da4169d7acc147b9da692e6953608', 20],
];
const sym8 = (s) => { const b = Buffer.alloc(8); Buffer.from(s).copy(b); return [...b]; };

async function main() {
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET, 'utf8'))));
  const provider = new anchor.AnchorProvider(new anchor.web3.Connection(process.env.RPC || 'https://api.devnet.solana.com', 'confirmed'), new anchor.Wallet(kp), { commitment: 'confirmed' });
  anchor.setProvider(provider);
  const program = anchor.workspace.DripPerps;
  const usdcMint = new PublicKey(process.env.USDC_MINT);

  const [exchange] = PublicKey.findProgramAddressSync([Buffer.from('exchange')], program.programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault')], program.programId);

  // maint_bps=50, fee_bps=6, liq_fee_bps=50, max_move_bps=800
  await program.methods.initExchange(50, 6, 50, 800)
    .accounts({ authority: provider.wallet.publicKey, exchange, usdcMint, vault, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
    .rpc();
  console.log('exchange', exchange.toBase58());

  for (const [sym, feed, lev] of MARKETS) {
    const [market] = PublicKey.findProgramAddressSync([Buffer.from('market'), Buffer.from(sym8(sym).slice(0, 8))], program.programId);
    await program.methods.initMarket(sym8(sym), feed, lev)
      .accounts({ authority: provider.wallet.publicKey, exchange, market, systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();
    console.log('market', sym, market.toBase58());
  }
  console.log('done — now run the keeper to start cranking prices.');
}
main().catch((e) => { console.error(e); process.exit(1); });
