"""Web conversation endpoint using the shared PM brain."""
from fastapi import APIRouter, Depends, HTTPException, Request

from .. import sessions
from ..deps import get_conn
from ..models import ChatRequest

router = APIRouter()


@router.post('/chat')
async def chat(body: ChatRequest, request: Request, conn=Depends(get_conn)):
    session_id = body.session_id
    if session_id:
        if sessions.get_session(conn, session_id) is None:
            raise HTTPException(404, 'unknown session')
    else:
        session_id = sessions.create_session(conn, 'web')['id']
    return await request.app.state.pm_chat.turn(session_id, body.text)
