#!/usr/bin/env tsx
/**
 * Non-interactive devnet e2e — proves full processor + ELO flow.
 *
 * Runs two players concurrently against the live deployed API + processor:
 *   1. Both auth and join the queue
 *   2. Both accept the match
 *   3. Processor connects, sends initial_game_state
 *   4. Player 1 sends "rock", Player 2 sends "scissors"
 *   5. Processor evaluates → Player 1 wins, sends game_over with ELO deltas
 *   6. Script reads on-chain ELO to confirm it changed
 *
 * Usage (from rps-game root):
 *   npx tsx scripts/e2e-devnet.ts
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { AuthClient } from "@1upmonster/sdk";
import { VersusClient } from "@1upmonster/versus";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GAME_ID   = "a84dd122-b5a2-41c1-9971-4faac2feeb64";
const API_KEY   = "1up_a9c53b538b20e308eeb7e23b15188b9518c8d8faf66dc80a87c6b627dbdceb83";
const API_URL   = "https://api.1up.monster";
const RPC_URL   = "https://devnet.helius-rpc.com/?api-key=4a2c2cc6-845d-4608-93b6-0c8b19e415ff";
const RPS_PROG  = "819bCV5ag9eQ8pV1WRfYRXYokPnNhJYmZT8WcqBYHvTz";

const KP1_PATH = join(homedir(), ".config", "solana", "id.json");
const KP2_PATH = join(homedir(), ".config", "solana", "id2.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[])
  );
}

function walletSigner(kp: Keypair) {
  return {
    publicKey: kp.publicKey.toBase58(),
    async signMessage(msg: Uint8Array): Promise<Uint8Array> {
      return nacl.sign.detached(msg, kp.secretKey);
    },
  };
}

async function getEloOnChain(conn: Connection, wallet: PublicKey): Promise<number | null> {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("player"), wallet.toBuffer()],
    new PublicKey(RPS_PROG)
  );
  const info = await conn.getAccountInfo(pda, "confirmed");
  if (!info || info.data.length < 4) return null;
  return info.data.readUInt32LE(0);
}

// ---------------------------------------------------------------------------
// Single player flow — run concurrently for both players
// ---------------------------------------------------------------------------

async function runPlayer(
  label: string,
  kp: Keypair,
  move: string,
): Promise<{ winner: string; eloChanges: Array<{ wallet: string; delta: number; newElo: number }> }> {

  const auth = new AuthClient(API_URL);
  const session = await auth.login(walletSigner(kp));
  console.log(`[${label}] Authenticated: ${kp.publicKey.toBase58().slice(0, 8)}…`);

  const versus = new VersusClient({ baseUrl: API_URL, token: session.token, gameApiKey: API_KEY });

  let queued = false;
  const proposal = await versus.matchmake(GAME_ID, () => {
    queued = true;
    console.log(`[${label}] Queued, waiting for match…`);
  });
  if (!queued) console.log(`[${label}] Queued, waiting for match…`);
  console.log(`[${label}] Match found! matchId=${proposal.matchId.slice(0, 8)}… opponent=${proposal.opponents[0]?.walletPubkey.slice(0,8)}… (ELO ${proposal.opponents[0]?.elo})`);

  const room = await proposal.accept();
  console.log(`[${label}] Room joined.`);

  // Call ready() for P2P compat (processor game ignores it but doesn't hurt)
  room.ready();

  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = room as any;

    // Listen for initial_game_state — processor fires this to unlock inputs
    r.on("initial_game_state", () => {
      console.log(`[${label}] initial_game_state received → sending ${move.toUpperCase()}`);
      room.broadcast({ move });
    });

    // Fallback: send move 3s after accept in case we missed initial_game_state
    let moveSent = false;
    const fallback = setTimeout(() => {
      if (!moveSent) {
        moveSent = true;
        console.log(`[${label}] fallback: sending ${move.toUpperCase()}`);
        room.broadcast({ move });
      }
    }, 3000);

    r.on("game_state_update", (payload: unknown) => {
      moveSent = true;
      clearTimeout(fallback);
      const u = payload as { moves?: Record<string, string>; result?: string };
      const myMove = u.moves?.[kp.publicKey.toBase58()];
      const oppMove = Object.entries(u.moves ?? {}).find(([k]) => k !== kp.publicKey.toBase58())?.[1];
      console.log(`[${label}] game_state_update: you=${myMove?.toUpperCase()} opp=${oppMove?.toUpperCase()} result=${u.result}`);
    });

    r.on("game_over", (payload: unknown) => {
      clearTimeout(fallback);
      room.leave();
      resolve(payload as { winner: string; eloChanges: Array<{ wallet: string; delta: number; newElo: number }> });
    });

    r.on("match_expired", () => { clearTimeout(fallback); reject(new Error(`[${label}] match expired`)); });
    r.on("opponent_disconnected", () => { clearTimeout(fallback); reject(new Error(`[${label}] opponent disconnected`)); });
    r.on("error", (e: { message: string }) => { clearTimeout(fallback); reject(new Error(`[${label}] room error: ${e.message}`)); });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const kp1 = loadKeypair(KP1_PATH);
  const kp2 = loadKeypair(KP2_PATH);
  const conn = new Connection(RPC_URL, "confirmed");

  console.log("\n=== RPS devnet e2e ===");
  console.log(`Player 1: ${kp1.publicKey.toBase58()}`);
  console.log(`Player 2: ${kp2.publicKey.toBase58()}`);
  console.log(`Game ID:  ${GAME_ID}\n`);

  // Read ELO before
  const [elo1Before, elo2Before] = await Promise.all([
    getEloOnChain(conn, kp1.publicKey),
    getEloOnChain(conn, kp2.publicKey),
  ]);
  console.log(`ELO before — P1: ${elo1Before ?? "none"}, P2: ${elo2Before ?? "none"}\n`);

  // Run both players concurrently — P1 plays "rock", P2 plays "scissors"
  const [result1] = await Promise.all([
    runPlayer("P1", kp1, "rock"),
    runPlayer("P2", kp2, "scissors"),
  ]);

  // Both game_over payloads are identical — use result1
  const { winner, eloChanges } = result1;
  const w = winner === kp1.publicKey.toBase58() ? "P1" : winner === kp2.publicKey.toBase58() ? "P2" : "DRAW";
  console.log(`\n=== RESULT: ${w} wins ===`);

  for (const c of (eloChanges ?? [])) {
    const who = c.wallet === kp1.publicKey.toBase58() ? "P1" : "P2";
    console.log(`  ${who}: ${c.delta >= 0 ? "+" : ""}${c.delta} ELO → ${c.newElo}`);
  }

  if (!eloChanges?.length) {
    console.log("  (eloChanges empty — ELO settlement may still be in flight)");
  }

  // Verify on-chain ELO updated
  console.log("\nWaiting 5s for on-chain confirmation…");
  await new Promise((r) => setTimeout(r, 5000));

  const [elo1After, elo2After] = await Promise.all([
    getEloOnChain(conn, kp1.publicKey),
    getEloOnChain(conn, kp2.publicKey),
  ]);

  console.log(`\nOn-chain ELO AFTER:`);
  console.log(`  P1: ${elo1Before ?? "?"} → ${elo1After ?? "?"} (${elo1After != null && elo1Before != null ? (elo1After - elo1Before >= 0 ? "+" : "") + (elo1After - elo1Before) : "?"})`);
  console.log(`  P2: ${elo2Before ?? "?"} → ${elo2After ?? "?"} (${elo2After != null && elo2Before != null ? (elo2After - elo2Before >= 0 ? "+" : "") + (elo2After - elo2Before) : "?"})`);

  const p1Changed = elo1After !== elo1Before;
  const p2Changed = elo2After !== elo2Before;

  if (p1Changed && p2Changed) {
    console.log("\n✓ ELO updated on-chain. Full stack verified.");
  } else {
    console.log("\n⚠  On-chain ELO unchanged — may need more time or settlement failed.");
    console.log("   Run `wrangler tail rps-processor` to see processor logs.");
  }
}

main().catch((err) => {
  console.error("\nFatal:", err);
  process.exit(1);
});
