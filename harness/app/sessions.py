"""Session repository: sessions, messages, actions (shared by routes, /context, later /chat)."""
import sqlite3
import uuid

from . import db


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


def recent_summaries(conn: sqlite3.Connection, limit: int = 5) -> list[dict]:
    """Newest ended sessions that have a summary (for GET /context)."""
    rows = conn.execute(
        "SELECT id AS session_id, channel, summary, ended_at FROM sessions"
        " WHERE ended_at IS NOT NULL AND summary IS NOT NULL"
        " ORDER BY ended_at DESC, rowid DESC LIMIT ?",
        (limit,),
    )
    return [dict(r) for r in rows]
