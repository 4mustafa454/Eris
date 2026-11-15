"""Mock workers for M0: seeded agents plus an optional MOCK_TICK=1 ticker.

Data only. Nothing here changes an interface; M3 replaces this with the Docker manager.
"""
import asyncio
import os
import random
import sqlite3

from .. import agents, db

SEED = [
    {
        "id": "agent-1", "name": "Agent 1", "color": "#7F77DD", "engine": "claude-code",
        "state": "working", "task_id": "task-1",
        "title": "Add input validation to /signup",
        "instruction": "Add input validation to the /signup endpoint and cover it with tests.",
        "summary": "Running tests after editing signup.py",
        "lines": ["read signup.py", "edit signup.py", "run pytest → 2 failed", "edit signup.py"],
    },
    {
        "id": "agent-2", "name": "Agent 2", "color": "#1D9E75", "engine": "claude-code",
        "state": "working", "task_id": "task-2",
        "title": "Write tests for the billing module",
        "instruction": "Write unit tests for the billing module.",
        "summary": "Writing tests for invoice totals",
        "lines": ["read billing.py", "create test_billing.py", "run pytest → 5 passed"],
    },
    {
        "id": "agent-3", "name": "Agent 3", "color": "#D85A30", "engine": "codex",
        "state": "done", "task_id": "task-3",
        "title": "Rename the package to eris_core",
        "instruction": "Rename the package to eris_core and update every import.",
        "summary": "Renamed the package and updated imports; all tests pass",
        "lines": ["grep old package name", "edit 14 files", "run pytest → 12 passed", "git commit"],
    },
]

_TASK_STATUS = {"working": "working", "stuck": "stuck", "done": "done"}

_WORK_LINES = [
    "read config.py", "edit routes.py", "run pytest → 1 failed", "run pytest → all passed",
    "edit models.py", "grep TODO", "run linter → clean", "git commit",
]
_STUCK_REASONS = [
    "Which endpoint should I use, v1 or v2?",
    "Tests need a database URL I don't have",
    "Two migrations conflict; which one wins?",
]
_NEW_TASKS = [
    ("Add rate limiting to /login", "Add rate limiting to the /login endpoint."),
    ("Document the public API", "Write docstrings for the public API."),
    ("Fix the flaky checkout test", "Find and fix the flaky checkout test."),
]


def seed_agents(conn: sqlite3.Connection) -> None:
    """Idempotent. Order respects foreign keys: agents (task_id NULL) → tasks → link."""
    if conn.execute("SELECT COUNT(*) FROM agents").fetchone()[0]:
        return
    now = db.utcnow()
    conn.execute("BEGIN")
    try:
        for s in SEED:
            conn.execute(
                "INSERT INTO agents (id, name, color, engine, state, task_id, summary, updated_at)"
                " VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
                (s["id"], s["name"], s["color"], s["engine"], s["state"], s["summary"], now),
            )
        for s in SEED:
            conn.execute(
                "INSERT INTO tasks (id, agent_id, title, instruction, status, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (s["task_id"], s["id"], s["title"], s["instruction"], s["state"], now, now),
            )
        for s in SEED:
            conn.execute("UPDATE agents SET task_id = ? WHERE id = ?", (s["task_id"], s["id"]))
            for line in s["lines"]:
                agents.add_event(conn, s["id"], "line", line)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def tick_once(conn: sqlite3.Connection, rng: random.Random | None = None) -> str:
    """Advance one random agent a single step. Returns the agent id that moved."""
    rng = rng or random
    agent = rng.choice(conn.execute("SELECT * FROM agents ORDER BY id").fetchall())
    aid, state = agent["id"], agent["state"]
    now = db.utcnow()

    if state == "working":
        roll = rng.random()
        if roll < 0.2:
            reason = rng.choice(_STUCK_REASONS)
            _set_state(conn, agent, "stuck", f"Blocked: {reason}", reason, now)
            agents.add_event(conn, aid, "stuck", f"BLOCKED: {reason}")
        elif roll < 0.4:
            _set_state(conn, agent, "done", "Finished the task; tests pass", None, now)
            agents.add_event(conn, aid, "done", "run pytest → all passed")
        else:
            line = rng.choice(_WORK_LINES)
            conn.execute("UPDATE agents SET summary = ?, updated_at = ? WHERE id = ?", (line, now, aid))
            agents.add_event(conn, aid, "line", line)
    elif state == "stuck":
        _set_state(conn, agent, "working", "Resumed after guidance", None, now)
        agents.add_event(conn, aid, "state_changed", "resumed after guidance")
    elif state == "done":
        title, instruction = rng.choice(_NEW_TASKS)
        task_id = f"task-{rng.getrandbits(32):08x}"
        conn.execute(
            "INSERT INTO tasks (id, agent_id, title, instruction, status, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, 'working', ?, ?)",
            (task_id, aid, title, instruction, now, now),
        )
        conn.execute("UPDATE agents SET task_id = ? WHERE id = ?", (task_id, aid))
        _set_state(conn, agent, "working", f"Starting: {title}", None, now)
        agents.add_event(conn, aid, "state_changed", f"start task: {title}")
    return aid


def _set_state(conn, agent, state, summary, stuck_reason, now) -> None:
    conn.execute(
        "UPDATE agents SET state = ?, summary = ?, stuck_reason = ?, updated_at = ? WHERE id = ?",
        (state, summary, stuck_reason, now, agent["id"]),
    )
    if agent["task_id"]:
        conn.execute(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
            (_TASK_STATUS[state], now, agent["task_id"]),
        )


def ticker_enabled() -> bool:
    return os.environ.get("MOCK_TICK") == "1"


def ticker_interval() -> float:
    try:
        return max(0.5, float(os.environ.get("MOCK_TICK_SECONDS", "4")))
    except ValueError:
        return 4.0


async def run_ticker(interval: float | None = None) -> None:
    """Background loop for the app lifespan; cancelled on shutdown."""
    interval = interval or ticker_interval()
    while True:
        await asyncio.sleep(interval)
        conn = db.connect()
        try:
            tick_once(conn)
        finally:
            conn.close()
