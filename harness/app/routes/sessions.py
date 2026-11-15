import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import sessions
from ..deps import get_conn
from ..models import (
    Channel,
    Message,
    MessageCreate,
    Session,
    SessionCreate,
    SessionDetail,
    SessionPatch,
)

router = APIRouter()


def _or_404(value, session_id: str):
    if value is None:
        raise HTTPException(404, f"unknown session: {session_id}")
    return value


@router.post("/sessions", response_model=Session)
def create_session(body: SessionCreate, conn: sqlite3.Connection = Depends(get_conn)):
    return sessions.create_session(conn, body.channel)


@router.get("/sessions", response_model=list[Session])
def list_sessions(
    channel: Channel | None = None,
    limit: int = Query(50, ge=1, le=500),
    conn: sqlite3.Connection = Depends(get_conn),
):
    return sessions.list_sessions(conn, channel, limit)


@router.get("/sessions/{session_id}", response_model=SessionDetail)
def get_session(session_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    return _or_404(sessions.get_session_detail(conn, session_id), session_id)


@router.patch("/sessions/{session_id}", response_model=Session)
def patch_session(session_id: str, body: SessionPatch, conn: sqlite3.Connection = Depends(get_conn)):
    fields = body.model_dump(exclude_unset=True)
    return _or_404(sessions.patch_session(conn, session_id, fields), session_id)


@router.post("/sessions/{session_id}/messages", response_model=Message)
def add_message(session_id: str, body: MessageCreate, conn: sqlite3.Connection = Depends(get_conn)):
    return _or_404(sessions.add_message(conn, session_id, body.role, body.text), session_id)
