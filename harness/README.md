# Eris harness

FastAPI + SQLite (WAL, FTS5) on `:8787`. Contract: see `/AGENTS.md` §4–§5. M0 covers the schema,
mock workers, `/agents`, `/sessions`, `/context`, and the shared PM files in `/shared/pm/`. M3 adds real Claude Code
workers in Docker, `POST /agents/{id}/task` and `POST /stop-all` (see "Real workers" below).

## Setup

```sh
cd harness
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run

```sh
cd harness
.venv/bin/uvicorn app.main:app --port 8787
```

The database is created at `harness/data/eris.db` (gitignored) and seeded with three mock agents.
Override the location with `ERIS_DB_PATH`.

Optional mock activity: `MOCK_TICK=1` moves agents between working/stuck/done and adds event
lines every `MOCK_TICK_SECONDS` (default 4). Data only; no interface changes. It follows the task
rules in AGENTS.md §5.2.1: a new task for a busy agent is `queued` and starts (oldest first) when the
current task reaches done; a working task is never overwritten.

Quick check:

```sh
curl localhost:8787/agents
curl -X POST localhost:8787/sessions -H 'content-type: application/json' -d '{"channel":"web"}'
curl localhost:8787/context
```

## Test

```sh
cd harness
.venv/bin/pytest tests -q
```

## Shared PM files

`/shared/pm/system_prompt.md` and `/shared/pm/tools.json` are loaded by both the harness (`app/pm.py`)
and the supervisor. The placeholder format is documented at the top of the prompt file.

## Real workers (M3)

By default every agent is a mock. Set `REAL_WORKERS=agent-1` (comma-separated ids; see `.env.example`) to run those agents as
real Claude Code workers in Docker. The rest stay mock, and the mock ticker never touches a real agent. A real agent starts
`idle` with no task. The database is seeded once, so switching modes needs `scripts/seed-demo.sh`.

**Once:** install Docker (and let your user run it), then

```sh
scripts/build-worker.sh                          # the worker image, for your uid/gid
scripts/make-demo-repo.sh                        # demo-repo/: its own git repo with one failing test
npx -y @anthropic-ai/claude-code@2.1.316 setup-token     # then put CLAUDE_CODE_OAUTH_TOKEN=... in harness/.env
cp .env.example .env                             # and set REAL_WORKERS=agent-1
```

**Check first:** `.venv/bin/python -m app.config` validates `harness/.env` without starting anything: it reports bad values,
lines that are silently ignored (a token that wrapped onto a second line is the classic one) and the token's length, never
its value.

**Run:** `.venv/bin/uvicorn app.main:app --port 8787` as before. A bad `REAL_WORKERS` or a missing token stops startup and
names the variable; ignored `.env` lines are warned about on startup.

```sh
curl -X POST localhost:8787/agents/agent-1/task -H 'content-type: application/json' \
  -d '{"instruction":"Run the tests and fix the failing one. Commit when green."}'
curl localhost:8787/agents/agent-1/log            # short lines: run pytest → 1 failed, edit shop/signup.py, …
curl -X POST localhost:8787/stop-all              # kill switch
```

How it behaves (AGENTS.md §5.2.1): if the agent has a working or stuck task, the instruction **steers** it: same task, same
Claude session (`--resume`); a run in progress is interrupted first, from inside the container (`pkill -INT`, 5 s, then
`pkill -KILL`, then leftover children such as pytest; never PID 1). Otherwise it starts a **new** task. When a task finishes
the next queued one starts. A reply whose last `BLOCKED:` line asks a question makes the agent `stuck` with that question
as `stuck_reason`; running out of turns is `stuck` too, and a crashed run is `error`. `POST /stop-all` stops every run and
pauses working agents (their tasks are kept; steering one resumes it). If the harness restarts, a real agent that was
working becomes `stuck` ("harness restarted during this run") and any stray run is stopped.

Safety (AGENTS.md §8): each worker sees only its container and `demo-repo/`: non-root user, no host home, no docker socket,
no capabilities, memory/pid limits. Workers commit locally; they have no remote and no push credentials. The API token is
handed to each run by name (`docker exec -e CLAUDE_CODE_OAUTH_TOKEN`), so it is never in a command line, an image, a
container config, the database, or a log line (known secret values are redacted from event lines and reasons).

**Debugging a run:** set `ERIS_STREAM_LOG=data/stream.log` (gitignored) and the raw `stream-json` of every run is appended there, secrets
redacted, one `agent-id<TAB>json` line each. Off by default.

**Reset before a rehearsal:** stop the harness, run `scripts/seed-demo.sh` (deletes the dev database, rebuilds `demo-repo/`,
removes the worker containers and their volumes), start the harness again.
