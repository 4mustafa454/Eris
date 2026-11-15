# Eris demo runbook

Rehearse this end to end before the real run. The call must stay **under 5 minutes** (Chert trial: 5 min per call,
50 FaceTime minutes total, valid 24 h from activation). The script below is about 3 minutes.

## 1. Startup order

Always in this order. Each command is in its own terminal. Node 24 for the supervisor (not 26).

```sh
# Terminal 1: harness  (http://localhost:8787)
cd harness && .venv/bin/uvicorn app.main:app --port 8787

# Terminal 2: supervisor  (the PM; serves http://localhost:8788/frame.jpg while a call is live)
cd supervisor && npm start

# Terminal 3: Chert line. Wait for "agent_warm" before anyone calls.
cd supervisor && chert dev --json

# Terminal 4: dashboard  (http://localhost:5173)
cd dashboard && npm install && npm run dev
```

Notes that differ from what you might expect:

- The supervisor has **no `npm run dev`**; the command is `npm start` (it loads `.env.local`).
- The `:8788` frame mirror exists only while a call is running, or while `npm run frames` runs. Only one process can
  hold the port, so **stop `npm run frames` before the real call** or the supervisor runs without the mirror.
- The dashboard lives on branch `m5-dashboard` (`dashboard/` is empty on `m6-backend`). Check that branch out or merge
  it before this step; its dev script is `vite` on `:5173`.
- After any supervisor code change restart **both** the supervisor and `chert dev`. Stop `chert dev` with Ctrl+C once
  and wait for `dev_stopped`; never kill -9 it.

## 2. Demo-only configuration

Rehearsal in Agent Console and the real demo differ in these places only.

`supervisor/.env.local`

| Setting | Dev (Agent Console) | Demo (Chert line) |
|---|---|---|
| `TTS_PROVIDER` | `deepgram` | `elevenlabs` |
| `ELEVENLABS_VOICE_ID` | empty | the chosen voice id |
| `ELEVENLABS_API_KEY` | optional | required (shared credit pool for STT and TTS) |
| `GREET_ON_JOIN` | `1` | **remove the line / leave empty.** Chert's `bridge_ready` signal triggers the greeting; leaving it on also does nothing for `chert-bridge-*` callers, but keep it off so the setup is the same as the real line |
| `LIVEKIT_URL` / `_API_KEY` / `_API_SECRET` | your LiveKit project | empty on a Shared plan with Chert rooms (`chert dev` hands out a token) |
| `AGENT_NAME` | `eris` | `eris` |

`harness/.env`

```sh
REAL_WORKERS=agent-1,agent-3  # comma-separated ids. Both engines are supported: agent-1 and agent-2 are Claude Code,
                              # agent-3 is Codex. Every id not listed stays a mock. A bad or unsupported id stops
                              # startup naming the variable.
CLAUDE_CODE_OAUTH_TOKEN=...   # Claude workers: from `claude setup-token`; never paste it into a prompt or chat
NTFY_TOPIC=<your topic>       # alerts + "Call recap" go here
# Codex workers (defaults shown; usually leave unset): CODEX_WORKER_IMAGE=eris-codex:0.167.2,
# CODEX_MODEL=gpt-6.1-terra, CODEX_REASONING=medium
```

Codex worker prerequisites (one-time):

- Build the image: `scripts/build-codex-worker.sh` (Claude workers: `scripts/build-worker.sh`).
- Sign in on the host with `codex login` (ChatGPT account). The Codex container gets the host's `~/.codex/auth.json`
  as a **read-only bind mount** (`docker.py`); there is no token in an env var, image or command line. Because it is
  read-only, a token refresh can only happen on the host, never from inside the container. (This is deliberate and matches `/AGENTS.md` §7.) Treat the file as a password: never commit or paste it.

Validate it without starting anything: `cd harness && .venv/bin/python -m app.config`.

The database is seeded once, so changing `REAL_WORKERS` only takes effect after `scripts/seed-demo.sh` (next section).
Restart the supervisor and `chert dev` after editing `.env.local`.

