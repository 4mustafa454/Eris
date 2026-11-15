# Eris

**FaceTime your team of AI coding agents: watch them work live, steer them by voice, and get a call when one gets stuck.**

Built for HackUTA 2026 (Chert track).

> **About the demo: test scenario, real system.** Eris is a working proof of concept, and the agents in it are real: set `REAL_WORKERS=agent-1,agent-3` and
> Claude Code and Codex run in sandboxed Docker containers against a real repo. Their `BLOCKED:` and `APPROVAL:` signals drive the
> same stuck and approval states you see on the call, and we exercised that path end to end during development (real Claude Code
> and Codex tasks, stuck detection, voice steering and call recaps). Real agents take minutes to reach a given state, so for a timed recording we drove the grid
> with mock agents (`MOCK_TICK=1`) and a seeded approval (`scripts/seed-demo.sh --with-approval=agent-2`) to bring each state up on
> cue. Everything else in the video is live: the voice call, the PM's reasoning and tool calls, the rendered video frame, the dashboard
> and the alerts.
>
> **What the mock agents do on their own.** Every few seconds the mock ticker picks an agent and moves it: it logs a work line,
> finishes its task, starts a queued one, or hits a random blocker (which fires the real stuck alert). A stuck mock agent also
> recovers by itself on a later tick ("resumed after guidance"), whether or not anyone answered it. So in the video, some state
> changes (an agent going stuck, flipping back to working, or picking up a new task) come from the simulator rather than from
> what was said on the call. Real workers don't do this: they stay stuck until you answer them.

Eris runs three headless coding agents in Docker and puts a **PM agent** in front of them. You reach the PM by FaceTime
video, text, or the web dashboard. On a FaceTime call, the PM's outgoing video is a live view of your whole team.

## What it does

- **Call in on FaceTime Video.** The PM greets you with a recap of the last call and what needs attention, then you see a live
  grid of your worker agents (1–6 tiles: state, task, latest activity). "Show me agent 2" switches to a full-screen view of that agent.
- **Talk to the team.** Ask for status, tell an agent what to do ("tell agent 1 to use the v2 endpoint"), pause or resume an agent,
  create tasks, search past conversations, and stop everything with one phrase.
- **Get alerted when a worker is stuck.** The harness pushes an alert to your phone (ntfy, working today), and is built to
  escalate over Chert: an iMessage with a picture of the grid, then a FaceTime call that opens with the reason (see Status).
- **Approve risky actions by voice.** A worker that wants to `git push` (or delete files, or install dependencies) stops and asks;
  you approve or deny by voice or on the dashboard, and the agent continues or changes course. In the demo setup the workers'
  repos have no remote, so an approval releases the agent rather than performing a real push.
- **Continue anywhere.** Every call and chat is saved with transcript, actions and a summary. The PM remembers recent calls, and the
  dashboard can resume any conversation in a chat panel that uses the same PM brain.
- **Dashboard** (Live, Conversations, Tasks with approvals, Settings with provider tests), served on `localhost:5173`.

## Status

| | Feature | Notes |
|---|---|---|
| ✅ | FaceTime call in, live agent grid as video, voice Q&A | Verified in LiveKit Agent Console; connects to a Chert FaceTime line via `chert dev` |
| ✅ | Voice steering, pause/resume, stop all, task queueing | Real Claude Code and Codex workers in Docker |
| ✅ | Stuck detection (`BLOCKED:`, stalls, repeated failures) + ntfy alerts | Verified with real workers |
| ✅ | Approvals by voice and on the dashboard, with banner on the video | Real workers signal `APPROVAL:`; demo uses a seeded approval |
| ✅ | Call summaries and "since we last talked" recap on the next call | Verified across calls |
| ✅ | Dashboard: Live, Conversations (search, continue), Tasks, Approvals, Settings | Vite + React, live over SSE |
| 🧪 | Alerts over Chert: iMessage with a grid screenshot, outbound FaceTime call | Built and unit-tested; not yet run against a live line |
| 🔜 | Focus mode with an agent's real screen, agent-to-agent handoff, hosted setup | Planned |

## Architecture

