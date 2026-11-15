import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import AgentState


@pytest.fixture
def client(db_file):
    with TestClient(app) as c:
        yield c


def test_list_agents(client):
    r = client.get("/agents")
    assert r.status_code == 200
    body = r.json()
    assert [a["id"] for a in body] == ["agent-1", "agent-2", "agent-3"]
    for a in body:
        AgentState(**a)


def test_get_agent(client):
    r = client.get("/agents/agent-2")
    assert r.status_code == 200
    assert r.json()["name"] == "Agent 2"


def test_unknown_agent_404(client):
    assert client.get("/agents/agent-9").status_code == 404
    assert client.get("/agents/agent-9/log").status_code == 404


def test_log(client):
    r = client.get("/agents/agent-1/log", params={"lines": 2})
    assert r.status_code == 200
    assert r.json() == {"lines": ["run pytest → 2 failed", "edit signup.py"]}
    assert client.get("/agents/agent-1/log", params={"lines": 0}).status_code == 422


def test_ticker_runs_in_lifespan(db_file, monkeypatch):
    monkeypatch.setenv("MOCK_TICK", "1")
    monkeypatch.setenv("MOCK_TICK_SECONDS", "0.5")
    with TestClient(app) as c:
        assert c.get("/agents").status_code == 200
