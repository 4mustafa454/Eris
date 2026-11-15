"""Full-text search over the shared conversation transcript."""
import sqlite3
import re

from fastapi import APIRouter, Depends, HTTPException, Query

from ..deps import get_conn

router = APIRouter()


@router.get('/search')
def search(q: str = Query(..., min_length=1), conn: sqlite3.Connection = Depends(get_conn)):
    if not q.strip():
        return []
    sql = ("SELECT m.session_id, snippet(messages_fts, 0, '[', ']', ' … ', 18) AS snippet, m.created_at "
           "FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid "
           "WHERE messages_fts MATCH ? ORDER BY m.created_at DESC, m.id DESC")
    try:
        rows = conn.execute(sql, (q,)).fetchall()
    except sqlite3.OperationalError:
        # Ordinary punctuation such as "v2-endpoint?" should not break the dashboard search box.
        terms = re.findall(r'\w+', q, re.UNICODE)
        if not terms:
            return []
        try:
            rows = conn.execute(sql, (' AND '.join(f'"{term}"' for term in terms),)).fetchall()
        except sqlite3.OperationalError:
            raise HTTPException(422, 'invalid search query') from None
    return [dict(row) for row in rows]