```mermaid
flowchart LR
    phone["iPhone<br/>FaceTime Video / iMessage"] <--> chert["Chert line<br/>(chert dev, Calls API, Messaging API)"]
    chert <--> lk["LiveKit room<br/>(one agent participant)"]
    lk <--> sup["supervisor/<br/>STT, PM LLM, TTS,<br/>grid renderer → camera track"]
    sup -- "PM tools (HTTP)" --> har["harness/<br/>FastAPI + SQLite"]
    har <--> w1["Docker worker<br/>agent-1 · Claude Code"]
    har <--> w2["Docker worker<br/>agent-2 · Claude Code"]
    har <--> w3["Docker worker<br/>agent-3 · Codex"]
    dash["dashboard/<br/>Vite + React"] -- "HTTP / SSE" --> har
    dash -. "frame.jpg" .-> sup
    har -- "alerts: ntfy, iMessage, outbound call" --> chert
    pm["shared/pm/<br/>system prompt + tools"] -.-> sup
    pm -.-> har
```

- **One PM brain.** Voice (supervisor) and web chat (`/chat` in the harness) load the same `shared/pm/system_prompt.md` and
  `shared/pm/tools.json`, call the same harness routes, and log to the same tables.
- **One video track.** Chert allows one agent participant per room, so worker screens are drawn into the supervisor's single camera
  track (and mirrored at `:8788/frame.jpg` for the dashboard).
- **Workers are sandboxed.** Each runs in its own Docker container as a non-root user with only the demo repo mounted. Workers commit
  locally and have no push credentials; a push goes through an approval.
- The contract between the parts (schema, HTTP API, PM tools) is in [AGENTS.md](AGENTS.md).

## How Chert is used

| Piece | What Eris does with it |
|---|---|
| **Inbound FaceTime** | `chert dev` connects the supervisor to a Chert line. A FaceTime Video call arrives as a LiveKit room; the supervisor greets once when Chert reports `bridge_ready` and publishes both its voice and the team grid as one camera track. |
| **Outbound calls** | When a worker is stuck and alerts are set to call, the harness creates a LiveKit room, dispatches the supervisor into it, and places the call through Chert's Calls API (`customer_managed` mode). The greeting leads with the reason. |
| **iMessage alerts** | The harness sends the alert text through Chert's Messaging API, with the current frame from `:8788/frame.jpg` attached when available. |

The outbound call and iMessage paths are covered by tests with the HTTP calls mocked. They have not been exercised against a live
Chert line in this repo's tests; `docs/DEMO.md` has the one-command checks to run before relying on them.

## Quickstart

Needs Docker, Python 3.11+, Node 24 (not 26), the `chert` CLI, and API keys: Deepgram (speech), OpenAI (the PM), a LiveKit project, and
a Claude Code token for real workers. The full rehearsal runbook is [docs/DEMO.md](docs/DEMO.md).

```sh
# 1. Configure (never commit these; every variable is listed, values blank)
cp harness/.env.example harness/.env
cp supervisor/.env.example supervisor/.env.local

# 2. Worker images and the demo repo the agents work on
scripts/build-worker.sh && scripts/build-codex-worker.sh && scripts/make-demo-repo.sh

# 3. Start things, each in its own terminal
cd harness && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/uvicorn app.main:app --port 8787
cd supervisor && npm install && npm start          # the PM; serves :8788/frame.jpg during a call
cd supervisor && chert login && chert dev --json    # puts the supervisor on your FaceTime line; wait for agent_warm
cd dashboard && npm install && npm run dev          # http://localhost:5173
```

With no `REAL_WORKERS` set, the three agents are mocks, so you can try the PM, the grid and the dashboard without Docker or worker keys.
Try the voice side without a phone in LiveKit's Agent Console (set `GREET_ON_JOIN=1` in `supervisor/.env.local`; do not run `chert dev`).
Real FaceTime calls need a Chert line, and the free trial is capped at 5 minutes per call.

## Tests

| Part | Command | Result when this was written |
|---|---|---|
| Harness | `cd harness && .venv/bin/pytest -q` | 335 passed |
| Supervisor | `cd supervisor && npm test` | 266 passed |
| Dashboard | `cd dashboard && npm run typecheck` | type-checks clean (no unit tests) |

The tests mock all network access: no model, Chert, LiveKit or Docker call is made. Real-worker runs and live calls are checked by hand
using [docs/DEMO.md](docs/DEMO.md).

## Repo layout

| Path | What it is |
|---|---|
| `shared/pm/` | PM system prompt and tool schemas, used by voice and web |
| `supervisor/` | the PM on calls: LiveKit/Chert voice agent and the grid/focus renderer |
| `harness/` | FastAPI API, SQLite, worker control, stuck detection, alerts, web chat |
| `workers/` | Dockerfiles for the Claude Code and Codex workers |
| `dashboard/` | web UI (talks only to the harness) |
| `demo-template/` | source for the demo repo the workers edit (`scripts/make-demo-repo.sh` builds `demo-repo/`) |
| `docs/` | demo runbook and Devpost write-up |

## License

[MIT](LICENSE)
