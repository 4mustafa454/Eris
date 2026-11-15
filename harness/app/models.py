"""Pydantic models for the frozen shapes in AGENTS.md §5."""
from typing import Literal

from pydantic import BaseModel

Channel = Literal["facetime", "web", "imessage"]
Role = Literal["user", "pm", "system"]
AgentStateName = Literal["idle", "working", "stuck", "done", "error", "paused"]


class AgentState(BaseModel):  # §5.1
    id: str
    name: str
    color: str
    engine: str
    state: AgentStateName
    task: str | None = None  # task title, not id
    summary: str | None = None
    stuck_reason: str | None = None
    updated_at: str


class Task(BaseModel):
    id: str
    agent_id: str | None = None
    title: str
    instruction: str
    status: str
    created_at: str
    updated_at: str


class Approval(BaseModel):
    id: str
    agent_id: str
    action: str
    detail: str | None = None
    status: str
    session_id: str | None = None
    created_at: str
    decided_at: str | None = None


class Session(BaseModel):
    id: str
    channel: Channel
    title: str | None = None
    summary: str | None = None
    started_at: str
    ended_at: str | None = None


class Message(BaseModel):
    id: int
    session_id: str
    role: Role
    text: str
    created_at: str


class Action(BaseModel):
    id: int
    session_id: str | None = None
    agent_id: str | None = None
    tool: str
    args_json: str
    result_json: str | None = None
    created_at: str


class SessionDetail(Session):
    messages: list[Message]
    actions: list[Action]


class SessionCreate(BaseModel):
    channel: Channel


class SessionPatch(BaseModel):
    ended_at: str | None = None
    summary: str | None = None
    title: str | None = None


class MessageCreate(BaseModel):
    role: Role
    text: str


class RecentSummary(BaseModel):
    session_id: str
    channel: Channel
    summary: str
    ended_at: str | None = None


class LogResponse(BaseModel):
    lines: list[str]


class ContextResponse(BaseModel):  # §5.2 GET /context
    recent_summaries: list[RecentSummary]
    agents: list[AgentState]
    open_tasks: list[Task]
    pending_approvals: list[Approval]
