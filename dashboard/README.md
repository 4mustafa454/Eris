# Eris dashboard

Web UI for the Eris harness. Vite + React 19 + Tailwind v4, Graphite theme, on **http://localhost:5173**.
It talks only to the harness (`/AGENTS.md` §5.2, §6); it never reads `.env` files.

## Run

```sh
# Terminal 1: harness with mock agents that change state
cd harness && MOCK_TICK=1 .venv/bin/uvicorn app.main:app --port 8787

# Terminal 2: dashboard
cd dashboard && npm install && npm run dev      # http://localhost:5173
```

The harness only allows browser origins `localhost` / `127.0.0.1` on ports 5173 and 5190 (set `ERIS_CORS_ORIGINS` to change).
Port 5173 is fixed (`strictPort`), so a busy port fails loudly instead of silently moving.

Optional env: `VITE_HARNESS_URL` (default `http://localhost:8787`), `VITE_FRAME_URL` (default `http://localhost:8788/frame.jpg`).
Checks: `npm run typecheck`, `npm run build`.

## Pages

| Page | Uses | Status against the current harness |
|---|---|---|
| Live | `/events` (SSE), `/agents/{id}/log`, `POST /stop-all`, supervisor `:8788/frame.jpg` | Works. The frame shows once the supervisor renderer runs. |
| Approvals | `/events`, `GET /approvals`, `POST /approvals/{id}` | Works (seed one with `scripts/seed-approval.sh`). |
| Conversations | `/sessions`, `/sessions/{id}`, `GET /search`, `POST /chat` | Works. Continue needs a configured PM provider (the harness answers "PM provider is not configured" otherwise). |
| Tasks | `/tasks`, `POST /agents/{id}/task`, `POST /tasks`, `PATCH /tasks/{id}`, pause/resume | Works. |
| Settings | `GET/PUT /settings`, `POST /settings/test/{provider}` | Works. |

A "Backend pending" panel appears only if a §5 route answers 404/405 (for example against an older harness). No harness route or frozen interface was changed.
