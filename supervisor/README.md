# Eris supervisor

The PM voice agent: speech in, the shared PM brain, speech out. It talks to the harness over HTTP and
logs every call. Contract: `/AGENTS.md`. Chert rules for this folder: `AGENTS.md` here.

M1 scope: STT → LLM → TTS pipeline, the shared prompt and tools from `shared/pm/`, `get_status` and
`explain_agent` working, a template greeting on `bridge_ready`, and every turn and read-only action logged to a
session. Not yet: publishing the video grid into calls (M2 part B; the renderer itself is built, see below), sending work to agents (M3), hangup summaries (M4). The other tools
answer "not available yet".

## Setup

```sh
cd supervisor
npm install
cp .env.example .env.local     # then fill it in; never commit .env.local
```

With the defaults (Deepgram for speech, OpenAI for the LLM) you need `DEEPGRAM_API_KEY` and `OPENAI_API_KEY`.
For Agent Console also fill the three `LIVEKIT_*` values (your own LiveKit project) and set `AGENT_NAME=eris`.
Every variable is listed, with its default, in `.env.example`.

The harness needs its own venv once: see `harness/README.md`.

## Run

```sh
# terminal 1: the harness (restart it after pulling harness changes; it does not auto-reload)
cd harness && .venv/bin/uvicorn app.main:app --port 8787

# terminal 2: the supervisor
cd supervisor && npm start
```

Startup prints one line with the chosen providers (names only, never keys). A bad provider name or a missing key
stops startup with one message naming the role and the variable.

## Try it in Agent Console

Agent Console never sends Chert's `bridge_ready`, so for development set `GREET_ON_JOIN=1` in `.env.local`.
It is off by default and ignored for real FaceTime callers (`chert-bridge-*`). Do not set it when running `chert dev`.

Reset the mock data first so old test calls do not clutter the picture: stop the harness, delete
`harness/data/eris.db`, start it again (it reseeds three mock agents). Add `MOCK_TICK=1` to make the agents move.

1. Start the harness, then `npm start`. Open Agent Console and dispatch to the agent named `eris`.
2. You should hear the greeting within about two seconds: "Hi, it's Eris." plus the team's current state.
3. Say "Status?" The PM calls `get_status` and answers in one or two sentences.
4. Say "What is agent 2 doing?" It calls `explain_agent` and answers in one sentence.
5. Say "What is agent 7 doing?" It says Agent 7 doesn't exist.
6. Say "Tell agent 1 to use the v2 endpoint" or "show me agent 2". Both get "not available yet".
7. Hang up, then check what was saved:
   ```sh
   curl -s 'localhost:8787/sessions?limit=1'            # newest session, ended_at set
   curl -s localhost:8787/sessions/<id>                 # transcript in order, actions listed
   ```
   The transcript starts with the greeting, then both sides of the conversation. The actions are the
   `get_status` and `explain_agent` calls (plus the stubs that were tried).
8. Remove `GREET_ON_JOIN` and restart: no greeting in Agent Console (the silent default).
9. Stop the harness mid-call: the call keeps going and the PM says it can't reach the team.

## Team view renderer (M2)

`render/` draws the team as 1920×1080 frames from `GET /agents` and `GET /agents/{id}/log` (polled at 2 Hz): a grid of up
to 3 agents, or one agent full-frame. It redraws only when what is drawn changes, and warns if a redraw takes over 30 ms.
It needs no keys. It is not yet attached to calls: publishing it as the camera track and the `show_grid` /
`focus_agent` tools are M2 part B.

```sh
npm run render:samples            # PNGs for every fixture and mode → render/out/samples/ (gitignored)
npm run render:samples -- --live  # the same from the running harness (HARNESS_URL, default :8787)
npm run frames                    # serve http://localhost:8788/frame.jpg from the harness; "g" / "f 2" switch mode
```

With `npm run frames` running, stop the harness to see the "harness unreachable" frame, and start it again to see
recovery. Test PNGs from `npm test` land in `render/out/test/`. The font (DejaVu Sans, free license) is bundled in
`render/fonts/`. Only one process can hold port 8788 (`FRAME_PORT` to change it); a second logs a warning and runs
without the mirror.

## Switching providers

Set the variable, restart `npm start`. No code changes.

| Role | Variable | Values (default first) | Also needs |
|---|---|---|---|
| STT | `STT_PROVIDER` | `deepgram`, `elevenlabs`, `openai-compatible` | `DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY` / `STT_BASE_URL` + `STT_MODEL` |
| TTS | `TTS_PROVIDER` | `deepgram`, `elevenlabs`, `openai-compatible` | `DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY` (+ optional `ELEVENLABS_VOICE_ID`) / `TTS_BASE_URL` + `TTS_MODEL` + `TTS_VOICE` |
| LLM | `LLM_PROVIDER` | `openai`, `openai-compatible` | `OPENAI_API_KEY` (not needed if `LLM_BASE_URL` is set) / `LLM_BASE_URL` + `LLM_MODEL` |

Local Ollama: `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL=gpt-oss:20b`, no OpenAI key.
`openai-compatible` speech uses the LiveKit OpenAI plugin against your URL; its TTS is not streaming, so expect more
latency than Deepgram or ElevenLabs.

## Interruption tuning

If the PM stops mid-sentence and resumes, that is a false interruption (echo, background noise). Defaults are already
stricter than LiveKit's: the caller must speak for 600 ms and the speech-to-text must hear at least 1 word before the PM
stops, a false stop resumes by itself, and the VAD threshold is 0.6. Tune in `.env.local` (see `.env.example`):
`INTERRUPT_MIN_DURATION_MS`, `INTERRUPT_MIN_WORDS`, `INTERRUPT_RESUME_FALSE`, `VAD_ACTIVATION_THRESHOLD`. Startup prints the
values in use. Wearing headphones removes echo at the source and helps more than any setting.

## With a real Chert line

Leave `GREET_ON_JOIN` unset. The greeting is spoken once when `chert dev` sets `chert_bridge_ready`, from a template
over fresh agent state (no LLM call, so it is ready well inside Chert's 10 seconds). Run order and the rules for
this folder are in `AGENTS.md` here; project-wide rules are in `/AGENTS.md`.

## Checks

```sh
npm run check     # syntax check of every .mjs file
npm test          # unit tests; the harness tests start a real harness on a throwaway database
```

Layout: `render/` (see above), `agent.mjs` (entry, fails fast on config), `src/call.mjs` (one call), `src/config.mjs` (provider registries),
`src/tools.mjs`, `src/greeting.mjs`, `src/harness.mjs`, `src/pm-prompt.mjs` (port of `harness/app/pm.py`, tested for
identical output).
