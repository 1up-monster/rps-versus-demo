#!/usr/bin/env node
/**
 * RPS terminal client
 *
 * Usage:
 *   node dist/index.js --keypair ~/.config/solana/id.json --api-key 1up_xxx
 *
 * Flags:
 *   --keypair <path>     Path to Solana keypair JSON file (default: ~/.config/solana/id.json)
 *   --api-key <key>      1upmonster game API key (1up_...)
 *   --game-id <id>       1upmonster game ID (default from RPS_GAME_ID env)
 *   --api-url <url>      1upmonster API URL (default: https://api.1up.monster)
 *   --rpc-url <url>      Solana RPC URL (default: https://api.mainnet-beta.solana.com)
 *   --rps-program <id>   rps-player program ID
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { Keypair, PublicKey, Connection, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { AuthClient } from "@1upmonster/sdk";
import { VersusClient } from "@1upmonster/versus";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function getArg(flag: string, fallback?: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  if (fallback !== undefined) return fallback;
  console.error(`Missing required argument: ${flag}`);
  process.exit(1);
}

const keypairPath = getArg("--keypair", join(homedir(), ".config", "solana", "id.json"));
const gameApiKey = getArg("--api-key", "");
const gameId = getArg("--game-id", process.env["RPS_GAME_ID"] ?? "");
const apiUrl = getArg("--api-url", process.env["PLATFORM_API_URL"] ?? "https://api.1up.monster");
const rpcUrl = getArg("--rpc-url", process.env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com");
const rpsProgramId = getArg("--rps-program", process.env["RPS_PROGRAM_ID"] ?? "");

if (!gameId) {
  console.error("Missing --game-id or RPS_GAME_ID env");
  process.exit(1);
}
if (!rpsProgramId) {
  console.error("Missing --rps-program or RPS_PROGRAM_ID env");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Keypair + wallet
// ---------------------------------------------------------------------------

const keypairJson = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
const wallet = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
const conn = new Connection(rpcUrl, "confirmed");

// ---------------------------------------------------------------------------
// Player PDA helpers
// ---------------------------------------------------------------------------

function getPlayerPda(walletPubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("player"), walletPubkey.toBuffer()],
    new PublicKey(rpsProgramId)
  );
  return pda;
}

async function getPlayerElo(walletPubkey: PublicKey): Promise<number | null> {
  const pda = getPlayerPda(walletPubkey);
  const info = await conn.getAccountInfo(pda);
  if (!info || info.data.length < 4) return null;
  return info.data.readUInt32LE(0);
}

async function initializePlayer(elo: number): Promise<void> {
  const programId = new PublicKey(rpsProgramId);
  const playerPda = getPlayerPda(wallet.publicKey);

  // Instruction data: [0x01][initial_elo u32 LE]
  const data = Buffer.alloc(5);
  data[0] = 0x01;
  data.writeUInt32LE(elo, 1);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await conn.sendTransaction(tx, [wallet], { skipPreflight: true });
  await conn.confirmTransaction(sig, "confirmed");
  console.log(`  Player account initialized (sig: ${sig})`);
}

// ---------------------------------------------------------------------------
// readline prompt helper
// ---------------------------------------------------------------------------

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// WalletSigner adapter for AuthClient
// ---------------------------------------------------------------------------

const walletSigner = {
  publicKey: wallet.publicKey.toBase58(),
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(message, wallet.secretKey);
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n[1upmonster RPS]");
  console.log(`Wallet:  ${wallet.publicKey.toBase58()}`);

  // Check / initialize player PDA
  let elo = await getPlayerElo(wallet.publicKey);
  const playerPda = getPlayerPda(wallet.publicKey);

  if (elo === null) {
    console.log("  Player account not found. Initializing with ELO 1000...");
    await initializePlayer(1000);
    elo = 1000;
  }

  console.log(`Player:  ${playerPda.toBase58()}  (ELO: ${elo})`);

  // Authenticate with 1upmonster
  const authClient = new AuthClient(apiUrl);
  console.log("\nAuthenticating...");
  const session = await authClient.login(walletSigner);
  console.log(`  Authenticated as ${session.walletPubkey}`);

  // Join matchmaking queue
  const versusClient = new VersusClient({
    baseUrl: apiUrl,
    token: session.token,
    gameApiKey: gameApiKey || undefined,
  });

  console.log("\nJoining queue...");
  const proposal = await versusClient.matchmake(gameId, () => {
    console.log(`  Queued (ELO: ${elo})`);
  });

  const opponents = proposal.opponents.map((o) => `${o.walletPubkey} (ELO: ${o.elo})`);
  console.log(`\nMatch found! Opponent: ${opponents.join(", ")}`);
  console.log(`Accept deadline: ${new Date(proposal.acceptDeadline).toLocaleTimeString()}`);

  const answer = await prompt("Accept? [y/n] > ");
  if (answer.toLowerCase() !== "y") {
    proposal.decline();
    console.log("Match declined.");
    process.exit(0);
  }

  console.log("\nAccepting match...");
  const room = await proposal.accept();
  console.log("=== MATCH ===");

  // Wait for room_ready then send move
  room.ready();

  let moveSent = false;

  const sendMove = async (): Promise<void> => {
    if (moveSent) return;
    let move = "";
    while (!["rock", "paper", "scissors"].includes(move)) {
      const raw = await prompt("Choose your move: [r]ock / [p]aper / [s]cissors > ");
      if (raw === "r" || raw === "rock") move = "rock";
      else if (raw === "p" || raw === "paper") move = "paper";
      else if (raw === "s" || raw === "scissors") move = "scissors";
      else console.log("  Invalid choice, try again.");
    }
    moveSent = true;
    room.broadcast({ move });
    console.log(`  Sent: ${move.toUpperCase()}`);
    console.log("\nWaiting for opponent...");
  };

  room.on("room_ready", () => {
    sendMove().catch(console.error);
  });

  // If room_ready doesn't fire (processor game), send move after a short delay
  setTimeout(() => {
    sendMove().catch(console.error);
  }, 2000);

  // Listen for game result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const roomAny = room as any;
  await new Promise<void>((resolve) => {
    roomAny.on("game_state_update", (payload: unknown) => {
      const update = payload as {
        moves: Record<string, string>;
        result: string;
      };
      const myMove = update.moves?.[wallet.publicKey.toBase58()];
      const opponentMove = Object.entries(update.moves ?? {}).find(
        ([k]) => k !== wallet.publicKey.toBase58()
      )?.[1];

      if (myMove && opponentMove) {
        console.log(`\nYou:      ${myMove.toUpperCase()}`);
        console.log(`Opponent: ${opponentMove.toUpperCase()}`);
      }
    });

    roomAny.on("game_over", (payload: unknown) => {
      const result = payload as {
        winner: string;
        eloChanges?: Array<{ wallet: string; delta: number; newElo: number }>;
      };

      const myChange = result.eloChanges?.find(
        (c) => c.wallet === wallet.publicKey.toBase58()
      );

      if (result.winner === "draw") {
        console.log(`\nResult: DRAW  (ELO unchanged)`);
      } else if (result.winner === wallet.publicKey.toBase58()) {
        const delta = myChange ? `+${myChange.delta} ELO → ${myChange.newElo}` : "";
        console.log(`\nResult: YOU WIN  (${delta})`);
      } else {
        const delta = myChange ? `${myChange.delta} ELO → ${myChange.newElo}` : "";
        console.log(`\nResult: YOU LOSE  (${delta})`);
      }

      room.leave();
      resolve();
    });

    roomAny.on("close", resolve);
    roomAny.on("match_expired", resolve);
    roomAny.on("opponent_disconnected", () => {
      console.log("\nOpponent disconnected.");
      resolve();
    });
    roomAny.on("error", (payload: unknown) => {
      const err = payload as { message: string };
      console.error(`\nRoom error: ${err.message}`);
      resolve();
    });
  });

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
