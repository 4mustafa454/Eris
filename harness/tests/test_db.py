import sqlite3

import pytest

from app import db

TABLES = {"agents", "tasks", "sessions", "messages", "actions", "events", "approvals", "settings"}


def _session(conn, sid="s1"):
    conn.execute(
        "INSERT INTO sessions (id, channel, started_at) VALUES (?, 'web', ?)", (sid, db.utcnow())
    )


def _message(conn, text, sid="s1"):
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, text, created_at) VALUES (?, 'user', ?, ?)",
        (sid, text, db.utcnow()),
    )
    return cur.lastrowid


def _fts_hits(conn, term):
    return [
        r[0]
        for r in conn.execute("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?", (term,))
    ]


def test_pragmas(conn):
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_tables_exist(conn):
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert TABLES <= names
    assert "messages_fts" in names


def test_init_is_idempotent(db_file):
    db.init_db()
    db.init_db()


def test_fts_insert_update_delete(conn):
    _session(conn)
    mid = _message(conn, "rename the package please")
    assert _fts_hits(conn, "package") == [mid]

    conn.execute("UPDATE messages SET text = 'deploy the endpoint' WHERE id = ?", (mid,))
    assert _fts_hits(conn, "package") == []
    assert _fts_hits(conn, "endpoint") == [mid]

    conn.execute("DELETE FROM messages WHERE id = ?", (mid,))
    assert _fts_hits(conn, "endpoint") == []


def test_foreign_key_enforced(conn):
    with pytest.raises(sqlite3.IntegrityError):
        _message(conn, "orphan", sid="no-such-session")


def test_agent_task_cycle_needs_null_first(conn):
    """agents.task_id -> tasks and tasks.agent_id -> agents: seed with NULL, then update."""
    now = db.utcnow()
    conn.execute(
        "INSERT INTO agents (id, name, color, engine, state, task_id, updated_at)"
        " VALUES ('agent-1', 'Agent 1', '#7F77DD', 'claude-code', 'idle', NULL, ?)",
        (now,),
    )
    conn.execute(
        "INSERT INTO tasks (id, agent_id, title, instruction, status, created_at, updated_at)"
        " VALUES ('t1', 'agent-1', 'T', 'do it', 'working', ?, ?)",
        (now, now),
    )
    conn.execute("UPDATE agents SET task_id = 't1' WHERE id = 'agent-1'")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE agents SET task_id = 'missing' WHERE id = 'agent-1'")


def test_utcnow_format():
    ts = db.utcnow()
    assert ts.endswith("Z") and len(ts) == 20
