"""Session repository: sessions, messages, actions (shared by routes, /context, later /chat)."""
import json
import sqlite3
import uuid
from contextvars import ContextVar

from . import db

# Associates internal web-chat calls to the unchanged /stop-all route with their session.
action_session = ContextVar('action_session', default=None)


def create_session(conn: sqlite3.Connection, channel: str) -> dict:
    sid = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO sessions (id, channel, started_at) VALUES (?, ?, ?)", (sid, channel, db.utcnow())
    )
    return get_session(conn, sid)


def get_session(conn: sqlite3.Connection, session_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return dict(row) if row else None


def patch_session(conn: sqlite3.Connection, session_id: str, fields: dict) -> dict | None:
    """Update only the given fields (ended_at, summary, title)."""
    if get_session(conn, session_id) is None:
        return None
    allowed = {k: v for k, v in fields.items() if k in {"ended_at", "summary", "title"}}
    if allowed:
        sets = ", ".join(f"{k} = ?" for k in allowed)
        conn.execute(f"UPDATE sessions SET {sets} WHERE id = ?", (*allowed.values(), session_id))
    return get_session(conn, session_id)


def list_sessions(conn: sqlite3.Connection, channel: str | None, limit: int) -> list[dict]:
    sql, args = "SELECT * FROM sessions", []
    if channel:
        sql += " WHERE channel = ?"
        args.append(channel)
    sql += " ORDER BY started_at DESC, rowid DESC LIMIT ?"
    args.append(limit)
    return [dict(r) for r in conn.execute(sql, args)]


def get_session_detail(conn: sqlite3.Connection, session_id: str) -> dict | None:
    session = get_session(conn, session_id)
    if session is None:
        return None
    session["messages"] = [
        dict(r)
        for r in conn.execute("SELECT * FROM messages WHERE session_id = ? ORDER BY id", (session_id,))
    ]
    session["actions"] = [
        dict(r)
        for r in conn.execute("SELECT * FROM actions WHERE session_id = ? ORDER BY id", (session_id,))
    ]
    return session


def add_message(conn: sqlite3.Connection, session_id: str, role: str, text: str) -> dict | None:
    if get_session(conn, session_id) is None:
        return None
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)",
        (session_id, role, text, db.utcnow()),
    )
    return dict(conn.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone())


def add_action(
    conn: sqlite3.Connection,
    session_id: str | None,
    tool: str,
    args: dict,
    result: dict | None,
    agent_id: str | None,
) -> dict | None:
    """Log one tool call. None if the session does not exist; raises LookupError for an unknown agent.

    session_id may be None for calls that have no session (POST /stop-all).
    """
    if session_id is not None and get_session(conn, session_id) is None:
        return None
    if agent_id is not None and conn.execute(
        "SELECT 1 FROM agents WHERE id = ?", (agent_id,)
    ).fetchone() is None:
        raise LookupError(agent_id)
    cur = conn.execute(
        "INSERT INTO actions (session_id, agent_id, tool, args_json, result_json, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (
            session_id,
            agent_id,
            tool,
            json.dumps(args),
            None if result is None else json.dumps(result),
            db.utcnow(),
        ),
    )
    return dict(conn.execute("SELECT * FROM actions WHERE id = ?", (cur.lastrowid,)).fetchone())


def recent_summaries(conn: sqlite3.Connection, limit: int = 5) -> list[dict]:
    """Newest ended sessions that have a summary (for GET /context)."""
    rows = conn.execute(
        "SELECT id AS session_id, channel, summary, ended_at FROM sessions"
        " WHERE ended_at IS NOT NULL AND summary IS NOT NULL"
        " ORDER BY ended_at DESC, rowid DESC LIMIT ?",
        (limit,),
    )
    return [dict(r) for r in rows]
