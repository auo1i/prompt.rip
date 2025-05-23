import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import Wallet from "@coral-xyz/anchor/dist/cjs/nodewallet"
const assert = require("assert");
import { Tournament, TournamentState } from "../target/types/tournament";

const TOURNAMENT_EXP = 0;
const TOURNAMENT_CONST = 1;

describe("tournament", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Tournament as Program<Tournament>;
  const init_seed = anchor.utils.bytes.utf8.encode("tournament");
  const entry_sum = 100000000000;
  const fee_mul_x10 = 5;
  const winner_pct = 70;
  const royalty_pct = 15;
  const abs_fee_mul = fee_mul_x10 / 1000 + 1;
  let init_balance = 0;
  
  const tournament_id = Math.floor(Date.now() / 1000);
  let tournamentPubKey;
  const user1 = anchor.web3.Keypair.generate();
  const user2 = anchor.web3.Keypair.generate();
  const wallet1 = new Wallet(user1)
  const tournament_id_user1 = tournament_id + 1000;
  let tournamentPubKey_user1;

  const wallet2 = new Wallet(user2)

  // request airdrop
  before(async () => {
      await provider.connection.requestAirdrop(user1.publicKey, 1000000000000);
      await provider.connection.requestAirdrop(user2.publicKey, 1000000000000);
  });

  beforeEach(async () => {
    [tournamentPubKey] = await anchor.web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("tournament"),
            provider.wallet.publicKey.toBuffer(),
            new anchor.BN(tournament_id).toArrayLike(Buffer, "le", 8)
        ],
        program.programId
    );
    [tournamentPubKey_user1] = await anchor.web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("tournament"),
            user1.publicKey.toBuffer(),
            new anchor.BN(tournament_id_user1).toArrayLike(Buffer, "le", 8)
        ],
        program.programId
    );
  });

  it("initializes a program admin", async () => {
    await program.methods
      .initializeAdmin()
      .accounts({
        tournament: tournamentPubKey,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  });

  it("initializes a tournament", async () => {
    await program.methods
      .initialize(new anchor.BN(tournament_id))
      .accounts({
        tournament: tournamentPubKey,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    const tournamentAccount = await program.account.tournament.fetch(tournamentPubKey);
    assert.equal(tournamentAccount.authority, provider.wallet.publicKey.toString());
    init_balance = await provider.connection.getBalance(tournamentPubKey);
  });

  it("Starts a tournament", async () => {
    const expected_entry_fee = entry_sum * fee_mul_x10 / 1000;
    const system_prompt_hash = Array.from(new Uint8Array(32).fill(0));
    await program.methods.startTournament(
      system_prompt_hash,
      new anchor.BN(entry_sum),
      fee_mul_x10,
      winner_pct,
      royalty_pct,
      TOURNAMENT_EXP
    ).accounts({
      tournament: tournamentPubKey,
      payer: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();
    const tournamentAccount = await program.account.tournament.fetch(tournamentPubKey);
    
    // translate BN to number
    let num = Number(tournamentAccount.entryFee);
    assert.equal(num, expected_entry_fee);

    const balance = await provider.connection.getBalance(tournamentPubKey);
    assert.equal(balance - init_balance, entry_sum);
    // TODO: Fix this
    // assert.equal(tournamentAccount.state, TournamentState.Running);
  });

  it("Submits some solutions", async () => {
    let tournamentAccount = await program.account.tournament.fetch(tournamentPubKey);
    const entry_fee = tournamentAccount.entryFee / 1;
    const solution_hash = Array.from(new Uint8Array(32).fill(1));
    await program.methods.submitSolution(solution_hash).accounts({
      tournament: tournamentPubKey,
      payer: wallet1.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).signers([user1]).rpc();
    tournamentAccount = await program.account.tournament.fetch(tournamentPubKey);

    let num = Number(tournamentAccount.entryFee);
    let tmp = Math.ceil(entry_fee * abs_fee_mul);
    // round up tmp due to BN precision
    assert.equal(num, tmp);

    // TODO: Turn this into a BN testcase
    //let bn = new anchor.BN(entry_fee);
    //bn = bn.mul(new anchor.BN(abs_fee_mul));
    //assert.equal(tournamentAccount.entryFee, bn);

    const balance = await provider.connection.getBalance(tournamentPubKey);
    assert.equal(balance - init_balance, entry_sum + entry_fee);
  });

  it("Concludes a tournament", async () => {
    let winner_balance_initial = await provider.connection.getBalance(wallet1.publicKey);
    await program.methods.concludeTournament().accounts({
      tournament: tournamentPubKey,
      payer: provider.wallet.publicKey,
      winnerAccount: user1.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();
    // assert that the contract doesnt hold any SOL
    let balance = await provider.connection.getBalance(tournamentPubKey);
    assert.equal(balance, init_balance);
    // TODO: Fix this
    // assert.equal(tournamentAccount.state, TournamentState.Concluded);
    let winner_balance_final = await provider.connection.getBalance(wallet1.publicKey);
    let tmp = Math.ceil(entry_sum * abs_fee_mul * winner_pct / 100);
    assert.equal(winner_balance_final - winner_balance_initial, tmp);
  });

  it("Initializes a second tournament", async () => {
    await program.methods.initialize(new anchor.BN(tournament_id_user1)).accounts({
      tournament: tournamentPubKey_user1,
      authority: user1.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([user1])
    .rpc();
  });
  
  it("Starts a second tournament with a different account", async () => {
    let system_prompt_hash = Array.from(new Uint8Array(32).fill(2));
    await program.methods.startTournament(
      system_prompt_hash,
      new anchor.BN(entry_sum),
      fee_mul_x10,
      winner_pct,
      royalty_pct,
      TOURNAMENT_EXP
    ).accounts({
      tournament: tournamentPubKey_user1,
      payer: user1.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([user1])
    .rpc();
    const tournamentAccount = await program.account.tournament.fetch(tournamentPubKey_user1);
    assert.equal(tournamentAccount.entryFee, entry_sum*fee_mul_x10/1000);
    const balance = await provider.connection.getBalance(tournamentPubKey_user1);
    assert.equal(balance - init_balance, entry_sum);
  });

  it("Submits to the second tournament", async () => {
    let tournamentAccount = await program.account.tournament.fetch(tournamentPubKey_user1);
    let entry_fee = tournamentAccount.entryFee / 1;
    let solution_hash = Array.from(new Uint8Array(32).fill(3));
    await program.methods.submitSolution(solution_hash).accounts({
      tournament: tournamentPubKey_user1,
      payer: wallet2.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([user2])
    .rpc();
    tournamentAccount = await program.account.tournament.fetch(tournamentPubKey_user1);

    let num = Number(tournamentAccount.entryFee);
    let tmp = Math.ceil(entry_fee * abs_fee_mul);
    // round up tmp due to BN precision
    assert.equal(num, tmp);

    let balance = await provider.connection.getBalance(tournamentPubKey_user1);
    assert.equal(balance - init_balance, entry_sum + entry_fee);

    tournamentAccount = await program.account.tournament.fetch(tournamentPubKey_user1);
    let entry_fee2 = tournamentAccount.entryFee / 1;
    solution_hash = Array.from(new Uint8Array(32).fill(4));
    await program.methods.submitSolution(solution_hash).accounts({
      tournament: tournamentPubKey_user1,
      payer: wallet2.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([user2])
    .rpc();
    tournamentAccount = await program.account.tournament.fetch(tournamentPubKey_user1);

    num = Number(tournamentAccount.entryFee);
    tmp = Math.ceil(entry_fee2 * abs_fee_mul);
    // round up tmp due to BN precision
    assert.equal(num, tmp);
    balance = await provider.connection.getBalance(tournamentPubKey_user1);
    assert.equal(balance - init_balance, entry_sum + entry_fee2 + entry_fee);
  });
  
  it("Concludes a second tournament", async () => {
    await program.methods.concludeTournament().accounts({
      tournament: tournamentPubKey_user1,
      winnerAccount: wallet2.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();
    let balance = await provider.connection.getBalance(tournamentPubKey_user1);
    assert.equal(balance, init_balance);
  });

  it("Starts a CONST tournament", async () => {
    const system_prompt_hash = Array.from(new Uint8Array(32).fill(5));
    await program.methods.startTournament(system_prompt_hash, new anchor.BN(entry_sum), fee_mul_x10, winner_pct, royalty_pct, TOURNAMENT_CONST).accounts({
      tournament: tournamentPubKey,
      payer: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();
    const tournamentAccount = await program.account.tournament.fetch(tournamentPubKey);
    assert.equal(tournamentAccount.entryFee, entry_sum*fee_mul_x10/1000);
    const balance = await provider.connection.getBalance(tournamentPubKey);
    assert.equal(balance - init_balance, entry_sum);
  });

  it("Submits to the CONST tournament", async () => {
    let tournamentAccount = await program.account.tournament.fetch(tournamentPubKey);
    const entry_fee = entry_sum * fee_mul_x10 / 1000;
    const solution_hash = Array.from(new Uint8Array(32).fill(6));
    await program.methods.submitSolution(solution_hash).accounts({
      tournament: tournamentPubKey,
      payer: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();
    tournamentAccount = await program.account.tournament.fetch(tournamentPubKey);

    // In CONST tournament, entry fee should remain the same
    assert.equal(tournamentAccount.entryFee, entry_fee);

    const balance = await provider.connection.getBalance(tournamentPubKey);
    assert.equal(balance - init_balance, entry_sum + entry_fee);

    await program.methods.submitSolution(solution_hash).accounts({
      tournament: tournamentPubKey,
      payer: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();

    const balance2 = await provider.connection.getBalance(tournamentPubKey);
    assert.equal(balance2 - init_balance, entry_sum + entry_fee*2);
  });

  it("Concludes the CONST tournament", async () => {
    await program.methods.concludeTournament().accounts({
      tournament: tournamentPubKey,
      payer: provider.wallet.publicKey,
      winnerAccount: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();
    const balance = await provider.connection.getBalance(tournamentPubKey);
    assert.equal(balance, init_balance);
  });
});
