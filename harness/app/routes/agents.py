import re
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import agents, sessions
from ..deps import get_conn, get_manager
from ..models import AgentState, LogResponse, SessionRef, TaskInstruction
from ..workers.manager import ResumeUnavailable, UnknownAgent

router = APIRouter()


async def _change_pause(agent_id, body, conn, manager, *, resume):
    if agents.get_agent(conn, agent_id) is None:
        raise HTTPException(404, f"unknown agent: {agent_id}")
    if body.session_id is not None and sessions.get_session(conn, body.session_id) is None:
        raise HTTPException(404, f"unknown session: {body.session_id}")
    try:
        state = await (manager.resume(agent_id) if resume else manager.pause(agent_id))
    except ResumeUnavailable as error:
        raise HTTPException(409, str(error)) from None
    except UnknownAgent:
        raise HTTPException(404, f"unknown agent: {agent_id}") from None
    if body.session_id is not None:
        match = re.search(r'(\d+)$', agent_id)
        args = {'n': int(match.group(1))} if match else {}
        sessions.add_action(conn, body.session_id, 'resume_agent' if resume else 'pause_agent', args,
                            {'state': state['state']}, agent_id)
    return state


@router.post('/agents/{agent_id}/pause', response_model=AgentState)
async def pause_agent(agent_id: str, body: SessionRef = SessionRef(), conn: sqlite3.Connection = Depends(get_conn),
                      manager=Depends(get_manager)):
    return await _change_pause(agent_id, body, conn, manager, resume=False)


@router.post('/agents/{agent_id}/resume', response_model=AgentState)
async def resume_agent(agent_id: str, body: SessionRef = SessionRef(), conn: sqlite3.Connection = Depends(get_conn),
                       manager=Depends(get_manager)):
    return await _change_pause(agent_id, body, conn, manager, resume=True)


@router.get("/agents", response_model=list[AgentState])
def list_agents(conn: sqlite3.Connection = Depends(get_conn)):
    return agents.list_agents(conn)


@router.get("/agents/{agent_id}", response_model=AgentState)
def get_agent(agent_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    agent = agents.get_agent(conn, agent_id)
    if agent is None:
        raise HTTPException(404, f"unknown agent: {agent_id}")
    return agent


@router.get("/agents/{agent_id}/log", response_model=LogResponse)
def get_log(
    agent_id: str,
    lines: int = Query(40, ge=1, le=agents.EVENTS_PER_AGENT),
    conn: sqlite3.Connection = Depends(get_conn),
):
    log = agents.get_log(conn, agent_id, lines)
    if log is None:
        raise HTTPException(404, f"unknown agent: {agent_id}")
    return {"lines": log}


@router.post("/agents/{agent_id}/task", response_model=AgentState)
async def send_task(
    agent_id: str,
    body: TaskInstruction,
    conn: sqlite3.Connection = Depends(get_conn),
    manager=Depends(get_manager),
):
    """§5.2.1: steer the agent's working/stuck task (same task, same engine session), or start a new task if it is
    idle/done. With session_id the harness writes the send_task action row (§5.3: mutating tools are logged here)."""
    if agents.get_agent(conn, agent_id) is None:
        raise HTTPException(404, f"unknown agent: {agent_id}")
    if body.session_id is not None and sessions.get_session(conn, body.session_id) is None:
        raise HTTPException(404, f"unknown session: {body.session_id}")
    try:
        state, kind = await manager.send(agent_id, body.instruction)
    except UnknownAgent:
        raise HTTPException(404, f"unknown agent: {agent_id}") from None
    if body.session_id is not None:
        args = {"instruction": body.instruction}
        if (m := re.search(r"(\d+)$", agent_id)):
            args = {"n": int(m.group(1)), **args}
        sessions.add_action(
            conn, body.session_id, "send_task", args,
            {"kind": kind, "state": state["state"], "task": state["task"]}, agent_id,
        )
    return state


@router.post("/stop-all", response_model=list[AgentState])
async def stop_all(conn: sqlite3.Connection = Depends(get_conn), manager=Depends(get_manager)):
    """Kill switch (§8): stop every run inside its container and pause working/stuck agents. Their tasks are kept."""
    out = await manager.stop_all()
    # §5.2 gives this route no session_id, so the action row has none either.
    sessions.add_action(conn, sessions.action_session.get(), "stop_all", {},
                        {"paused": [a["id"] for a in out if a["state"] == "paused"]}, None)
    return out
