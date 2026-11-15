import json

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client(db_file):
    with TestClient(app) as c:
        yield c


@pytest.fixture
def sid(client):
    return client.post("/sessions", json={"channel": "facetime"}).json()["id"]


def test_log_read_only_action(client, sid):
    r = client.post(
        f"/sessions/{sid}/actions",
        json={"tool": "explain_agent", "args": {"n": 2}, "result": {"lines": ["a"]},
              "agent_id": "agent-2"},
    )
    assert r.status_code == 200
    a = r.json()
    assert a["session_id"] == sid and a["agent_id"] == "agent-2" and a["tool"] == "explain_agent"
    assert json.loads(a["args_json"]) == {"n": 2}
    assert json.loads(a["result_json"]) == {"lines": ["a"]}
    assert a["created_at"].endswith("Z")


def test_null_result_and_no_agent(client, sid):
    r = client.post(f"/sessions/{sid}/actions", json={"tool": "get_status", "args": {}, "result": None})
    assert r.status_code == 200
    assert r.json()["result_json"] is None and r.json()["agent_id"] is None


def test_actions_show_in_session_detail_in_order(client, sid):
    for tool in ("get_status", "focus_agent", "show_grid"):
        client.post(f"/sessions/{sid}/actions", json={"tool": tool, "args": {}})
    actions = client.get(f"/sessions/{sid}").json()["actions"]
    assert [a["tool"] for a in actions] == ["get_status", "focus_agent", "show_grid"]


def test_mutating_tools_rejected(client, sid):
    # log-once rule: the harness route for a mutating tool writes its own action row
    for tool in ("send_task", "pause_agent", "resume_agent", "stop_all", "create_task",
                 "decide_approval", "made_up"):
        r = client.post(f"/sessions/{sid}/actions", json={"tool": tool, "args": {}})
        assert r.status_code == 422, tool
    assert client.get(f"/sessions/{sid}").json()["actions"] == []


def test_validation(client, sid):
    assert client.post(f"/sessions/{sid}/actions", json={"tool": "get_status"}).status_code == 422
    assert client.post(
        f"/sessions/{sid}/actions", json={"tool": "get_status", "args": [1]}
    ).status_code == 422
    r = client.post(
        f"/sessions/{sid}/actions", json={"tool": "explain_agent", "args": {"n": 9},
                                          "agent_id": "agent-9"}
    )
    assert r.status_code == 422


def test_unknown_session_404(client):
    r = client.post("/sessions/nope/actions", json={"tool": "get_status", "args": {}})
    assert r.status_code == 404