## 3. Pre-demo checklist

Do these in order, no more than ~15 minutes before the call.

- [ ] **Docker + worker images ready:** `scripts/build-worker.sh` and `scripts/build-codex-worker.sh` have been run once; Docker is running.
- [ ] **Codex token refresh check (do this the same day, before the call).** Run a tiny Codex task on the host, then through the worker:
      ```sh
      codex exec "reply with the single word ok"        # on the host: refreshes ~/.codex/auth.json if it is stale
      curl -X POST localhost:8787/agents/agent-3/task -H 'content-type: application/json' \
        -d '{"instruction":"Reply with the single word ok. Do not change any files."}'
      curl -s localhost:8787/agents/agent-3/log          # expect a short line or two, no auth/login error
      ```
      The container's copy of the token is read-only and cannot refresh itself, so an expired token would only show up
      mid-demo as an error on agent-3. If it fails, run `codex login` on the host and repeat. Start the harness for this (section 1, terminal 1)
      and **stop it again before the reset below**, which wipes the tiny task.
- [ ] **Reset the data** (stop the harness first; the script refuses to run while it answers):
      `scripts/seed-demo.sh --yes --with-approval=agent-2`
      This wipes the dev DB (so test calls do not appear in the recap), rebuilds `demo-repo/` with its failing test,
      removes old worker containers, and then creates one pending `git_push` approval for `agent-2`
      (a mock agent when `REAL_WORKERS=agent-1,agent-3`; it becomes "Awaiting approval". An idle real agent would not). Use another agent id after `=` if you like; the default is `agent-1`,
      which you do **not** want here because `agent-1` is the one that gets stuck for real.
- [ ] Start the harness, supervisor and dashboard (section 1), then confirm: `curl -s localhost:8787/agents` shows three agents,
      and `curl -s 'localhost:8787/approvals?status=pending'` shows one.
- [ ] **Chert sign-in and line:** `chert whoami` shows the right project (re-run `chert login` if it has been 30 days),
      then `chert doctor --agent eris` is all green, including that `eris` joined a test room.
      Start `chert dev --json` and wait for `agent_warm`. Keep it running: an unconnected trial line returns to the pool.
- [ ] **frame.jpg loads.** Before the call the supervisor serves nothing on `:8788`, so check it with
      `cd supervisor && npm run frames`, open `http://localhost:8788/frame.jpg` and confirm the three-agent picture
      (and the approval banner). Then **stop `npm run frames`** (Ctrl+C). During the call the same URL, and the dashboard Live page, serve the real picture.
- [ ] **ntfy subscribed:** the phone has the ntfy app subscribed to the same topic as `NTFY_TOPIC`.
      Check with `curl -d "ntfy test" ntfy.sh/<your topic>`; it should arrive within seconds.
- [ ] **Prime the stuck agent.** Hand `agent-1` the endpoint task (task 2 in `demo-template/TASKS.md`) a couple of minutes before the call so it has already reached `BLOCKED`:
      ```sh
      curl -X POST localhost:8787/agents/agent-1/task -H 'content-type: application/json' \
        -d '{"instruction":"Register new users with the partner API after signup through the endpoint in shop/client.py. Do not pick an endpoint yourself: if the repo does not say which, stop and reply BLOCKED: which endpoint, v1 or v2?"}'
      ```
      Watch `curl -s localhost:8787/agents/agent-1` until `state` is `stuck` and `stuck_reason` is the v1/v2 question
      (the ntfy alert fires once, debounced 2 minutes). If you would rather it go stuck on cue during the call, hold this back and send it at step 3.
- [ ] Phone: place a **FaceTime Video** call (not Audio; Audio gives a call with no picture). Volume up, headphones if the room is noisy.

## 4. The 3-minute script

Say the quoted lines. The PM answers in one or two sentences by design; do not wait for long answers.

