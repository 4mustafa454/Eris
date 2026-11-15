# AGENTS.md — Eris (HackUTA 2026, Chert track)

> Shared contract for every human and AI agent (Claude Code, Codex, Cursor, Grok) working in this repo.
> Claude Code reads `CLAUDE.md` — keep a one-line `CLAUDE.md` containing `@AGENTS.md` so both stay in sync.
> Interfaces in §4–§5 (schema, harness API, AgentState, PM tools, frames) are frozen. Do not change them to make a task easier; if a task seems to need a change, stop and say so in your reply or PR description.

## 1. What we are building

Eris: mission control for a team of headless coding agents, run by a **PM agent** you can reach over FaceTime, text, or the web.

- **Call in** (FaceTime video) → see a live grid of 3 worker agents, ask the PM for status, say "show me agent 2", give instructions by voice.
- **Get called / alerted** when a worker is stuck → answer, see its screen, tell it the fix, watch it go green.
- **Continue anywhere**: every call and chat is saved; the PM remembers previous conversations; the web dashboard can resume any conversation.
- Pitch: "ClawdTime lets one agent call you. Hermes texts you. Eris lets you watch your whole team work and talk to it face to face."

Judging (Chert): fresh use of FaceTime video (2×), wow (1×), usefulness (1×). The PM's outgoing video = live view of the team is our core feature. Protect it. Do not chase Hermes on breadth (channels, skills); win on depth of live supervision.

### Demo script (90 seconds, rehearse this)
1. Call Eris → on `bridge_ready` the PM greets with the recap (must speak within 10 s): "Last call you had agent 3 rename the package — it finished. Agent 2 is writing tests." Grid of 3 agents on screen.
2. "Show me agent 2." → focus view. "What's it doing?" → one sentence.
3. Hang up. Agent 1 hits a blocker → alert → call in → "Show me agent 1" → "Tell it to use the v2 endpoint" → watch it go green.
4. PM: "Agent 1 wants to push. Approve?" → "Approve." → pushed.
5. Cut to dashboard: the call is already in Conversations with transcript, actions, summary. Click "continue" and type a follow-up.

## 2. Architecture

```
iPhone (FaceTime video)                 Browser (dashboard :5173)
   ⇅                                       ⇅ HTTP / SSE
Chert FaceTime line ── chert dev          harness/  (Python FastAPI :8787)
   ⇅                                       ├─ SQLite (WAL + FTS5): sessions, messages, actions, tasks, agents, events, approvals
LiveKit room (2 participants max)         ├─ PM web-chat endpoint (/chat) — same brain as voice
   ⇅                                       ├─ worker manager (docker) + stuck detection
supervisor/ (Node 24, LiveKit Agents JS)  ├─ alerts: ntfy now; Chert outbound later
   ├─ STT (Deepgram) → LLM → TTS (ElevenLabs Flash | Deepgram)   └─ settings (masked keys) + provider tests
   ├─ PM tools → HTTP → harness            ⇅ docker
   ├─ renderer → its own video track      workers/  (Claude Code | Codex, headless, non-root, one container each)
   ├─ GET :8788/frame.jpg (mirror for dashboard)
   └─ caller-frame buffer (latest frame on user turn)
shared/pm/  system_prompt.md + tools.json  ← loaded by BOTH supervisor and harness /chat
demo-repo/  small repo with seeded tasks + one deliberately broken test
```

**Hard constraints**
- Only ONE agent participant in the Chert LiveKit room. Worker screens are drawn into the supervisor's single video track.
- **One PM brain.** Voice (supervisor) and web (/chat) load the same `shared/pm/system_prompt.md` and `shared/pm/tools.json`, call the same harness routes, and log every turn to the same `sessions`/`messages` tables. Never fork the prompt or tool list.
- The dashboard never reads `.env` files; it only talks to the harness.

**Three instruction files — never mix them up**
| File | Read by | Purpose |
|---|---|---|
| `/AGENTS.md` (this file) + `/CLAUDE.md` (`@AGENTS.md`) | our coding tools while building | how to build Eris |
| `shared/pm/system_prompt.md` + `tools.json` | the PM agent at runtime (loaded in code) | how the PM behaves on calls/chat — never name it AGENTS.md |
| `supervisor/AGENTS.md` | coding tools when editing the supervisor | Chert's generated rules block (keep markers; refresh with `chert context --write`) + a short "Project-wide rules live in /AGENTS.md" line **outside** the markers |
| `demo-repo/AGENTS.md` | worker agents in Docker | how to do the demo tasks |
Precedence: inside `supervisor/`, Chert's block wins on Chert behavior (greeting, tracks, line handling); this file wins on everything else (architecture, interfaces, providers).

