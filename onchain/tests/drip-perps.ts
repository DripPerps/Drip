// Minimal Anchor test: init exchange + a market, deposit, open, crank, close.
// Run with `anchor test` (spins up a local validator + Pyth mock or uses devnet).
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";

const sym8 = (s: string) => { const b = Buffer.alloc(8); Buffer.from(s).copy(b); return [...b]; };

describe("drip-perps", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DripPerps as Program<any>;
  const auth = provider.wallet as anchor.Wallet;

  let usdcMint: PublicKey;
  const [exchange] = PublicKey.findProgramAddressSync([Buffer.from("exchange")], program.programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault")], program.programId);

  it("inits exchange + market", async () => {
    usdcMint = await createMint(provider.connection, (auth as any).payer, auth.publicKey, null, 6);
    await program.methods.initExchange(50, 6, 50, 800)
      .accounts({ authority: auth.publicKey, exchange, usdcMint, vault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
      .rpc();
    const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), Buffer.from(sym8("SOL").slice(0, 8))], program.programId);
    await program.methods.initMarket(sym8("SOL"), "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", 50)
      .accounts({ authority: auth.publicKey, exchange, market, systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();
    const ex = await program.account.exchange.fetch(exchange);
    assert.equal(ex.marketCount, 1);
    assert.equal(ex.maintBps, 50);
  });

  it("deposits collateral", async () => {
    const ata = await getOrCreateAssociatedTokenAccount(provider.connection, (auth as any).payer, usdcMint, auth.publicKey);
    await mintTo(provider.connection, (auth as any).payer, usdcMint, ata.address, auth.publicKey, 10_000_000_000);
    const [collateral] = PublicKey.findProgramAddressSync([Buffer.from("collateral"), auth.publicKey.toBuffer()], program.programId);
    await program.methods.deposit(new anchor.BN(5_000_000_000))
      .accounts({ owner: auth.publicKey, exchange, collateral, vault, userUsdc: ata.address, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();
    const c = await program.account.collateral.fetch(collateral);
    assert.equal(c.free.toString(), "5000000000");
  });

  // open/crank/close require a posted Pyth PriceUpdateV2 account — see keeper.js
  // for the post-then-consume pattern; on localnet use @pythnetwork/pyth-solana-receiver
  // dev utilities or a mock price account.
});
