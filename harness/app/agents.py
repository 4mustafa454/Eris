"""Agent repository: AgentState (§5.1) reads and event log helpers."""
import sqlite3

from . import db

EVENTS_PER_AGENT = 500

_AGENT_SELECT = """
SELECT a.id, a.name, a.color, a.engine, a.state, t.title AS task,
       a.summary, a.stuck_reason, a.updated_at
FROM agents a LEFT JOIN tasks t ON t.id = a.task_id
"""


def list_agents(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(_AGENT_SELECT + " ORDER BY a.id").fetchall()
    return [dict(r) for r in rows]


def get_agent(conn: sqlite3.Connection, agent_id: str) -> dict | None:
    row = conn.execute(_AGENT_SELECT + " WHERE a.id = ?", (agent_id,)).fetchone()
    return dict(row) if row else None


def get_log(conn: sqlite3.Connection, agent_id: str, lines: int = 40) -> list[str] | None:
    """Last `lines` event lines, oldest first. None if the agent does not exist."""
    if conn.execute("SELECT 1 FROM agents WHERE id = ?", (agent_id,)).fetchone() is None:
        return None
    lines = max(1, min(lines, EVENTS_PER_AGENT))
    rows = conn.execute(
        "SELECT line FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?", (agent_id, lines)
    ).fetchall()
    return [r["line"] for r in reversed(rows)]


def add_event(conn: sqlite3.Connection, agent_id: str, type_: str, line: str) -> None:
    """Append an event line and prune to the newest EVENTS_PER_AGENT for that agent."""
    conn.execute(
        "INSERT INTO events (agent_id, type, line, created_at) VALUES (?, ?, ?, ?)",
        (agent_id, type_, line, db.utcnow()),
    )
    conn.execute(
        "DELETE FROM events WHERE agent_id = ? AND id NOT IN"
        " (SELECT id FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?)",
        (agent_id, agent_id, EVENTS_PER_AGENT),
    )
