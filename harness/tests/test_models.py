from app.models import AgentState, ContextResponse

EXAMPLE = {
    "id": "agent-1",
    "name": "Agent 1",
    "color": "#7F77DD",
    "engine": "claude-code",
    "state": "working",
    "task": "Add input validation to /signup",
    "summary": "Running tests after editing signup.py",
    "stuck_reason": None,
    "updated_at": "2026-11-14T19:02:11Z",
}


def test_agent_state_roundtrip():
    assert AgentState(**EXAMPLE).model_dump() == EXAMPLE


def test_context_keys():
    ctx = ContextResponse(
        recent_summaries=[], agents=[AgentState(**EXAMPLE)], open_tasks=[], pending_approvals=[]
    )
    assert set(ctx.model_dump()) == {
        "recent_summaries",
        "agents",
        "open_tasks",
        "pending_approvals",
    }
