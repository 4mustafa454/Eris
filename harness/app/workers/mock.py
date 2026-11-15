"""Mock workers: seeded agents plus an optional MOCK_TICK=1 ticker.

Data only. Agents listed in REAL_WORKERS are run by the Docker manager instead; the ticker never touches them.
"""
import asyncio
import os
import random
import sqlite3

from .. import agents, db, tasks
from ..tasks import complete_task, start_next_queued  # noqa: F401  (re-exported: the mock API the tests use)

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
    ("Upgrade the web framework", "Upgrade the web framework and fix any deprecations."),
    ("Add pagination to /orders", "Add cursor pagination to the /orders endpoint."),
    ("Remove dead code in utils", "Find and delete unused helpers in utils."),
    ("Speed up the slowest test", "Profile the test suite and speed up the slowest test."),
    ("Add a health check endpoint", "Add a /healthz endpoint that checks the database."),
]

# AGENTS.md §5.2.1: at most one working-or-stuck task per agent, any number queued (run in
# created_at order). The ticker caps the queue so a long run does not pile up tasks forever.
MAX_QUEUED_PER_AGENT = 2
QUEUE_CHANCE = 0.15  # per tick: a "user" adds a task for the agent that just moved
IDLE_NEW_TASK_CHANCE = 0.5  # per tick on a done agent with an empty queue


def seed_agents(conn: sqlite3.Connection, real=()) -> None:
    """Idempotent. Order respects foreign keys: agents (task_id NULL) → tasks → link.

    Agents listed in `real` (REAL_WORKERS) are seeded `idle` with no task and no events: a real worker has nothing to
    show until it is given a task.
    """
    if conn.execute("SELECT COUNT(*) FROM agents").fetchone()[0]:
        return
    now = db.utcnow()
    mocked = [s for s in SEED if s["id"] not in real]
    conn.execute("BEGIN")
    try:
        for s in SEED:
            state, summary = ("idle", None) if s["id"] in real else (s["state"], s["summary"])
            conn.execute(
                "INSERT INTO agents (id, name, color, engine, state, task_id, summary, updated_at)"
                " VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
                (s["id"], s["name"], s["color"], s["engine"], state, summary, now),
            )
        for s in mocked:
            conn.execute(
                "INSERT INTO tasks (id, agent_id, title, instruction, status, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (s["task_id"], s["id"], s["title"], s["instruction"], s["state"], now, now),
            )
        for s in mocked:
            conn.execute("UPDATE agents SET task_id = ? WHERE id = ?", (s["task_id"], s["id"]))
            for line in s["lines"]:
                agents.add_event(conn, s["id"], "line", line)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


_OPEN = "('queued', 'working', 'stuck')"


def enqueue_task(conn: sqlite3.Connection, agent_id: str, rng, now: str) -> tuple[str, str, str] | None:
    """A new task for an agent, per §5.2.1: starts now if the agent is idle/done, else `queued`.

    Skips titles that are already open on any agent and respects MAX_QUEUED_PER_AGENT.
    Returns (task_id, title, status) or None if nothing could be created.
    """
    if tasks.is_busy(conn, agent_id):
        queued = conn.execute(
            "SELECT COUNT(*) FROM tasks WHERE agent_id = ? AND status = 'queued'", (agent_id,)
        ).fetchone()[0]
        if queued >= MAX_QUEUED_PER_AGENT:
            return None
    taken = {r["title"] for r in conn.execute(f"SELECT title FROM tasks WHERE status IN {_OPEN}")}
    choices = [t for t in _NEW_TASKS if t[0] not in taken]
    if not choices:
        return None
    title, instruction = rng.choice(choices)
    task_id = f"task-{rng.getrandbits(32):08x}"
    status = tasks.add_task(conn, agent_id, title, instruction, now, task_id)
    return task_id, title, status


def tick_once(conn: sqlite3.Connection, rng: random.Random | None = None, skip=frozenset()) -> str | None:
    """Advance one random mock agent a single step, atomically. Returns the agent id that moved.

    Agents in `skip` (the real workers) are never touched. Returns None if there is no mock agent to move.
    """
    rng = rng or random
    conn.execute("BEGIN")
    try:
        aid = _tick(conn, rng, skip)
        conn.execute("COMMIT")
        return aid
    except Exception:
        conn.execute("ROLLBACK")
        raise


def _tick(conn: sqlite3.Connection, rng, skip=frozenset()) -> str | None:
    candidates = [a for a in conn.execute("SELECT * FROM agents ORDER BY id").fetchall() if a["id"] not in skip]
    if not candidates:
        return None
    agent = rng.choice(candidates)
    aid, state = agent["id"], agent["state"]
    now = db.utcnow()

    if state == "working":
        roll = rng.random()
        if roll < 0.2:
            reason = rng.choice(_STUCK_REASONS)
            tasks.set_state(conn, aid, "stuck", f"Blocked: {reason}", reason, now)
            agents.add_event(conn, aid, "stuck", f"BLOCKED: {reason}")
        elif roll < 0.4:
            complete_task(conn, aid, now)
        else:
            line = rng.choice(_WORK_LINES)
            conn.execute("UPDATE agents SET summary = ?, updated_at = ? WHERE id = ?", (line, now, aid))
            agents.add_event(conn, aid, "line", line)
    elif state == "stuck":  # steered: same task, stuck → working
        tasks.set_state(conn, aid, "working", "Resumed after guidance", None, now)
        agents.add_event(conn, aid, "state_changed", "resumed after guidance")
    elif state in ("idle", "done"):
        if start_next_queued(conn, aid, now) is None and rng.random() < IDLE_NEW_TASK_CHANCE:
            enqueue_task(conn, aid, rng, now)

    if rng.random() < QUEUE_CHANCE:
        enqueue_task(conn, aid, rng, now)
    return aid


def ticker_enabled() -> bool:
    return os.environ.get("MOCK_TICK") == "1"


def ticker_interval() -> float:
    try:
        return max(0.5, float(os.environ.get("MOCK_TICK_SECONDS", "4")))
    except ValueError:
        return 4.0


async def run_ticker(interval: float | None = None, skip=frozenset()) -> None:
    """Background loop for the app lifespan; cancelled on shutdown. `skip`: real workers the ticker must not touch."""
    interval = interval or ticker_interval()
    while True:
        await asyncio.sleep(interval)
        conn = db.connect()
        try:
            tick_once(conn, skip=skip)
        finally:
            conn.close()
