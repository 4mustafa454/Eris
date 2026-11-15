# Eris harness

FastAPI + SQLite (WAL, FTS5) on `:8787`. Contract: see `/AGENTS.md` §4–§5. M0 covers the schema,
mock workers, `/agents`, `/sessions`, `/context`, and the shared PM files in `/shared/pm/`.

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
lines every `MOCK_TICK_SECONDS` (default 4). Data only; no interface changes.

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
