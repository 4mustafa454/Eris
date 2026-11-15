# Eris supervisor

The PM voice agent: speech in, the shared PM brain, speech out. It talks to the harness over HTTP and
logs every call. Contract: `/AGENTS.md`. Chert rules for this folder: `AGENTS.md` here.

What it does: STT → LLM → TTS pipeline, the shared prompt and tools from `shared/pm/` (all eleven PM tools), a template greeting
on `bridge_ready` (or, on an alert call the harness placed, one that leads with the reason), every turn and action logged to a
session, a summary written on hangup, and the team video. Mutating tools ("tell agent 1 to use the v2 endpoint", pause, resume,
create a task, approve, "stop everything") call the harness, which logs the action itself.

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
6. Video: the Agent Console should show the team grid (3 tiles stacked vertically, a portrait picture) as the agent's camera.
   On an iPhone FaceTime call, nothing should sit under the controls at the bottom or the status bar at the top, or be cropped at the sides, and the
   self-view (bottom right by default) should not cover any text. If it does, adjust `VIDEO_SAFE_TOP` / `VIDEO_SAFE_BOTTOM` / `VIDEO_SAFE_SIDE`. Say "show me agent 2": the picture
   switches to Agent 2 full screen and the PM answers in one short sentence. "Show me the grid" goes back. "Show me agent 9":
   "There's no agent 9." and the picture does not change. A new call starts on the grid again.
   "Tell agent 1 to use the v2 endpoint" sends the instruction (the session's action list gets a `send_task` row written
   by the harness); with mock workers the agent just carries on, with a real worker (see `harness/README.md`) it resumes
   its session. "Stop everything" pauses every working agent.
7. Hang up, then check what was saved:
   ```sh
   curl -s 'localhost:8787/sessions?limit=1'            # newest session, ended_at set
   curl -s localhost:8787/sessions/<id>                 # transcript in order, actions listed
   ```
   The transcript starts with the greeting, then both sides of the conversation. The actions are the tool calls the PM made
   (for example `get_status` and `explain_agent`).
8. Remove `GREET_ON_JOIN` and restart: no greeting in Agent Console (the silent default).
9. Stop the harness mid-call: the call keeps going, the video shows the red "HARNESS UNREACHABLE" frame, and the PM says
   it can't reach the team. Start it again: the grid comes back by itself.
10. Every 15 s the log prints `[eris] video 15.0 fps at 1920x1080, process cpu NN% of one core, ...`. That is the real
    CPU cost of voice plus video including the encoder. If it is high (say over 80%) or the picture stutters, set
    `VIDEO_RESOLUTION=720p` and/or `VIDEO_FPS=10` in `.env.local` and restart.

## Team view renderer

`render/` draws the team from `GET /agents` and `GET /agents/{id}/log` (polled at 2 Hz): a grid of up to 6 agents (the demo has three), or one
agent full-frame. The default is **portrait**, 1080×1920 (720×1280 with `VIDEO_RESOLUTION=720p`), because a phone shows
the agent in a portrait tile and crops a landscape picture to its middle. In portrait the grid stacks the tiles
vertically at full width. `VIDEO_ORIENTATION=landscape` gives 1920×1080 / 1280×720 with the tiles side by side.

Portrait keeps everything out of a **safe area**: the top 120 px, bottom 260 px and each side 110 px (at 1080×1920; the
720p fallback scales them) stay empty. FaceTime draws its own controls over the top and bottom, and a tall phone screen
(about 9:19.5) crops the sides of a 1080-wide picture. Change them with `VIDEO_SAFE_TOP`, `VIDEO_SAFE_BOTTOM` (0 to 600
each, at most 900 together) and `VIDEO_SAFE_SIDE` (0 to 250). The stripes, badges, text and tile panels all stay inside.
The three tiles share the safe height, so each shows 4 log lines instead of 5; text sizes do not change. A grid task title
wraps onto a second line at the same size (ellipsis on the second if it is still too long), and a tile whose title takes two
lines shows 3 log lines instead of 4. This is portrait only: landscape titles stay on one line. Text also stays out of a 300×360 box in each right-hand corner of the safe area
(FaceTime's default side for the caller's self-view): rows that reach a corner are wrapped or cut earlier. Only the
right-hand corners are protected; if the self-view is dragged to a left corner it can cover the start of a line.
Landscape has no safe area. It redraws only when what is
drawn changes, and warns if a redraw takes over 30 ms. The renderer needs no keys.

On a call, `src/video.mjs` publishes it as the agent's camera track (same participant as the voice, 15 fps by default,
set `VIDEO_FPS`) before the PM starts and before the greeting. It is bounded to a few seconds: if publishing fails the
call carries on audio only and the log says why. `show_grid` and `focus_agent` switch the picture (logged to the session
like any other tool call). The same view is also at `http://localhost:8788/frame.jpg` while a call, or `npm run frames`,
is running.

```sh
npm run render:samples            # PNGs for every fixture and mode, both orientations → render/out/samples/{portrait,landscape}/ (gitignored);
                                  # portrait-guides/ has the portrait frames with the safe-area bands (red, all four edges) and corner zones (magenta) drawn on
npm run render:samples -- --live  # the same from the running harness (HARNESS_URL, default :8787)
npm run frames                    # serve http://localhost:8788/frame.jpg from the harness; "g" / "f 2" switch mode
npm run bench:video               # CPU of render + frame hand-off at 1080p/720p and 15/10 fps (no encoder; see its header)
```

With `npm run frames` running, stop the harness to see the "harness unreachable" frame, and start it again to see
recovery. Test PNGs from `npm test` land in `render/out/test/`. On this machine the render and hand-off cost about 10-14% of
one core at 15 fps with the picture changing twice a second; the encoder's share is only visible in a real call. The font (DejaVu Sans, free license) is bundled in
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
