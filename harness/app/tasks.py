"""Task rules (AGENTS.md §5.2.1), shared by mock and real workers. Plain DB functions: no processes, no I/O.

- Invariant: at most ONE working-or-stuck task per agent; any number queued, started in created_at order.
- `steer` = the agent has a working/stuck task: same task row, same engine session.
- A new task starts now if the agent has no live task (idle/done), otherwise it is stored `queued`.
- Nothing here ever overwrites a working task.

The caller owns the transaction (BEGIN/COMMIT), as in mock.tick_once.
"""
import sqlite3

from . import agents, db

LIVE = ("working", "stuck")
TITLE_MAX = 60

DEFAULT_DONE_SUMMARY = "Finished the task; tests pass"
DEFAULT_DONE_LINE = "run pytest → all passed"

# agent state → status of the agent's current task row. error is still the agent's one live task (steerable).
_TASK_STATUS = {"working": "working", "stuck": "stuck", "error": "stuck", "done": "done"}


def title_from(instruction: str) -> str:
    """A short task title from an instruction: its first line, cut at a word boundary to TITLE_MAX characters."""
    text = " ".join(instruction.split())
    if len(text) <= TITLE_MAX:
        return text
    cut = text[: TITLE_MAX - 1].rsplit(" ", 1)[0] or text[: TITLE_MAX - 1]
    return cut.rstrip(" ,.;:") + "…"


def has_live_task(conn: sqlite3.Connection, agent_id: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM tasks WHERE agent_id = ? AND status IN ('working', 'stuck')", (agent_id,)
    ).fetchone() is not None


def is_busy(conn: sqlite3.Connection, agent_id: str) -> bool:
    """True if a new task for this agent must wait in the queue."""
    state = conn.execute("SELECT state FROM agents WHERE id = ?", (agent_id,)).fetchone()["state"]
    return state not in ("idle", "done") or has_live_task(conn, agent_id)


def start_next_queued(conn: sqlite3.Connection, agent_id: str, now: str) -> tuple[str, str] | None:
    """Start the agent's oldest queued task (created_at, then insertion order).

    Never overwrites work: does nothing while the agent still has a working or stuck task.
    Returns (task_id, title) or None.
    """
    if has_live_task(conn, agent_id):
        return None
    row = conn.execute(
        "SELECT id, title FROM tasks WHERE agent_id = ? AND status = 'queued'"
        " ORDER BY created_at, rowid LIMIT 1",
        (agent_id,),
    ).fetchone()
    if row is None:
        return None
    conn.execute("UPDATE tasks SET status = 'working', updated_at = ? WHERE id = ?", (now, row["id"]))
    conn.execute(
        "UPDATE agents SET task_id = ?, state = 'working', summary = ?, stuck_reason = NULL,"
        " updated_at = ? WHERE id = ?",
        (row["id"], f"Starting: {row['title']}", now, agent_id),
    )
    agents.add_event(conn, agent_id, "state_changed", f"start task: {row['title']}")
    return row["id"], row["title"]


def complete_task(
    conn: sqlite3.Connection, agent_id: str, now: str,
    summary: str = DEFAULT_DONE_SUMMARY, line: str = DEFAULT_DONE_LINE,
) -> tuple[str, str] | None:
    """The agent's current task reaches done; then its next queued task starts automatically.

    Returns the (task_id, title) that started, or None if the queue was empty.
    """
    agent = conn.execute("SELECT task_id FROM agents WHERE id = ?", (agent_id,)).fetchone()
    if agent["task_id"]:
        conn.execute(
            "UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ? AND status IN ('working', 'stuck')",
            (now, agent["task_id"]),
        )
    conn.execute(
        "UPDATE agents SET state = 'done', summary = ?, stuck_reason = NULL, updated_at = ? WHERE id = ?",
        (summary, now, agent_id),
    )
    agents.add_event(conn, agent_id, "done", line)
    return start_next_queued(conn, agent_id, now)


def add_task(
    conn: sqlite3.Connection, agent_id: str, title: str, instruction: str, now: str, task_id: str
) -> str:
    """A NEW task for an agent: starts now if the agent is idle/done, else is stored `queued`.

    Returns the status it got, 'working' or 'queued'. A working task is never overwritten.
    """
    busy = is_busy(conn, agent_id)
    status = "queued" if busy else "working"
    conn.execute(
        "INSERT INTO tasks (id, agent_id, title, instruction, status, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (task_id, agent_id, title, instruction, status, now, now),
    )
    if busy:
        agents.add_event(conn, agent_id, "line", f"queued task: {title}")
    else:
        conn.execute(
            "UPDATE agents SET task_id = ?, state = 'working', summary = ?, stuck_reason = NULL,"
            " updated_at = ? WHERE id = ?",
            (task_id, f"Starting: {title}", now, agent_id),
        )
        agents.add_event(conn, agent_id, "state_changed", f"start task: {title}")
    return status


def steer(conn: sqlite3.Connection, agent_id: str, now: str, note: str) -> str | None:
    """Steer the agent's current task: the task row is unchanged, stuck/paused/error becomes working.

    Returns the agent's previous state, or None if it has no live task (then the caller starts a new task).
    """
    row = conn.execute(
        "SELECT a.state, a.task_id FROM agents a JOIN tasks t ON t.id = a.task_id"
        " WHERE a.id = ? AND t.status IN ('working', 'stuck')",
        (agent_id,),
    ).fetchone()
    if row is None:
        return None
    set_state(conn, agent_id, "working", note, None, now)
    agents.add_event(conn, agent_id, "state_changed", f"steered: {note}")
    return row["state"]


def set_state(
    conn: sqlite3.Connection, agent_id: str, state: str, summary: str | None, stuck_reason: str | None, now: str
) -> None:
    """Move the agent to `state`, mirroring it on its current task row (working/stuck/done; paused leaves it alone)."""
    conn.execute(
        "UPDATE agents SET state = ?, summary = ?, stuck_reason = ?, updated_at = ? WHERE id = ?",
        (state, summary, stuck_reason, now, agent_id),
    )
    status = _TASK_STATUS.get(state)
    if status:
        conn.execute(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE id = (SELECT task_id FROM agents WHERE id = ?)"
            " AND status IN ('working', 'stuck')",
            (status, now, agent_id),
        )
