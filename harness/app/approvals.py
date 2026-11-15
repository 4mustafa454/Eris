"""Internal approval creation (no public route; §5.2 has none)."""
import sqlite3
import uuid

from . import agents, db, tasks

AWAITING = 'Awaiting approval: '  # stuck_reason prefix; AgentState has no 'waiting' state (§4 is frozen)


def create_approval(conn: sqlite3.Connection, agent_id: str, action: str,
                    detail: str | None = None, session_id: str | None = None) -> dict:
    """Insert a pending approval. `/events` streams committed rows, so it reaches SSE, /approvals and /context."""
    approval_id = f'approval-{uuid.uuid4().hex[:8]}'
    conn.execute(
        "INSERT INTO approvals (id, agent_id, action, detail, status, session_id, created_at) "
        "VALUES (?, ?, ?, ?, 'pending', ?, ?)",
        (approval_id, agent_id, action, detail, session_id, db.utcnow()))
    # Like a worker blocked on a human: a working agent becomes stuck (the existing "needs input" state).
    agent = agents.get_agent(conn, agent_id)
    if agent is not None and agent['state'] == 'working' and tasks.has_live_task(conn, agent_id):
        reason = AWAITING + action
        tasks.set_state(conn, agent_id, 'stuck', reason, reason, db.utcnow())
        agents.add_event(conn, agent_id, 'stuck', f'waiting for approval: {action}')
    return dict(conn.execute('SELECT * FROM approvals WHERE id = ?', (approval_id,)).fetchone())


def steer_instruction(action: str, decision: str) -> str:
    if decision == 'approved':
        return f'Approved: {action}. Go ahead and continue.'
    return f'Denied: {action}. Do not do this; pick another approach or stop and say BLOCKED.'


def is_awaiting(agent: dict | None, action: str) -> bool:
    return bool(agent and agent['state'] == 'stuck' and agent['stuck_reason'] == AWAITING + action)
