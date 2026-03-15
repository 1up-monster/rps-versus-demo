# rps-game

Rock Paper Scissors reference implementation for the [1upmonster](https://1up.monster) platform.

Demonstrates the full stack end-to-end:

- **Solana program** (`programs/rps-player`) — Pinocchio `#![no_std]` program that stores per-player ELO on-chain. Only the authorized game processor can update ELO.
- **Game processor** (`processor/`) — Cloudflare Worker that receives match callbacks, connects to the room as the processor, collects moves from both players, evaluates the winner, and writes updated ELO on-chain.
- **Terminal clients** (`client/`) — Node.js CLI that any player runs to queue, accept a match, submit a move, and see the result.

```
Player A terminal ──┐
Player B terminal ──┼──► 1upmonster matchmaking ──► match found
                    │              │
                    │              └──► POST /callback → rps-processor Worker
                    │                         │
                    └──────────────────────────┤
                                               ▼
                                    1upmonster Room (WebSocket relay)
                                               │
                                    Processor collects moves,
                                    evaluates winner, updates ELO
                                               │
                                               └──► Solana update_elo tx
```

## Repo structure

```
rps-game/
├── programs/rps-player/    # Pinocchio Solana program
├── processor/              # Cloudflare Worker — game processor
├── client/                 # Terminal CLI for players
└── scripts/setup.ts        # One-time devnet bootstrap
```

## Prerequisites

| Tool | Purpose |
|------|---------|
| [Rust + `cargo-build-sbf`](https://solana.com/docs/intro/installation) | Build the Solana program |
| [Solana CLI](https://solana.com/docs/intro/installation) | Deploy program, airdrop, inspect accounts |
| [Node.js 20+](https://nodejs.org) | Client and scripts |
| [pnpm](https://pnpm.io) | Package manager |
| [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) | Deploy the processor Worker |
| [1upmonster CLI](https://1up.monster/docs/cli) | Configure versus and processor |
| A Solana RPC with devnet support (e.g. [Helius](https://helius.dev)) | Reliable RPC for Worker calls — public endpoints block cloud IPs |

You will need:
- A funded Solana keypair at `~/.config/solana/id.json` (deployer + player 1)
- A second keypair for player 2 (e.g. `~/.config/solana/id2.json`)
- A Cloudflare account (free tier is fine)
- A 1upmonster account with a game created (`1up game create "My RPS Game"`)

## Deploy order

Work through these steps in order. Each one depends on the previous.

---

### 1. Install dependencies

```bash
pnpm install
```

---

### 2. Build and deploy the Solana program

```bash
pnpm build:program
pnpm deploy:program --url devnet
```

Note the **Program ID** printed at the end (e.g. `819bCV5ag...`). You'll use it everywhere.

> The program stores two account types:
> - **Config PDA** `["config"]` — 32 bytes, holds the processor's authorized public key
> - **Player PDA** `["player", wallet_pubkey]` — 4 bytes, holds ELO as `u32 LE`

---

### 3. Generate a processor keypair

The processor is the only account authorized to update ELO on-chain. Generate a dedicated keypair for it:

```bash
solana-keygen new -o processor-keypair.json
# Note the public key printed — this is <PROCESSOR_PUBKEY>
```

Fund it on devnet:

```bash
solana airdrop 2 <PROCESSOR_PUBKEY> --url devnet
```

> If the airdrop rate-limits you, use `solana transfer <PROCESSOR_PUBKEY> 0.5 --url devnet` from your main keypair instead.

---

### 4. Initialize the config PDA

This registers the processor's public key in the on-chain config account. Run once:

```bash
pnpm install   # if not already done
npx tsx scripts/setup.ts \
  --keypair ~/.config/solana/id.json \
  --processor-wallet <PROCESSOR_PUBKEY> \
  --rps-program <PROGRAM_ID> \
  --rpc-url https://devnet.helius-rpc.com/?api-key=<YOUR_KEY>
```

The script checks whether the config PDA already exists and skips if so.

---

### 5. Update wrangler.toml

Edit `processor/wrangler.toml` and set `RPS_PROGRAM_ID` to the program ID from step 2:

```toml
[vars]
RPS_PROGRAM_ID = "<PROGRAM_ID>"
```

---

### 6. Set processor Worker secrets

Base58-encode the processor keypair, upload it as a secret, then **delete the file**:

```bash
# Encode the keypair (requires python3 + base58 package: pip install base58)
KEYPAIR_B58=$(python3 -c "
import json, base58, sys
data = json.load(open('processor-keypair.json'))
print(base58.b58encode(bytes(data)).decode())
")

cd processor
echo "$KEYPAIR_B58"             | wrangler secret put PROCESSOR_KEYPAIR
echo "https://devnet.helius-rpc.com/?api-key=<YOUR_KEY>" | wrangler secret put SOLANA_RPC_URL
echo "<GAME_ID>"                | wrangler secret put GAME_ID

# Delete the keypair — the secret is now exclusively in Wrangler
cd ..
rm -f processor-keypair.json
```

> **Why a Helius (or similar) RPC for the Worker?** Cloudflare Worker IPs are blocked by the public `api.devnet.solana.com` endpoint. You must use a provider that allows requests from cloud infrastructure.

---

### 7. Deploy the processor Worker

```bash
cd processor
wrangler deploy
# Note the Worker URL: https://rps-processor.<your-subdomain>.workers.dev
```

---

### 8. Configure 1upmonster versus

Tell the platform how to read on-chain ELO and where to send match callbacks:

```bash
1up versus config set <GAME_ID> \
  --elo-account-type pda \
  --elo-program-id <PROGRAM_ID> \
  --elo-seeds player,{wallet} \
  --elo-offset 0 --elo-type u32 --elo-endian little \
  --elo-default 1000 --elo-rpc-fail use_default \
  --players-per-team 1 --teams 2 \
  --queue-ttl 60 --match-ttl 120 --accept-window 15 \
  --rpc-url https://devnet.helius-rpc.com/?api-key=<YOUR_KEY>

1up versus processor set <GAME_ID> \
  --wallet <PROCESSOR_PUBKEY> \
  --callback https://rps-processor.<your-subdomain>.workers.dev/callback
```

---

### 9. Build the client

```bash
cd client
pnpm install
pnpm build
```

---

## Play

Open two terminals with different keypairs:

**Terminal 1:**
```bash
node client/dist/index.js \
  --keypair ~/.config/solana/id.json \
  --api-key <GAME_API_KEY> \
  --game-id <GAME_ID> \
  --rps-program <PROGRAM_ID>
```

**Terminal 2:**
```bash
node client/dist/index.js \
  --keypair ~/.config/solana/id2.json \
  --api-key <GAME_API_KEY> \
  --game-id <GAME_ID> \
  --rps-program <PROGRAM_ID>
```

> Get a `<GAME_API_KEY>` with: `1up game api-key create <GAME_ID>`

Both players queue → match found → both accept → both pick a move → processor evaluates → ELO updated on-chain.

Expected output (player 1 perspective):

```
[1upmonster RPS]
Wallet:  Fh68kkX...
Player:  2bDEHD3...  (ELO: 1000)

Authenticating...
  Authenticated as Fh68kkX...

Joining queue...
  Queued (ELO: 1000)

Match found! Opponent: EJ5Ey2E... (ELO: 1000)
Accept deadline: 3:13:55 PM
Accept? [y/n] > y
Accepting match...
=== MATCH ===
Choose your move: [r]ock / [p]aper / [s]cissors > r
  Sent: ROCK

Waiting for opponent...

You:      ROCK
Opponent: SCISSORS

Result: YOU WIN  (+13 ELO → 1013)

Done.
```

---

## Verify on-chain ELO

```bash
# Player PDA address is printed by the client at startup
solana account <PLAYER_PDA_ADDRESS> --url devnet --output json
# bytes [0..4] at offset 0 are the ELO as u32 little-endian
```

---

## How it works

### On-chain program

Three instructions (first byte = discriminator):

| Instruction | Who calls it | What it does |
|-------------|-------------|--------------|
| `0x00 initialize_config` | Deployer (once) | Creates config PDA, stores processor authority |
| `0x01 initialize_player` | Each player (once) | Creates player PDA, sets initial ELO |
| `0x02 update_elo` | Processor only | Verifies processor authority, updates player ELO |

Account layouts:

| Account | Seeds | Size | Layout |
|---------|-------|------|--------|
| Config PDA | `["config"]` | 32 bytes | `[0..32] game_processor_authority: Pubkey` |
| Player PDA | `["player", wallet_pubkey]` | 4 bytes | `[0..4] elo: u32 LE` |

### Game processor flow

1. 1upmonster sends `POST /callback` with `{ matchId, roomUrl, roomToken, participants }`
2. Worker returns `200 OK` immediately; game runs in `ctx.waitUntil()`
3. Processor connects WebSocket to room (using `https://` URL with `Upgrade: websocket`)
4. Sends `initial_game_state` → unlocks player inputs in the room
5. Collects one valid move (`rock`/`paper`/`scissors`) from each player
6. Evaluates winner; computes ELO delta (K=25 Elo formula)
7. Sends `game_state_update` (moves + result) then `game_over` (winner + ELO changes)
8. Closes WebSocket
9. Submits `update_elo` transactions on-chain for both players

### ELO formula

Standard Elo with K=25:

```
expected = 1 / (1 + 10^((opponent_elo - my_elo) / 400))
delta = round(K * (score - expected))   // score: win=1, draw=0.5, loss=0
```

---

## Troubleshooting

**`RPC error: Your IP or provider is blocked`**
The public `api.devnet.solana.com` blocks Cloudflare Worker IPs. Set `SOLANA_RPC_URL` to a Helius or Alchemy devnet endpoint.

**`Already in queue or pending proposal`**
A previous match is still active. Wait for `match-ttl` (120s by default) to expire, then retry.

**Player PDA not initialized**
The client initializes it automatically on first run. Make sure the player's wallet has enough SOL to pay rent (~0.001 SOL). Airdrop if needed:
```bash
solana airdrop 1 <WALLET_PUBKEY> --url devnet
```

**Processor receives callback but moves never arrive**
Ensure both players connect to the room *after* the processor has sent `initial_game_state`. The platform buffers player messages sent before the processor is ready and delivers them once it connects.

---

## Security

- The processor keypair lives exclusively as a Wrangler secret — never committed to git
- `.gitignore` excludes `*.json` files (keypairs) from the repo root
- `initialize_config` runs once at deploy time; there is no admin key that can re-run it after the fact
- `update_elo` validates `config_pda.game_processor_authority == signer` on-chain — no other wallet can change ELO
