"""Full-text search over the shared conversation transcript."""
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from ..deps import get_conn

router = APIRouter()


@router.get('/search')
def search(q: str = Query(..., min_length=1), conn: sqlite3.Connection = Depends(get_conn)):
    if not q.strip():
        return []
    try:
        rows = conn.execute(
            "SELECT m.session_id, snippet(messages_fts, 0, '[', ']', ' … ', 18) AS snippet, m.created_at "
            "FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid "
            "WHERE messages_fts MATCH ? ORDER BY m.created_at DESC, m.id DESC", (q,),
        ).fetchall()
    except sqlite3.OperationalError:
        raise HTTPException(422, 'invalid search query') from None
    return [dict(row) for row in rows]
