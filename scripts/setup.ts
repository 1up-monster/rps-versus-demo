#!/usr/bin/env tsx
/**
 * RPS game setup — initialize config PDA on devnet.
 *
 * Run once after deploying the rps-player program:
 *
 *   npx tsx scripts/setup.ts \
 *     --keypair ~/.config/solana/id.json \
 *     --processor-wallet <PROCESSOR_PUBKEY> \
 *     --rps-program <PROGRAM_ID> \
 *     --rpc-url https://devnet.helius-rpc.com/?api-key=<KEY>
 *
 * The deployer keypair funds the config PDA rent.
 * The processor keypair is NOT needed here — only its public key.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Keypair,
  PublicKey,
  Connection,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";

function getArg(flag: string, fallback?: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  if (fallback !== undefined) return fallback;
  console.error(`Missing required argument: ${flag}`);
  process.exit(1);
}

const keypairPath = getArg("--keypair", join(homedir(), ".config", "solana", "id.json"));
const processorWalletStr = getArg("--processor-wallet", "");
const rpsProgramStr = getArg("--rps-program", process.env["RPS_PROGRAM_ID"] ?? "");
const rpcUrl = getArg(
  "--rpc-url",
  process.env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com"
);

if (!processorWalletStr) {
  console.error("Missing --processor-wallet <pubkey>");
  process.exit(1);
}
if (!rpsProgramStr) {
  console.error("Missing --rps-program <program_id>");
  process.exit(1);
}

async function main(): Promise<void> {
  const keypairJson = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
  const deployer = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
  const processorWallet = new PublicKey(processorWalletStr);
  const programId = new PublicKey(rpsProgramStr);
  const conn = new Connection(rpcUrl, "confirmed");

  console.log(`Deployer:         ${deployer.publicKey.toBase58()}`);
  console.log(`Processor wallet: ${processorWallet.toBase58()}`);
  console.log(`RPS program:      ${programId.toBase58()}`);
  console.log(`RPC URL:          ${rpcUrl}`);

  // Derive config PDA
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId
  );
  console.log(`\nConfig PDA:       ${configPda.toBase58()}`);

  // Check if already initialized
  const existing = await conn.getAccountInfo(configPda);
  if (existing && existing.data.length >= 32) {
    const storedAuthority = new PublicKey(existing.data.slice(0, 32));
    console.log(`\nConfig PDA already initialized.`);
    console.log(`  game_processor_authority: ${storedAuthority.toBase58()}`);

    if (storedAuthority.equals(processorWallet)) {
      console.log("  Matches --processor-wallet. Nothing to do.");
    } else {
      console.log("  WARNING: Does NOT match --processor-wallet!");
    }
    return;
  }

  // Build initialize_config instruction
  // Data: [0x00][processor_wallet_pubkey (32 bytes)]
  const data = Buffer.alloc(33);
  data[0] = 0x00;
  processorWallet.toBuffer().copy(data, 1);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  console.log("\nSending initialize_config transaction...");
  const tx = new Transaction().add(ix);
  const sig = await conn.sendTransaction(tx, [deployer], { skipPreflight: true });
  console.log(`  Signature: ${sig}`);
  console.log("  Confirming...");
  await conn.confirmTransaction(sig, "confirmed");
  console.log("  Confirmed!");

  // Verify
  const account = await conn.getAccountInfo(configPda);
  if (!account || account.data.length < 32) {
    console.error("  ERROR: Config PDA not created correctly");
    process.exit(1);
  }
  const storedAuthority = new PublicKey(account.data.slice(0, 32));
  console.log(`\n  Config PDA:              ${configPda.toBase58()}`);
  console.log(`  game_processor_authority: ${storedAuthority.toBase58()}`);
  console.log("\n✓ Setup complete!");
  console.log("\nNext steps:");
  console.log("  1. wrangler secret put PROCESSOR_KEYPAIR");
  console.log("  2. wrangler secret put SOLANA_RPC_URL");
  console.log("  3. wrangler secret put GAME_ID");
  console.log("  4. Update RPS_PROGRAM_ID in processor/wrangler.toml");
  console.log("  5. wrangler deploy");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
