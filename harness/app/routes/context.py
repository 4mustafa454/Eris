import sqlite3

from fastapi import APIRouter, Depends

from .. import agents, sessions
from ..deps import get_conn
from ..models import ContextResponse

router = APIRouter()


@router.get("/context", response_model=ContextResponse)
def get_context(conn: sqlite3.Connection = Depends(get_conn)):
    """Loaded into the PM at every session start (§5.2, §5.4)."""
    open_tasks = conn.execute(
        "SELECT * FROM tasks WHERE status IN ('queued', 'working', 'stuck')"
        " ORDER BY created_at, rowid"
    ).fetchall()
    pending = conn.execute(
        "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at, rowid"
    ).fetchall()
    return {
        "recent_summaries": sessions.recent_summaries(conn, 5),
        "agents": agents.list_agents(conn),
        "open_tasks": [dict(r) for r in open_tasks],
        "pending_approvals": [dict(r) for r in pending],
    }
