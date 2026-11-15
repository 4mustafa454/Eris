"""Pydantic models for the frozen shapes in AGENTS.md §5."""
from typing import Literal

from pydantic import BaseModel, Field, field_validator

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


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    instruction: str = Field(min_length=1, max_length=20000)
    agent_id: str | None = None
    session_id: str | None = None

    @field_validator('title', 'instruction')
    @classmethod
    def not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError('must not be blank')
        return value


class TaskPatch(BaseModel):
    status: Literal['queued', 'working', 'stuck', 'done', 'cancelled'] | None = None
    agent_id: str | None = None


class Approval(BaseModel):
    id: str
    agent_id: str
    action: str
    detail: str | None = None
    status: str
    session_id: str | None = None
    created_at: str
    decided_at: str | None = None


class ApprovalDecision(BaseModel):
    decision: Literal["approved", "denied"]
    session_id: str | None = None


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


# §5.3 logging rule: the caller logs only these; mutating tools are logged by the harness route.
ReadOnlyTool = Literal["get_status", "explain_agent", "show_grid", "focus_agent", "search_history"]


class ActionCreate(BaseModel):  # POST /sessions/{id}/actions
    tool: ReadOnlyTool
    args: dict
    result: dict | None = None
    agent_id: str | None = None


class SessionDetail(Session):
    messages: list[Message]
    actions: list[Action]


class TaskInstruction(BaseModel):  # POST /agents/{id}/task (§5.2)
    instruction: str = Field(min_length=1, max_length=20000)
    session_id: str | None = None

    @field_validator("instruction")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("instruction must not be blank")
        return value


class SessionRef(BaseModel):
    session_id: str | None = None


class SessionCreate(BaseModel):
    channel: Channel


class SessionPatch(BaseModel):
    ended_at: str | None = None
    summary: str | None = None
    title: str | None = None


class MessageCreate(BaseModel):
    role: Role
    text: str


class ChatRequest(BaseModel):
    session_id: str | None = None
    text: str = Field(min_length=1, max_length=20000)

    @field_validator('text')
    @classmethod
    def text_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError('text must not be blank')
        return value


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
