/**
 * RPS Game Processor — Cloudflare Worker
 *
 * Receives match callbacks from 1upmonster, connects to the room as the game
 * processor, collects rock/paper/scissors moves from both players, evaluates
 * the winner, and updates ELO on-chain via the rps-player Solana program.
 *
 * Env (wrangler.toml vars + secrets):
 *   PROCESSOR_KEYPAIR  — base58-encoded 64-byte ed25519 keypair (secret)
 *   SOLANA_RPC_URL     — Helius devnet RPC URL (secret)
 *   RPS_PROGRAM_ID     — deployed rps-player program ID (var)
 *   PLATFORM_API_URL   — 1upmonster API base URL (var)
 *   GAME_ID            — 1upmonster game ID (secret)
 */

interface Env {
  PROCESSOR_KEYPAIR: string;
  SOLANA_RPC_URL: string;
  RPS_PROGRAM_ID: string;
  PLATFORM_API_URL: string;
  GAME_ID: string;
}

interface CallbackPayload {
  matchId: string;
  roomUrl: string;
  roomToken: string;
  participants: Array<{ walletPubkey: string; role: string; teamIndex?: number }>;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Base58 helpers
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base58 char: ${c}`);
    n = n * 58n + BigInt(idx);
  }
  let leadingZeros = 0;
  for (const c of s) {
    if (c !== "1") break;
    leadingZeros++;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array([...new Uint8Array(leadingZeros), ...bytes]);
}

function b58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let result = "";
  while (n > 0n) {
    result = BASE58_ALPHABET[Number(n % 58n)]! + result;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    result = "1" + result;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Solana compact-u16
// ---------------------------------------------------------------------------

function cu16(n: number): number[] {
  if (n < 0x80) return [n];
  return [(n & 0x7f) | 0x80, (n >> 7) & 0x7f];
}

// ---------------------------------------------------------------------------
// Ed25519 off-curve check (for PDA derivation)
// ---------------------------------------------------------------------------

// Field prime for ed25519: 2^255 - 19
const P = 2n ** 255n - 19n;
// Constant d for ed25519 twisted Edwards curve: -121665/121666 mod P
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/** Returns true if bytes represent a point on the ed25519 curve. */
function isOnEd25519Curve(bytes: Uint8Array): boolean {
  // Parse little-endian y coordinate, clear sign bit
  let y = 0n;
  for (let i = 0; i < 32; i++) y |= BigInt(bytes[i]!) << BigInt(8 * i);
  y &= (1n << 255n) - 1n;

  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 % P + 1n) % P;

  if (v === 0n) return u === 0n;

  const x2 = (u * modPow(v, P - 2n, P)) % P;
  if (x2 === 0n) return true;

  // Check if x2 is a quadratic residue mod P
  return modPow(x2, (P - 1n) / 2n, P) === 1n;
}

async function createProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array
): Promise<Uint8Array> {
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  const parts = [...seeds.flatMap((s) => [...s]), ...programId, ...marker];
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(parts)));
  if (isOnEd25519Curve(hash)) throw new Error("Seeds result in on-curve point");
  return hash;
}

async function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array
): Promise<[Uint8Array, number]> {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      const pda = await createProgramAddress([...seeds, new Uint8Array([bump])], programId);
      return [pda, bump];
    } catch {
      // On-curve — try next bump
    }
  }
  throw new Error("Could not find valid program address");
}

// ---------------------------------------------------------------------------
// Solana JSON-RPC helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpcCall<T = any>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = (await res.json()) as { result?: T; error?: { message: string } };
  if (data.error) throw new Error(`RPC ${method} failed: ${data.error.message}`);
  return data.result as T;
}

async function getLatestBlockhash(rpcUrl: string): Promise<string> {
  const result = await rpcCall<{ value: { blockhash: string } }>(
    rpcUrl,
    "getLatestBlockhash",
    [{ commitment: "confirmed" }]
  );
  return result.value.blockhash;
}

async function sendTransaction(rpcUrl: string, txBase64: string): Promise<string> {
  return rpcCall<string>(rpcUrl, "sendTransaction", [
    txBase64,
    { encoding: "base64", skipPreflight: true, preflightCommitment: "confirmed" },
  ]);
}

async function waitForConfirmation(rpcUrl: string, sig: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const result = await rpcCall<{
      value: Array<{ confirmationStatus: string; err: unknown } | null>;
    }>(rpcUrl, "getSignatureStatuses", [[sig]]);
    const status = result.value[0];
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      if (status.err)
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)} (sig: ${sig})`);
      return;
    }
  }
  throw new Error(`Transaction not confirmed within timeout: ${sig}`);
}