## 3. Repo layout

| Path | What it is | Stack |
|---|---|---|
| `shared/pm/` | PM prompt + tool schemas (used by voice and web) | Markdown + JSON Schema |
| `supervisor/` | Chert/LiveKit voice agent (the PM on calls) | Node 24 ESM, `@livekit/agents` + deepgram/elevenlabs/openai/silero plugins |
| `supervisor/render/` | grid/focus frame renderer | `@napi-rs/canvas` |
| `harness/` | API, database, worker control, stuck detection, web chat | Python 3.11+, FastAPI, sqlite3 (WAL, FTS5) |
| `workers/` | worker agent containers | Dockerfiles + entrypoints |
| `dashboard/` | web UI (talks only to harness) | Vite + React (scaffold with Lovable) |
| `demo-repo/` | separate git repo the workers operate on | whatever the demo tasks need |

Stay inside the folder your task is about; touch another folder only through the interfaces in §5.

## 4. Data model (SQLite, `harness/data/eris.db`)

Enable `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`. Timestamps are ISO-8601 UTC strings.

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,            -- 'agent-1'
  name TEXT NOT NULL,             -- 'Agent 1'
  color TEXT NOT NULL,            -- '#7F77DD' (same color on video, dashboard, alerts)
  engine TEXT NOT NULL,           -- 'claude-code' | 'codex'
  state TEXT NOT NULL,            -- 'idle'|'working'|'stuck'|'done'|'error'|'paused'
  task_id TEXT REFERENCES tasks(id),
  summary TEXT,
  stuck_reason TEXT,
  engine_session TEXT,            -- Claude session id / Codex thread id for resume
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'queued'|'working'|'stuck'|'done'|'cancelled'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (           -- one per call or chat thread
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,          -- 'facetime'|'web'|'imessage'
  title TEXT,
  summary TEXT,                   -- written by PM when session ends
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,             -- 'user'|'pm'|'system'
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');
-- keep in sync with AFTER INSERT/DELETE/UPDATE triggers on messages

CREATE TABLE actions (            -- every PM tool call, from any channel
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  tool TEXT NOT NULL,             -- 'send_task'|'pause_agent'|...
  args_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE events (             -- human-readable worker activity lines (prune to last 500/agent)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL,             -- 'line'|'state_changed'|'stuck'|'done'
  line TEXT NOT NULL,             -- 'run pytest → 2 failed'
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  action TEXT NOT NULL,           -- 'git_push'
  detail TEXT,
  status TEXT NOT NULL,           -- 'pending'|'approved'|'denied'
  session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE settings (           -- non-secret config only; secrets live in harness/.env
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## 5. Interfaces (the contract)

### 5.1 Agent state (JSON shape returned everywhere)
```json
{ "id": "agent-1", "name": "Agent 1", "color": "#7F77DD", "engine": "claude-code",
  "state": "working", "task": "Add input validation to /signup",
  "summary": "Running tests after editing signup.py", "stuck_reason": null,
  "updated_at": "2026-11-14T19:02:11Z" }
```

### 5.2 Harness HTTP API (`http://localhost:8787`)

**Agents**
| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/agents` | — | `AgentState[]` |
| GET | `/agents/{id}` | — | `AgentState` |
| GET | `/agents/{id}/log` | `?lines=40` | `{ "lines": string[] }` (short, phone-readable) |
| POST | `/agents/{id}/task` | `{ "instruction", "session_id"? }` | `AgentState` |
| POST | `/agents/{id}/pause` · `/resume` | `{ "session_id"? }` | `AgentState` |
| POST | `/stop-all` | — | `AgentState[]` (kill switch) |

**PM memory & conversations**
| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/context` | — | `{ recent_summaries: [{session_id, channel, summary, ended_at}] (last 5), agents: AgentState[], open_tasks, pending_approvals }` — loaded into the PM at every session start |
| POST | `/sessions` | `{ "channel" }` | `Session` |
| PATCH | `/sessions/{id}` | `{ "ended_at"?, "summary"?, "title"? }` | `Session` |
| GET | `/sessions` | `?channel=&limit=` | `Session[]` newest first |
| GET | `/sessions/{id}` | — | `Session` + `messages` + `actions` |
| POST | `/sessions/{id}/messages` | `{ "role", "text" }` | `Message` (supervisor logs every voice turn here) |
| POST | `/sessions/{id}/actions` | `{ "tool", "args": object, "result": object\|null, "agent_id"? }` | `Action` — for read-only/display tools only (see §5.3 logging rule); 404 on unknown session |
| POST | `/chat` | `{ "session_id"?, "text" }` | `{ "session_id", "reply", "actions" }` — web channel; runs the shared PM brain; creates a session if none |
| GET | `/search` | `?q=` | FTS5 hits: `[{session_id, snippet, created_at}]` |

**Tasks**
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/tasks` | `?status=` | `Task[]` |
| POST | `/tasks` | `{ "title", "instruction", "agent_id"? }` | `Task` |
| PATCH | `/tasks/{id}` | `{ "status"?, "agent_id"? }` | `Task` (assigning starts it if the agent is idle/done, else `queued` — see §5.2.1) |

**Approvals**
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/approvals` | `?status=pending` | `Approval[]` |
| POST | `/approvals/{id}` | `{ "decision": "approved"|"denied", "session_id"? }` | `Approval` |

**Settings**
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/settings` | — | config + providers; secrets masked as `sk-…a1b2` with `"set": true/false` |
| PUT | `/settings` | partial object | updated (secrets written to `harness/.env`, never echoed back) |
| POST | `/settings/test/{provider}` | — | `{ ok, detail }` — `deepgram`, `openai`, `ollama`, `livekit`, `claude`, `codex`, `chert`, `ntfy` |

**Live updates**: `GET /events` (SSE) → `{ "type": "agent"|"task"|"approval"|"session", "data": {...} }`.

### 5.2.1 Task semantics (never silently overwrite work)
- `POST /agents/{id}/task` = **steer the current task.** If the agent has a working/stuck task, the instruction is sent as a follow-up into the same engine session (`--resume` / `codex exec resume`); the task row is unchanged (stuck → working). If the agent is idle/done, it starts a new task with that instruction.
- `POST /tasks` with `agent_id`, or `PATCH /tasks/{id}` assigning an agent = **new task.** If that agent is idle/done it starts now; if it is working/stuck the task is stored as `queued` and starts automatically when the current task reaches done.
- Invariant: at most **one** working-or-stuck task per agent; any number queued, run in `created_at` order.
- Replacing in-progress work only happens explicitly: pause/cancel the current task first (or a future "replace" action). Nothing ever overwrites a working task implicitly.
- PM wording: steering → "Told agent 3." New task for a busy agent → "Agent 3 is busy; queued it next."

### 5.3 PM tools (`shared/pm/tools.json`, JSON Schema; same list for voice and web)
- `get_status()` → GET /agents
- `show_grid()` / `focus_agent(n)` → voice-only renderer mode (web ignores)
- `send_task(n, instruction)` → POST /agents/{id}/task
- `pause_agent(n)` / `resume_agent(n)` / `stop_all()`
- `explain_agent(n)` → GET /agents/{id}/log, summarize in one sentence
- `create_task(title, instruction, agent?)` → POST /tasks
- `decide_approval(id, decision)` → POST /approvals/{id}
- `search_history(query)` → GET /search
Every tool call is logged to `actions` with the current `session_id`, exactly once:
- **Mutating tools** (`send_task`, `pause_agent`, `resume_agent`, `stop_all`, `create_task`, `decide_approval`) pass `session_id` to their harness route, and **the harness** writes the action row.
- **Read-only/display tools** (`get_status`, `explain_agent`, `show_grid`, `focus_agent`, `search_history`) are logged **by the caller** (supervisor or `/chat`) via `POST /sessions/{id}/actions`.
Agent Console test sessions use channel `facetime`; reset the dev DB (`scripts/seed-demo.sh`) before rehearsals so test calls don't appear in recaps.

### 5.4 PM session lifecycle (both channels)
1. Start: `POST /sessions` → `GET /context` → inject into system prompt as "What happened last time" + current state.
2. Each turn: log user + PM messages via `/sessions/{id}/messages`; tools log `actions`.
3. End (hangup / 10 min idle on web): PM writes a 2–3 sentence summary → `PATCH /sessions/{id}`; voice sessions also send the summary as an alert ("Call recap: …").

### 5.5 Frames
- Renderer lives **inside** the supervisor (no IPC for pixels). Polls `/agents` + `/agents/{id}/log` ~2 Hz; draws 1920×1080; publishes at 15 fps (repeat last frame).
- Modes: `grid` (≤3 tiles, ~28px min text, color badge per state) and `focus` (one agent, ~36px min text).
- Also serves the latest frame as JPEG at `http://localhost:8788/frame.jpg` for the dashboard Live page.

## 6. Dashboard (`dashboard/`, Vite + React, :5173)
Scaffold UI with Lovable, then wire to the harness. Four pages:
1. **Live** — mirror of `frame.jpg` (refresh ~2 Hz) + agent cards (name/color, state, task, last 5 lines) + Stop all.
2. **Conversations** — list of sessions (channel icon, title, summary, time) + search box (`/search`). Detail: transcript, action timeline, summary. **Continue** → chat panel on `/chat` with that `session_id`.
3. **Tasks** — board: queued / working / stuck / done; create task; assign via dropdown; pending approvals with Approve/Deny.
4. **Settings** — providers by role (STT, PM LLM, TTS, worker engines, alerts), masked keys, "Test" per provider, Chert line status.
Live data via `/events` SSE. No auth beyond binding to localhost for the hackathon.

## 7. Workers — headless agents

Both run in Docker as a **non-root user**, repo mounted at `/workspace`. Workers **commit locally only**; they have no push credentials. Pushes go through an approval (§8).

**Claude Code**
- Auth: `claude setup-token` once on the host → `CLAUDE_CODE_OAUTH_TOKEN` into the container (or `ANTHROPIC_API_KEY`).
- Run: `claude -p "<task>" --output-format stream-json --verbose --dangerously-skip-permissions --max-turns 30`
- Follow-ups: save session id to `agents.engine_session`; continue with `--resume <id>`.
- Gotcha: skip-permissions refuses to run as root. Non-root user + explicit `HOME`.

**Codex**
- Auth: host `codex login` (ChatGPT account) → mount `~/.codex/auth.json` read-write (password-level secret; never commit).
- Run: `codex exec --json --sandbox danger-full-access "<task>"` (container is the sandbox; `--full-auto` is deprecated).
- Follow-ups: `codex exec resume <thread_id> "<instruction>"`; thread id from the first JSON event.
- Needs a git repo in `/workspace` (or `--skip-git-repo-check`).

The harness converts both JSON streams into short `events.line` entries. **Never** run either agent with skip-permissions outside a container.

**`demo-repo/` setup**
- Its own git repo (`git init` inside it) and listed in the root `.gitignore`, so workers never discover the root AGENTS.md/CLAUDE.md even outside Docker.
- Only `demo-repo/` is mounted into containers (at `/workspace`).
- `demo-repo/AGENTS.md` (worker rules, keep it short):
  ```
  - Run tests: pytest -q
  - Commit locally after each passing change. Never push.
  - If blocked, end your reply with one line starting "BLOCKED:" followed by the question.
  ```

## 8. Safety (judges will ask)
- Each worker sees only its container + mounted repo. No host home dir, no docker socket.
- Secrets live in `harness/.env` / `supervisor/.env.local`; never placed in any model prompt, log line, or API response.
- Kill switch: `/stop-all` (voice: "stop everything").
- Approval gate: `git_push` (and any deploy) creates an `approvals` row → PM asks on the call / dashboard shows Approve-Deny → harness performs the push only if approved.

## 9. Stuck detection (harness)
Mark `stuck` with `stuck_reason` when: final message contains a line starting `BLOCKED:` (primary signal; `stuck_reason` = text after it) · no new events 90 s while working · same test fails 3 runs in a row · run ended with error / max turns. On stuck: SSE event + alert (ntfy now; Chert outbound later), debounced 1 per agent per 2 min.

## 10. Models & config
`supervisor/.env.local` (never commit):
```
LIVEKIT_URL=  LIVEKIT_API_KEY=  LIVEKIT_API_SECRET=
AGENT_NAME=eris
STT_PROVIDER=deepgram           # deepgram | elevenlabs | openai-compatible
TTS_PROVIDER=deepgram           # deepgram (dev default) | elevenlabs (demo) | openai-compatible
DEEPGRAM_API_KEY=               # $200 free credit; default STT
ELEVENLABS_API_KEY=             # shared credit pool for STT+TTS; use Flash TTS model
ELEVENLABS_VOICE_ID=
OPENAI_API_KEY=                 # gpt-5-mini on Build tier
LLM_BASE_URL=                   # empty = OpenAI; http://localhost:11434/v1 = Ollama (gpt-oss:20b)
LLM_MODEL=gpt-5-mini
HARNESS_URL=http://localhost:8787
```
`harness/.env`: `OPENAI_API_KEY=`, `LLM_BASE_URL=`, `LLM_MODEL=`, `CLAUDE_CODE_OAUTH_TOKEN=`, `NTFY_TOPIC=`, `WORKER_COUNT=3`.
- Keep the Chert starter's `@livekit/agents` version; add deepgram/elevenlabs/openai/silero plugins at the **same** version.
- STT/TTS/LLM come from provider registries in `supervisor/src/config.mjs` (`STT_PROVIDER` / `TTS_PROVIDER` / `LLM_PROVIDER`; entries: deepgram, elevenlabs, openai-compatible; LLM: openai, openai-compatible). Unknown provider or missing key fails at startup naming the role and the supported list; secrets are never printed.
- **Code defaults:** deepgram / deepgram / openai (works with one Deepgram key; saves ElevenLabs credits in dev). **Rehearsal/demo `.env.local`:** `TTS_PROVIDER=elevenlabs` (better voice; two providers so one outage or empty credit pool doesn't kill both directions). Fall back to `deepgram` if ElevenLabs credits run out.
- Turn detection is VAD-based (Silero); the default turn detector needs LiveKit's inference executor, which Chert rooms don't provide.
- PM style: 1–2 short sentences, agents are "Agent 1/2/3", never read logs verbatim.

## 11. Chert specifics (do not fight these)
Authoritative, version-matched rules live in `supervisor/AGENTS.md` (generated by Chert between `<!-- chert:begin -->` / `<!-- chert:end -->`; refresh with `cd supervisor && chert context --write`; never hand-edit inside the markers). Summary of what affects our design:
- CLI: use the version Chert's block names (currently `0.1.0-beta.20`); Node 24 (not 26).
- Run order: `npm start` (supervisor) → `chert doctor --json` → `chert dev --json` in the background; wait for `agent_warm`.
- **Greet within 10 s of `bridge_ready` or the call ends** (`remote_audio_timeout`). Greet exactly once when room metadata has `chert_bridge_ready: true` (the starter's `greet.mjs` does this) — never on participant join. The greeting is our "Last call you…" recap.
- Exactly ONE participant publishes audio, and video only counts from that same participant: the supervisor publishes both its voice and the grid as a **camera** track. A second audio publisher ends the call.
- Caller joins as `chert-bridge-<call id>`. Demo phone must place a **FaceTime Video** call.
- Agent can't see/share the caller's screen; "show it the bug" = phone camera.
- After any supervisor code change, restart BOTH terminals (waiting room may hold old code). Stop `chert dev` with SIGINT/SIGTERM and wait for `dev_stopped` — never SIGKILL.
- Never pass `--takeover`, `--force`, `--no-prewarm` unless explicitly asked.
- **Trial budget:** 50 FaceTime minutes total, **5 minutes per call**, valid **24 h from activation**; unlimited inbound iMessage (≤50/hour). Don't activate the trial until the supervisor works in Agent Console. Keep the demo call under 5 minutes. Keep `chert dev` running once a line is assigned (an unconnected trial line returns to the pool).
- Shared plan with Chert rooms: leave the three `LIVEKIT_*` values empty and `chert dev` provides a token; otherwise use our LiveKit project.
- Develop in LiveKit **Agent Console**; spend line minutes on rehearsal only.

## 12. Milestones
- **M0** SQLite schema + `/agents` (mock workers) + `/sessions` + `/context` + `shared/pm/` files.
- **M1** Supervisor answers "status?" in Agent Console from M0, logging turns + read-only actions to a session (adds `POST /sessions/{id}/actions`). Hangup sets `ended_at` only; greeting recap from current state.
- **M2** Renderer grid + focus by voice; `frame.jpg` served.
- **M3** One real Claude Code worker driven by `send_task`; events → lines.
- **M4** 3 workers (Claude Code + Codex); stuck detection + ntfy; **session summary on hangup (PATCH summary)**; greeting recap includes last call from `recent_summaries`.
- **M5** Dashboard: Live + Conversations (search + continue via `/chat`).
- **M6** Tasks board + approvals (voice + web) + Settings with provider tests.
- **M7** Caller-frame "look at this"; on a Chert line: full demo script end to end; mock mode + recorded backup; Devpost ("Best Use of FaceTime (Chert)").
- Stretch: Chert outbound call on stuck; worker-to-worker handoff (agent 2 reviews agent 1); iMessage alerts with screenshots.

## 13. Open items
- Outbound FaceTime from our line needs a project API key with `facetime:write`; docs conflict on audio-only vs video. Fallback: alert → user calls in.
- Line assignment ETA from Chert.
- ≥1 iPhone on the team; demo phone number verified on the Chert project.