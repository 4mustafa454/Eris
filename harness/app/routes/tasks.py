"""Task reads from the existing harness contract."""
import sqlite3

from fastapi import APIRouter, Depends

from ..deps import get_conn
from ..models import Task

router = APIRouter()


@router.get('/tasks', response_model=list[Task])
def list_tasks(status: str | None = None, conn: sqlite3.Connection = Depends(get_conn)):
    sql = 'SELECT * FROM tasks'
    args = ()
    if status is not None:
        sql += ' WHERE status = ?'
        args = (status,)
    return [dict(row) for row in conn.execute(sql + ' ORDER BY created_at DESC, rowid DESC', args)]