| # | You do / say | The PM does | On screen (the PM's video on the phone) |
|---|---|---|---|
| 1 | Call the Eris number on **FaceTime Video**. Say nothing. | Speaks the greeting within 10 s of `bridge_ready`: a recap of the last call plus what needs attention, e.g. a stuck agent and the pending push. | Portrait grid of 3 agent tiles, colour badge per state. Agent 1 shows stuck; the approval banner ("Approval: Agent 2 · git_push, Say approve or deny") is already up if you seeded it. |
| 2 | "What's everyone doing?" | Calls `get_status`; one or two sentences covering all three agents. | Grid unchanged. |
| 3 | "Show me agent 3." Then "Tell agent 3 to add tests for the billing module." | `focus_agent`, then `send_task`: agent 3 (the Codex worker) is idle, so this starts a new task: "Told agent 3." Do **not** steer Agent 2 here: it is waiting on the approval in step 5 and steering would clear that. | Full-screen Agent 3 with its last lines and state turning to working. A `send_task` row is written to the session. |
| 4 | "Show me the grid." Then "What's wrong with agent 1?" Then answer: "Tell it to use the v2 endpoint." | `explain_agent` (one sentence: it asks v1 or v2), then `send_task` steers the same task: "Told agent 1." | Agent 1's tile goes from the stuck colour back to working, then green when it commits. |
| 5 | The PM says "Agent 2 wants to push. Approve?" (if it does not, ask "anything waiting on me?"). Say: "Approve." | Calls `decide_approval` only on a clear yes/no. | The banner disappears. Dashboard (second screen): approval turns approved; Agent 2 returns to working. |
| 6 | "That's all, thanks." Hang up. | Writes a 2-3 sentence summary into the session (`PATCH /sessions/{id}`). | Dashboard Conversations: the call is already there with transcript, actions and summary. |
| 7 | Show the phone's lock screen. | Harness sends the summary to ntfy as "Call recap: ...". | ntfy notification on the phone within a few seconds. Optional close: in Conversations click **Continue** and type a follow-up. |

Cheat sheet if the PM misses a cue: "show me agent N", "show me the grid", "tell agent N to ...", "pause agent N",
"stop everything" (kill switch; use it only if something goes wrong).

Live seeding alternative for step 5: reset *without* `--with-approval`, and from a spare terminal run
`scripts/seed-approval.sh agent-2 git_push` at the moment you want the banner to appear. The banner and the PM's question show up within about a second.
(There is no real worker-initiated approval request in the harness yet, so seeding is how the approval is created for the demo.)

## 5. Fallbacks

**Harness unreachable.** The call keeps going. The picture turns into the red "HARNESS UNREACHABLE" frame and the PM
says it can't reach the team. Restart it (`cd harness && .venv/bin/uvicorn app.main:app --port 8787`); the grid comes back
by itself within a few seconds, no need to redial. Real workers that were `working` come back as `stuck`
("harness restarted during this run"): steer them with "tell agent 1 to continue". If it will not come back, say so and
hang up cleanly: a call that ends without a summary still has its transcript.

**Agent Console instead of the phone** (no Chert line, trial minutes used up, or the line is offline). Nothing about the harness changes.
1. In `supervisor/.env.local` set `GREET_ON_JOIN=1` and your own `LIVEKIT_*` project values; keep `AGENT_NAME=eris`.
2. Start the harness and `cd supervisor && npm start`. **Do not run `chert dev`.**
3. Open LiveKit **Agent Console**, dispatch to the agent named `eris`. The greeting plays about two seconds after you join, and the team grid appears as the agent's camera.
4. Run the same script (steps 1-6). Use a normal session, not FaceTime: sessions from Agent Console are recorded with channel `facetime`, so `scripts/seed-demo.sh` before the real run so they do not appear in the recap.
5. You will not get the FaceTime picture crop or the phone recap; the ntfy recap still fires when the call ends.

**ElevenLabs out of credit or down.** Set `TTS_PROVIDER=deepgram`, restart the supervisor and `chert dev`.

**Everything else failed.** Show the dashboard (Live, Conversations, Tasks) against a freshly seeded harness and talk through the script.
A recorded backup video is still to be made (M7); it is not in the repo yet.
