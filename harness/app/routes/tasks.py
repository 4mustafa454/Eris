"""Task reads from the existing harness contract."""
import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from .. import sessions
from ..deps import get_conn, get_manager
from ..models import Task, TaskCreate, TaskPatch
from ..workers.manager import TaskConflict, UnknownAgent, UnknownTask

router = APIRouter()


@router.get('/tasks', response_model=list[Task])
def list_tasks(status: str | None = None, conn: sqlite3.Connection = Depends(get_conn)):
    sql = 'SELECT * FROM tasks'
    args = ()
    if status is not None:
        sql += ' WHERE status = ?'
        args = (status,)
    return [dict(row) for row in conn.execute(sql + ' ORDER BY created_at DESC, rowid DESC', args)]


@router.post('/tasks', response_model=Task)
async def create_task(body: TaskCreate, conn: sqlite3.Connection = Depends(get_conn), manager=Depends(get_manager)):
    if body.session_id is not None and sessions.get_session(conn, body.session_id) is None:
        raise HTTPException(404, 'unknown session')
    try:
        return await manager.create_board_task(body.title, body.instruction, body.agent_id, body.session_id)
    except UnknownAgent:
        raise HTTPException(404, 'unknown agent') from None


@router.patch('/tasks/{task_id}', response_model=Task)
async def patch_task(task_id: str, body: TaskPatch, manager=Depends(get_manager)):
    try:
        return await manager.update_board_task(task_id, body.model_dump(exclude_unset=True))
    except UnknownTask:
        raise HTTPException(404, 'unknown task') from None
    except UnknownAgent:
        raise HTTPException(404, 'unknown agent') from None
    except TaskConflict as error:
        raise HTTPException(409, str(error)) from None
