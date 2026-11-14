@AGENTS.md

# Project: Chert FaceTime voice agent ("Nova")

A voice agent you can FaceTime. Callers dial a Chert line; Chert's Mac answers and bridges the call into a LiveKit room where this agent (LiveKit Agents 1.8.0 + OpenAI Realtime `gpt-realtime`, voice `marin`) is waiting. Built by Mustafa (UT Arlington CS) for a hackathon.

Read this file first. Deeper context lives in `docs/`:
- `docs/PROJECT_CONTEXT.md` — what was set up, decisions made, history, current state, next steps
- `docs/RUNBOOK.md` — exact commands to run, restart and test
- `docs/TROUBLESHOOTING.md` — every error we hit and its fix

## Current state (as of 2026-11-14)
- Fully working end to end: a real FaceTime call connected, Chert answered in 0.0 s, the agent greeted and held a ~4 minute conversation.
- Agent personality was rewritten to "Nova" (warm, short spoken turns) with `semantic_vad` low-eagerness turn detection to reduce cutoffs. The original is `agent.mjs.bak` (git-ignored, local only).
- Not yet re-tested by live call after the Nova rewrite.
- Git repo on `main`, pushed to the private GitHub repo `4mustafa454/my-agent` (origin).

## Run it (two terminals, same folder)
```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # Node 24 is required; Node 26 breaks LiveKit native bindings
cd ~/chert-agent/my-agent
# Terminal 1 — the agent. Leave running.
npm start
# Terminal 2 — connects it to the FaceTime line. Leave running.
chert doctor --agent my_agent
chert dev --agent my_agent
```
Then FaceTime **Audio** the line (+13175070563) once `chert dev` prints that `my_agent` is in a waiting room.

## Rules that matter (learned the hard way)
1. **Agent name is `my_agent` (underscore).** `AGENT_NAME` in `.env.local` and `--agent my_agent` must match what the agent registers with LiveKit. `my-agent` (hyphen) fails. `setup.sh` one level up still uses the hyphen — do not trust it.
2. **Never commit secrets.** `.env.local` holds LiveKit and OpenAI keys and is git-ignored. Only `.env.example` (placeholders) is tracked. Never paste keys in chat, issues, or docs.
3. **Two processes must stay up**: `npm start` (agent) and `chert dev`. Ctrl+C **once** to stop; pressing it twice force-exits and leaves orphaned workers.
4. **Greet within 10 s of `chert_bridge_ready`** or the call ends. `greet.mjs` handles this; do not greet on room join.
5. **Use FaceTime Audio.** The agent publishes no video, so Video calls show the line's default picture.
6. After editing `agent.mjs`: end the call, Ctrl+C `chert dev`, restart `npm start`, then `chert dev` again (no hot reload).
7. Node `^22.23.2 || ^24 || ^26` per package.json, but use **Node 24** (Homebrew `node@24` is keg-only, so export PATH in every new terminal).
8. OpenAI needs credits. `credit_balance_exhausted` errors mean the account balance is empty (a $5 top-up fixed it once).

## Limits and environment
- Chert free trial on a **shared line**: 50 FaceTime minutes/day, **5 minutes per call**, one call at a time, trial window ~48 h for trials started by 2026-11-18. The line can show "Busy"/`line_offline` when Chert's Mac is offline — that is on Chert's side (contact their Discord / Anish).
- Chert CLI: `@trychert/facetime` beta (`chert` command). Sign-in lasts 30 days (`chert login`).
- Deploys and paid actions: ask the user first.

## Files
- `agent.mjs` — agent definition: `instructions` (Nova persona), `greeting`, realtime model and turn detection.
- `greet.mjs` — greets once when room metadata has `chert_bridge_ready: true`.
- `chert-rooms.mjs` — Chert/LiveKit room wiring (starter code; avoid editing unless needed).
- `.env.example` / `.env.local` — config template / real secrets (ignored).
- `AGENTS.md` — Chert's generated rules for coding agents (refresh with `chert context --write`).

## Working style for this user
- Student on a deadline (hackathon). Prefer short, exact, copy-pasteable commands and plain explanations.
- Terminal and VS Code can't be typed into by Claude's desktop computer-use (click-only), so give commands for the user to paste.