// ---------------------------------------------------------------------------
// update_elo transaction builder — batches N player updates in a single tx
//
// Account layout (N = number of updates):
//   [0]       game_processor  — writable signer
//   [1..N]    player_pda_i    — writable non-signer (one per update)
//   [N+1]     config_pda      — readonly non-signer
//   [N+2]     rps_program     — readonly non-signer
//
// Header: [1, 0, 2]  (1 signer, 0 readonly signers, 2 readonly unsigned)
//
// Each instruction accounts: processor=0, config_pda=N+1, player_pda_i=1+i
// ---------------------------------------------------------------------------

/** Concatenate Uint8Arrays without spread — avoids workerd spread bugs. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function buildUpdateEloTx(
  processorKeypair: { publicKey: CryptoKey; privateKey: CryptoKey },
  processorPubkeyBytes: Uint8Array,
  updates: Array<{ playerPdaBytes: Uint8Array; newElo: number }>,
  configPdaBytes: Uint8Array,
  rpsProgramBytes: Uint8Array,
  recentBlockhash: string
): Promise<string> {
  const bhash = b58Decode(recentBlockhash);
  const N = updates.length;
  const configIndex = 1 + N;
  const programIndex = 1 + N + 1;

  // Build each instruction explicitly
  const ixParts: Uint8Array[] = [new Uint8Array(cu16(N))];
  for (let i = 0; i < N; i++) {
    const idata = new Uint8Array(5);
    idata[0] = 0x02;
    new DataView(idata.buffer).setUint32(1, updates[i]!.newElo, true);
    ixParts.push(new Uint8Array([
      programIndex,          // program account index
      ...cu16(3),            // 3 accounts
      0, configIndex, 1 + i, // processor, config_pda, player_pda_i
      ...cu16(5),            // 5 bytes of instruction data
    ]));
    ixParts.push(idata);
  }

  const msg = concat(
    new Uint8Array([1, 0, 2]),            // header
    new Uint8Array(cu16(3 + N)),          // account count: processor + N PDAs + config + program
    processorPubkeyBytes,                 // [0]
    ...updates.map(u => u.playerPdaBytes),// [1..N]
    configPdaBytes,                       // [N+1]
    rpsProgramBytes,                      // [N+2]
    bhash,                                // recent blockhash
    ...ixParts,                           // instructions
  );

  const sigBytes = new Uint8Array(
    (await crypto.subtle.sign("Ed25519", processorKeypair.privateKey, msg)) as ArrayBuffer
  );

  const tx = concat(new Uint8Array([1]), sigBytes, msg); // sig count = 1
  let binary = "";
  for (const b of tx) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// ELO computation (K=25, two-player)
// ---------------------------------------------------------------------------

function computeEloChanges(
  elo1: number,
  elo2: number,
  result: "player1_wins" | "player2_wins" | "draw"
): [number, number] {
  const K = 25;
  const expected1 = 1 / (1 + 10 ** ((elo2 - elo1) / 400));
  const expected2 = 1 - expected1;

  let score1: number, score2: number;
  if (result === "player1_wins") {
    score1 = 1; score2 = 0;
  } else if (result === "player2_wins") {
    score1 = 0; score2 = 1;
  } else {
    score1 = 0.5; score2 = 0.5;
  }

  const delta1 = Math.round(K * (score1 - expected1));
  const delta2 = Math.round(K * (score2 - expected2));
  return [delta1, delta2];
}

function evaluateRPS(
  move1: string,
  move2: string
): "player1_wins" | "player2_wins" | "draw" {
  if (move1 === move2) return "draw";
  if (
    (move1 === "rock" && move2 === "scissors") ||
    (move1 === "scissors" && move2 === "paper") ||
    (move1 === "paper" && move2 === "rock")
  ) {
    return "player1_wins";
  }
  return "player2_wins";
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------

async function runGame(payload: CallbackPayload, env: Env): Promise<void> {
  const { roomUrl, roomToken, participants } = payload;

  // Load processor keypair
  const keypairBytes = b58Decode(env.PROCESSOR_KEYPAIR);
  const secretSeed = keypairBytes.slice(0, 32);
  const pubkeyBytes = keypairBytes.slice(32, 64);
  // Ed25519 private key must be wrapped in PKCS8 DER for subtle.importKey
  const pkcs8 = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
    ...secretSeed,
  ]);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  const publicKey = await crypto.subtle.importKey("raw", pubkeyBytes, "Ed25519", true, ["verify"]);
  const processorKeypair = { privateKey, publicKey };

  // Compute program address bytes
  const rpsProgramBytes = b58Decode(env.RPS_PROGRAM_ID);

  // Derive config PDA
  const [configPdaBytes] = await findProgramAddress(
    [new TextEncoder().encode("config")],
    rpsProgramBytes
  );

  // Connect to room WebSocket as processor
  // Cloudflare Workers fetch() requires https:// (not wss://) for WebSocket upgrades
  const wsUrl = roomUrl + `?token=${encodeURIComponent(roomToken)}`;
  const resp = await fetch(wsUrl, {
    headers: { Upgrade: "websocket" },
  });
  if (resp.status !== 101) {
    throw new Error(`Failed to connect to room: HTTP ${resp.status}`);
  }
  const ws = (resp as unknown as { webSocket: WebSocket }).webSocket;
  ws.accept();

  // Send initial_game_state to unlock player inputs
  ws.send(JSON.stringify({ type: "initial_game_state", payload: { round: 1 } }));

  // Collect one move from each player (first valid move wins, ignores duplicates)
  const players = participants.filter((p) => p.role === "player");
  if (players.length !== 2) {
    ws.close();
    throw new Error(`Expected 2 players, got ${players.length}`);
  }
  const [p1, p2] = players as [typeof players[0], typeof players[0]];
  const moves = new Map<string, string>();

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timeout waiting for player moves"));
    }, 60_000);

    ws.addEventListener("message", (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as {
          type: string;
          payload?: { from: string; data: { move: string } };
        };
        if (msg.type === "game_message" && msg.payload) {
          const { from, data } = msg.payload;
          if (
            !moves.has(from) &&
            players.some((p) => p.walletPubkey === from) &&
            ["rock", "paper", "scissors"].includes(data?.move)
          ) {
            moves.set(from, data.move);
          }
        }
      } catch {
        // ignore parse errors
      }
      if (moves.size === 2) {
        clearTimeout(timeout);
        resolve();
      }
    });

    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      reject(new Error("Room WebSocket closed before both moves received"));
    });
  });

  const move1 = moves.get(p1.walletPubkey)!;
  const move2 = moves.get(p2.walletPubkey)!;
  const result = evaluateRPS(move1, move2);

  // Fetch current ELO for both players from Solana
  async function getPlayerElo(walletB58: string): Promise<number> {
    const walletBytes = b58Decode(walletB58);
    const [pdaBytes] = await findProgramAddress(
      [new TextEncoder().encode("player"), walletBytes],
      rpsProgramBytes
    );
    const pdaAddress = b58Encode(pdaBytes);
    const info = await rpcCall<{ value: { data: [string, string] } | null }>(
      env.SOLANA_RPC_URL,
      "getAccountInfo",
      [pdaAddress, { encoding: "base64", commitment: "confirmed" }]
    );
    if (!info.value) return 1000; // default if not initialized
    const data = Uint8Array.from(atob(info.value.data[0]), (c) => c.charCodeAt(0));
    return new DataView(data.buffer).getUint32(0, true);
  }

  const elo1 = await getPlayerElo(p1.walletPubkey);
  const elo2 = await getPlayerElo(p2.walletPubkey);
  const [delta1, delta2] = computeEloChanges(elo1, elo2, result);
  const newElo1 = Math.max(0, elo1 + delta1);
  const newElo2 = Math.max(0, elo2 + delta2);

  const winner =
    result === "player1_wins"
      ? p1.walletPubkey
      : result === "player2_wins"
        ? p2.walletPubkey
        : "draw";

  // Show players the moves + result immediately
  ws.send(
    JSON.stringify({
      type: "game_state_update",
      payload: {
        seqId: 1,
        moves: { [p1.walletPubkey]: move1, [p2.walletPubkey]: move2 },
        result,
      },
    })
  );

  // Settle ELO on-chain before sending game_over — the open room acts as the
  // natural re-queue lock. Players see the result now; game_over fires once
  // the tx confirms (~400ms on mainnet). No platform-side locks needed.
  let eloSettled = false;
  try {
    const updates = await Promise.all(
      ([
        [p1.walletPubkey, newElo1],
        [p2.walletPubkey, newElo2],
      ] as [string, number][]).map(async ([wallet, newElo]) => {
        const [playerPdaBytes] = await findProgramAddress(
          [new TextEncoder().encode("player"), b58Decode(wallet)],
          rpsProgramBytes
        );
        return { playerPdaBytes, newElo };
      })
    );

    const blockhash = await getLatestBlockhash(env.SOLANA_RPC_URL);
    console.log(`[rps] blockhash: ${blockhash}`);

    const txBase64 = await buildUpdateEloTx(
      processorKeypair,
      pubkeyBytes,
      updates,
      configPdaBytes,
      rpsProgramBytes,
      blockhash
    );

    const sig = await sendTransaction(env.SOLANA_RPC_URL, txBase64);
    console.log(`[rps] tx submitted: ${sig}`);
    await waitForConfirmation(env.SOLANA_RPC_URL, sig);
    eloSettled = true;
    console.log(`[rps] ELO settled — p1: ${newElo1}, p2: ${newElo2} (sig: ${sig})`);
  } catch (err) {
    console.error(`[rps] ELO settlement failed:`, err);
  }

  // Always send game_over so players are never left hanging.
  // eloSettled=false is rare (devnet flakiness, mainnet is ~400ms) but we
  // unblock the room either way — the queue's active-match KV key is cleared
  // and players can re-queue. ELO stays at pre-match values on settlement failure.
  ws.send(
    JSON.stringify({
      type: "game_over",
      payload: {
        winner,
        eloChanges: eloSettled
          ? [
              { wallet: p1.walletPubkey, delta: delta1, newElo: newElo1 },
              { wallet: p2.walletPubkey, delta: delta2, newElo: newElo2 },
            ]
          : [],
      },
    })
  );

  ws.close();
}

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/callback") {
      let payload: CallbackPayload;
      try {
        payload = (await request.json()) as CallbackPayload;
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      // Validate required fields
      if (!payload.matchId || !payload.roomUrl || !payload.roomToken) {
        return new Response("Missing required fields", { status: 400 });
      }

      // Return 200 immediately — game runs asynchronously
      ctx.waitUntil(
        runGame(payload, env).catch((err: unknown) => {
          console.error(`[rps] Game error for match ${payload.matchId}:`, err);
        })
      );

      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};
