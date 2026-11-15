import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import app


@pytest.fixture
def client(db_file):
    with TestClient(app) as c:
        yield c


def _ended_session(client, n, summary="summary"):
    sid = client.post("/sessions", json={"channel": "facetime"}).json()["id"]
    body = {"ended_at": f"2026-11-14T19:{n:02d}:00Z"}
    if summary is not None:
        body["summary"] = f"{summary} {n}"
    client.patch(f"/sessions/{sid}", json=body)
    return sid


def test_fresh_context_has_all_keys(client):
    ctx = client.get("/context").json()
    assert set(ctx) == {"recent_summaries", "agents", "open_tasks", "pending_approvals"}
    assert ctx["recent_summaries"] == [] and ctx["pending_approvals"] == []
    assert [a["id"] for a in ctx["agents"]] == ["agent-1", "agent-2", "agent-3"]


def test_open_tasks_exclude_done(client):
    tasks = client.get("/context").json()["open_tasks"]
    assert sorted(t["id"] for t in tasks) == ["task-1", "task-2"]  # task-3 is done
    assert all(t["status"] in {"queued", "working", "stuck"} for t in tasks)


def test_only_five_newest_summaries(client):
    ids = [_ended_session(client, n) for n in range(1, 7)]
    recent = client.get("/context").json()["recent_summaries"]
    assert [r["session_id"] for r in recent] == list(reversed(ids[1:]))  # newest first, oldest dropped
    assert set(recent[0]) == {"session_id", "channel", "summary", "ended_at"}
    assert recent[0]["summary"] == "summary 6"


def test_unsummarized_or_unended_excluded(client):
    good = _ended_session(client, 1)
    _ended_session(client, 2, summary=None)  # ended, no summary
    sid = client.post("/sessions", json={"channel": "web"}).json()["id"]
    client.patch(f"/sessions/{sid}", json={"summary": "never ended"})  # summary, not ended
    client.post("/sessions", json={"channel": "web"})  # untouched
    recent = client.get("/context").json()["recent_summaries"]
    assert [r["session_id"] for r in recent] == [good]


def test_pending_approvals_only(client, db_file):
    conn = db.connect()
    now = db.utcnow()
    for aid, status in [("ap-1", "pending"), ("ap-2", "approved"), ("ap-3", "denied")]:
        conn.execute(
            "INSERT INTO approvals (id, agent_id, action, detail, status, created_at)"
            " VALUES (?, 'agent-1', 'git_push', 'push main', ?, ?)",
            (aid, status, now),
        )
    conn.close()
    pending = client.get("/context").json()["pending_approvals"]
    assert [a["id"] for a in pending] == ["ap-1"]
    assert pending[0]["action"] == "git_push"
