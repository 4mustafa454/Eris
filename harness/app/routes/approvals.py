"""Approval decisions, persisted atomically with the PM action."""
import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from .. import db, sessions
from ..deps import get_conn
from ..models import Approval, ApprovalDecision

router = APIRouter()


@router.get('/approvals', response_model=list[Approval])
def list_approvals(status: str | None = None, conn: sqlite3.Connection = Depends(get_conn)):
    sql = 'SELECT * FROM approvals'
    args = ()
    if status is not None:
        sql += ' WHERE status = ?'
        args = (status,)
    return [dict(row) for row in conn.execute(sql + ' ORDER BY created_at DESC, rowid DESC', args)]


@router.post('/approvals/{approval_id}', response_model=Approval)
def decide_approval(approval_id: str, body: ApprovalDecision, conn: sqlite3.Connection = Depends(get_conn)):
    conn.execute('BEGIN IMMEDIATE')
    try:
        row = conn.execute('SELECT * FROM approvals WHERE id = ?', (approval_id,)).fetchone()
        if row is None:
            raise HTTPException(404, 'unknown approval')
        if body.session_id is not None and sessions.get_session(conn, body.session_id) is None:
            raise HTTPException(404, 'unknown session')
        if row['status'] != 'pending':
            raise HTTPException(409, 'approval is already decided')
        conn.execute('UPDATE approvals SET status = ?, decided_at = ?, session_id = COALESCE(session_id, ?) WHERE id = ?',
                     (body.decision, db.utcnow(), body.session_id, approval_id))
        result = dict(conn.execute('SELECT * FROM approvals WHERE id = ?', (approval_id,)).fetchone())
        if body.session_id is not None:
            sessions.add_action(conn, body.session_id, 'decide_approval',
                                {'id': approval_id, 'decision': body.decision},
                                {'status': body.decision}, row['agent_id'])
        conn.execute('COMMIT')
        return result
    except BaseException:
        if conn.in_transaction:
            conn.execute('ROLLBACK')
        raise
