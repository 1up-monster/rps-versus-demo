# FAQ

## What runs on Solana vs off-chain?

This is the most common question, so here's an explicit breakdown.

### On Solana (on-chain)

| What | Where | Why on-chain |
|------|-------|--------------|
| Player ELO scores | Player PDA `["player", wallet_pubkey]` | Persistent, publicly verifiable, owned by no single party |
| Processor authority | Config PDA `["config"]` | Immutable record of which wallet is allowed to update ELO — enforced by the program, not by us |
| ELO update transactions | `update_elo` instruction | The only way to mutate on-chain ELO — requires the processor's signature, verified on-chain |

**Nothing else lives on Solana.** The match itself, the moves, the result — none of that is on-chain.

---

### Off-chain

| What | Where | Notes |
|------|-------|-------|
| Matchmaking queue | 1upmonster platform | Pairs players by ELO band, manages accept/decline flow |
| Match room (WebSocket relay) | 1upmonster platform | Relays messages between players and the processor during a match |
| Move collection + winner evaluation | your game processor (`processor/` in this repo) | Receives both moves, runs `rock > scissors > paper > rock` logic |
| ELO delta computation | your game processor (`processor/` in this repo) | K=25 Elo formula — result is what gets written on-chain |
| Player authentication | 1upmonster platform | Wallet signs a challenge; platform issues a short-lived JWT |

---

## So the game result isn't on-chain?

Correct. The move (`rock`, `paper`, `scissors`) and the match outcome (`player1_wins`, etc.) are never written to Solana. Only the **resulting ELO values** are stored on-chain after the match ends.

This is intentional — writing every game event on-chain would be slow and expensive. The on-chain program is used purely as a **trustworthy scoreboard**: players can independently verify their ELO on Solana Explorer without trusting 1upmonster's database.

---

## Why does the processor need an on-chain keypair at all?

The Solana program (`rps-player`) has a permissioned `update_elo` instruction. It only accepts updates signed by the wallet stored in the config PDA. Without this, anyone could submit a transaction and set their own ELO to whatever they liked.

The processor keypair is the **bridge**: it runs off-chain (as an environment secret on your server), but its public key is recorded on-chain during the `initialize_config` step. When it signs an `update_elo` transaction, the program verifies the signature matches the stored authority — no trust in 1upmonster required.

---

## Could someone cheat by submitting their own `update_elo` transaction?

No. The program enforces:

```
stored_authority (from config_pda) == signer (game_processor)
```

Only the wallet whose public key was written into the config PDA during setup can call `update_elo`. That keypair lives exclusively on your server / hosting environment — it never touches a browser or a client device.

---

## Could someone cheat during the match by sending a fake move?

The match room is a private WebSocket connection authenticated by a short-lived JWT issued by 1upmonster. Your game processor collects moves and ignores any message not from an authenticated participant. The first valid move from each player wins — duplicate messages are ignored.

That said, a player can simply disconnect or refuse to send a move. This is handled by a 60-second timeout in the processor: if both moves aren't received in time, the match expires without an ELO change.

---

## What happens if the processor crashes mid-match?

1upmonster closes the room when the match TTL expires. If the processor never sends `game_over`, no ELO update is submitted. Players' ELO stays unchanged — they can re-queue after the match TTL passes.

---

## Does my game processor have to be a Cloudflare Worker?

No. The processor is just an HTTP server. The platform sends a `POST /callback` and your server connects back via WebSocket. Any runtime that can handle an inbound HTTP request and open an outbound WebSocket works — Node.js, Bun, Deno, Python, Go, etc. This demo uses a Cloudflare Worker as one example.

---

## What is 1upmonster's role vs the game developer's role?

| Responsibility | 1upmonster | Game developer |
|---------------|-----------|----------------|
| Matchmaking queue | ✅ | — |
| WebSocket room relay | ✅ | — |
| Player authentication (wallet challenge/JWT) | ✅ | — |
| ELO read from Solana | ✅ | — |
| Game logic (who wins RPS) | — | ✅ (`processor/`) |
| On-chain program (ELO storage) | — | ✅ (`programs/rps-player`) |
| ELO write to Solana | — | ✅ (processor signs the tx) |

1upmonster handles the infrastructure plumbing. The game developer owns the rules and the on-chain state.
