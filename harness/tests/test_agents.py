import random

import pytest

from app import agents
from app.models import AgentState
from app.workers import mock


@pytest.fixture
def seeded(conn):
    mock.seed_agents(conn)
    return conn


def test_seed_is_idempotent(conn):
    mock.seed_agents(conn)
    mock.seed_agents(conn)
    assert conn.execute("SELECT COUNT(*) FROM agents").fetchone()[0] == 3
    assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 3
    assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 11
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_agent_shape(seeded):
    listed = agents.list_agents(seeded)
    assert [a["id"] for a in listed] == ["agent-1", "agent-2", "agent-3"]
    for a in listed:
        AgentState(**a)  # matches §5.1
        assert set(a) == {
            "id", "name", "color", "engine", "state", "task",
            "summary", "stuck_reason", "updated_at",
        }
    a1 = agents.get_agent(seeded, "agent-1")
    assert a1["color"] == "#7F77DD"
    assert a1["task"] == "Add input validation to /signup"  # task title, not id


def test_unknown_agent(seeded):
    assert agents.get_agent(seeded, "agent-9") is None
    assert agents.get_log(seeded, "agent-9") is None


def test_log_newest_last_and_limit(seeded):
    assert agents.get_log(seeded, "agent-1")[-1] == "edit signup.py"
    assert agents.get_log(seeded, "agent-1", lines=2) == ["run pytest → 2 failed", "edit signup.py"]


def test_events_pruned_per_agent(seeded):
    for i in range(agents.EVENTS_PER_AGENT + 20):
        agents.add_event(seeded, "agent-2", "line", f"line {i}")
    count = seeded.execute("SELECT COUNT(*) FROM events WHERE agent_id='agent-2'").fetchone()[0]
    assert count == agents.EVENTS_PER_AGENT
    assert agents.get_log(seeded, "agent-1")  # other agents untouched


def test_ticker_invariants(seeded):
    rng = random.Random(7)
    before = seeded.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    for _ in range(300):
        mock.tick_once(seeded, rng)
        for a in agents.list_agents(seeded):
            assert a["state"] in {"working", "stuck", "done"}
            assert (a["state"] == "stuck") == (a["stuck_reason"] is not None)
            assert a["task"] is not None
    assert seeded.execute("SELECT COUNT(*) FROM events").fetchone()[0] > before
    # task status mirrors the agent state
    rows = seeded.execute(
        "SELECT a.state, t.status FROM agents a JOIN tasks t ON t.id = a.task_id"
    ).fetchall()
    assert all(r["state"] == r["status"] for r in rows)
    assert seeded.execute("PRAGMA foreign_key_check").fetchall() == []


def test_ticker_off_by_default(monkeypatch):
    monkeypatch.delenv("MOCK_TICK", raising=False)
    assert not mock.ticker_enabled()
    monkeypatch.setenv("MOCK_TICK", "1")
    assert mock.ticker_enabled()
