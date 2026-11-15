import pytest
from fastapi.testclient import TestClient

from app import db, pm
from app.main import app


@pytest.fixture
def client(db_file):
    with TestClient(app) as c:
        yield c


def test_template_documents_placeholder_format():
    raw = (pm.PM_DIR / "system_prompt.md").read_text()
    assert raw.lstrip().startswith("<!--")
    head = raw[: raw.index("-->")]
    assert "{{name}}" in head and "replaceAll" in head
    # exactly one comment block: no stray comment markers after the header
    assert raw.count("-->") == 1


def test_template_has_both_placeholders_and_no_header():
    t = pm.load_template()
    assert not t.lstrip().startswith("<!--")
    assert "{{what_happened_last_time}}" in t and "{{current_state}}" in t
    assert t.startswith("You are Eris")


def test_render_empty_context():
    ctx = {"recent_summaries": [], "agents": [], "open_tasks": [], "pending_approvals": []}
    out = pm.render_prompt(ctx)
    assert "{{" not in out and "}}" not in out
    assert "No previous conversations." in out and "No agents." in out


def test_render_from_live_context(client):
    sid = client.post("/sessions", json={"channel": "facetime"}).json()["id"]
    client.patch(
        f"/sessions/{sid}",
        json={"ended_at": "2026-11-14T19:30:00Z", "summary": "Agent 3 renamed the package."},
    )
    conn = db.connect()
    conn.execute(
        "INSERT INTO approvals (id, agent_id, action, detail, status, created_at)"
        " VALUES ('ap-1', 'agent-1', 'git_push', 'push main', 'pending', ?)",
        (db.utcnow(),),
    )
    conn.execute(
        "UPDATE agents SET state='stuck', stuck_reason='Which endpoint, v1 or v2?' WHERE id='agent-1'"
    )
    conn.close()

    out = pm.render_prompt(client.get("/context").json())
    assert "{{" not in out and "}}" not in out
    assert "- [facetime, 2026-11-14T19:30:00Z] Agent 3 renamed the package." in out
    assert "- Agent 1 (stuck, claude-code): Add input validation to /signup." in out
    assert "BLOCKED: Which endpoint, v1 or v2?" in out
    assert "- Approval ap-1: Agent 1 wants to git_push (push main)" in out
    assert "agent-1" not in out.split("## Current state")[1].split("Approval")[0]  # ids stay hidden


def test_prompt_mentions_every_tool():
    out = pm.render_prompt(
        {"recent_summaries": [], "agents": [], "open_tasks": [], "pending_approvals": []}
    )
    for tool in pm.load_tools():
        if tool["name"] not in {"get_status", "resume_agent"}:  # covered in grouped sentences
            assert tool["name"] in out, tool["name"]
