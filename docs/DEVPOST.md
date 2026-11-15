# Eris: Devpost write-up

Track: Best Use of FaceTime (Chert). Pitch: *Mission control for your team of coding agents — watch them work and talk to them face
to face over FaceTime.*

## Inspiration

Coding agents are good at working alone and bad at telling you what they are doing. You find out they were stuck an hour ago, or
that one wanted to push and nobody answered. Other agent products let one agent call you or text you. We wanted the opposite
direction: you call the *team*, see all of it at once, and talk to it the way you would talk to a lead standing next to the
screens. FaceTime video makes that possible, because the agent's outgoing video can be the live view of the team.

## What it does

Eris runs three headless coding agents (two Claude Code, one Codex) in Docker and puts a PM agent in front of them.

- **Call in on FaceTime Video.** The PM greets you within seconds with a recap of the last call and what needs attention. The picture on
  your phone is a live grid of the three agents, each with a state badge, current task and recent activity. "Show me agent 2"
  switches to a full-screen view.
- **Give instructions by voice.** "Tell agent 1 to use the v2 endpoint" steers the worker's current task in the same session.
  You can also pause or resume an agent, create tasks, search past conversations, and say "stop everything" to halt all workers.
- **Stuck alerts.** The harness marks an agent stuck when it reports `BLOCKED:`, goes 90 seconds without activity, fails the same
  test three runs in a row, or ends with an error or out of turns. It then alerts you, at most once per agent per two minutes, on
  ntfy, by iMessage with a picture of the grid, and (optionally) by calling you on FaceTime. The call opens with the reason.
- **Approvals.** Workers cannot push. A worker that wants to ends its reply with `APPROVAL: git_push` and stops; the PM asks you
  and only a clear yes or no decides it. Approving continues the same session; denying steers it to another approach.
- **Everything is saved.** Each call and chat has a transcript, a timeline of actions and a short summary. The PM loads the recent
  summaries at the start of every session, and the dashboard can resume any conversation in a chat that uses the same PM.
- **Dashboard.** Live view (the same picture the phone sees, plus agent cards and a stop-all button), Conversations with search,
  a Tasks board with approvals, and Settings with masked keys and provider tests.

## How we built it

- **`supervisor/`** (Node 24, LiveKit Agents JS): the PM on calls. Deepgram for speech to text, an OpenAI-compatible model for the PM,
  and Deepgram or ElevenLabs for text to speech, chosen through provider registries so a missing key or unknown provider fails at
  startup with a message that names it. A canvas renderer draws the grid and focus views and publishes them as the agent's camera
  track, and also serves the latest frame as a JPEG for the dashboard.
- **`harness/`** (Python, FastAPI, SQLite with WAL and FTS5): the API, the worker manager, stuck detection, approvals, alerts and the web
  chat. Worker output from both engines (Claude Code and Codex JSON streams) is turned into short human-readable lines.
- **One PM brain.** The voice agent and the web chat load the same `shared/pm/system_prompt.md` and `tools.json`, call the same
  harness routes, and write to the same tables. The same eleven tools work in both channels.
- **Workers** run as non-root users in Docker with only the demo repo mounted. They commit locally and hold no push credentials.
- **Chert.** Inbound FaceTime through `chert dev`; outbound alert calls through the Calls API, where the harness creates the LiveKit
  room, dispatches the supervisor into it and mints the bridge token; iMessage alerts through the Messaging API with the current frame
  attached.
- **`dashboard/`** (Vite and React) talks only to the harness, over HTTP and server-sent events.

## Challenges

- **One agent participant per room.** We could not give each worker its own video stream, so worker screens are drawn into the
  supervisor's single camera track.
- **Ten seconds to speak.** Chert ends a call that is silent for ten seconds after the line is ready, so the greeting is a template
  over stored state with no model call, spoken once on Chert's `bridge_ready` signal and never on join.
- **A phone is not a monitor.** FaceTime crops a landscape picture and draws its own controls and self-view, so the default picture is
  portrait with a safe area, and long titles and log lines wrap inside the tiles.
- **Never silently overwrite work.** Steering a busy agent and giving it a new task are different operations: steering continues the
  same engine session, and a new task for a busy agent is queued. There is at most one working or stuck task per agent.
- **Codex credentials in a container.** The Codex worker gets the host's login file as a read-only mount, so its token can only be
  refreshed on the host; the runbook has a pre-demo check for that.
- **A harness restart should not lose the call.** The call keeps going, the picture shows a clear "harness unreachable" frame, and
  workers that were running come back as stuck so they can be told to continue.

## Accomplishments that we're proud of

- The core idea works as designed: the PM's outgoing video is the team, and you steer the team by talking to it.
- One shared PM definition behind voice and web, so a conversation can start on a call and continue in the dashboard.
- A safety model we can explain: sandboxed workers with no push credentials, an approval gate for pushes, and a kill switch.
- Tests across the stack: 335 harness tests and 266 supervisor tests pass, all with network access mocked, and the dashboard
  type-checks clean.

## What we learned

- Voice agents need their first words ready before anything slow happens; templates beat model calls for greetings.
- Designing for the real screen (a cropped, overlaid phone video) changes the layout more than any amount of polish on a desktop view.
- Making the agent's contract explicit (`BLOCKED:` and `APPROVAL:` lines, a frozen HTTP API and schema) made three kinds of agent
  (two worker engines and the PM) easy to build in parallel.

## What's next

- Run the outbound-call and iMessage alert paths against a live Chert line. They are implemented and tested with the HTTP calls
  mocked, but the call-event names we watch for come from incomplete docs and are unverified.
- Let a worker hand work to another (for example, agent 2 reviews agent 1's change).
- Caller-camera "look at this": show the PM a bug through the phone camera.
- More engines and more than three workers; the grid already lays out up to six.
- Dashboard authentication beyond binding to localhost.

## Built with

FaceTime, Chert (CLI, Calls API, Messaging API), LiveKit Agents, LiveKit, Deepgram, ElevenLabs, OpenAI, Claude Code, Codex, Docker,
Python, FastAPI, SQLite (WAL, FTS5), Node.js, `@napi-rs/canvas`, Silero VAD, React, Vite, TypeScript, ntfy.
