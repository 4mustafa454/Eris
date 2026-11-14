# Project context and history

## Goal
Connect the user's own AI agent to Chert (YC P26 FaceTime/iMessage agent API) so they can FaceTime it, then improve it for a hackathon. The user later asked for a more conversational agent that doesn't get cut off, and for the project to be moved into a GitHub repo / Claude Code.

## Accounts and resources (no secrets)
- Chert project: "Test" (ID `578c0e05-cb6d-45b3-9fd9-155c83138745`); line "Wei Zhang" `+13175070563` (shared line, up to 6 customers, 1 concurrent call).
- LiveKit Cloud project: user's own (URL/key/secret in `.env.local`). Chert-managed LiveKit was not provisioned (`livekit_not_provisioned`), so the user's own LiveKit is used.
- OpenAI Realtime: user's API key in `.env.local`; needs credits.
- Calls from the user's phone required joining the shared line first by texting the join code to the line over iMessage.
- Dashboard: https://app.trychert.com (Overview shows line status, live calls, plan). Docs: https://docs.trychert.com. Setup skill: https://app.trychert.com/skills.md.

## Setup timeline (what was done)
1. `chert login` (device approval) and onboarding/demo call completed; project "Test" verified.
2. Starter agent scaffolded in `~/chert-agent/my-agent` (Node, LiveKit Agents 1.8.0, OpenAI plugin).
3. LiveKit: first key/secret pair was rejected (likely truncated copy); re-created key and used copy buttons.
4. `.env.local` filled with LiveKit URL/key/secret, `OPENAI_API_KEY`, `AGENT_NAME=my_agent`.
5. Node 26 broke the LiveKit native binding. Installed Node 24 (`brew install node@24`, keg-only), removed `node_modules` + `package-lock.json`, reinstalled.
6. Agent name mismatch (`my-agent` vs `my_agent`) fixed; `chert doctor --agent my_agent` passes.
7. Calls initially failed for three separate reasons: caller not joined to the shared line; Chert Mac offline (`line_offline`, Chert-side); OpenAI `credit_balance_exhausted` (fixed by adding $5).
8. Successful call: 16:38–16:42 CT on 2026-11-14, ~4 minutes, agent responded to ~20 turns. It ended by the caller side (hang-up or 5-min trial cap).
9. Rewrote the agent as "Nova" with `semantic_vad` (eagerness low) for fewer cutoffs.
10. `git init` on `main`, one commit; `.gitignore` keeps `.env.*` (except `.env.example`), `node_modules`, logs and `agent.mjs.bak` out.

## Key decisions
- Own LiveKit project rather than Chert-managed.
- Audio calls only (no video track published).
- Turn detection: OpenAI `semantic_vad`, `eagerness: 'low'`, `interrupt_response: true`, so the agent waits for the caller to finish but can still be interrupted.
- The "turnDetection is a TurnDetector, but the LLM is a RealtimeModel..." warning in the agent log is harmless (LiveKit ignores its own detector in favor of the server-side one).

## Open items / next steps
- **GitHub repo**: done. Private repo `4mustafa454/my-agent`, branch `main`, remote `origin`.
- Live-test the Nova rewrite with a FaceTime Audio call; tune `instructions`, `eagerness`, or `silence_duration_ms` if it still cuts off.
- Customize the persona for the actual hackathon idea (edit `instructions` and `greeting` in `agent.mjs`).
- Optional: publish a video track (`chert new my-agent --video` pattern) if the agent should appear on camera.
- Optional: ask hackathon organizers about shared-line time slots (`chert dev --until HH:MM`).
- Possible hardening: pin Node 24 with an `.nvmrc`; keep a `.env.local` backup in a password manager (never in git).
