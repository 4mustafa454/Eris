import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import agents
from ..deps import get_conn
from ..models import AgentState, LogResponse

router = APIRouter()


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
