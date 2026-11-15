"""POST /agents/{id}/task and POST /stop-all (AGENTS.md §5.2, §5.2.1, §5.3 logging rule)."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from app import db, tasks
from app.config import Settings
from app.main import app
from app.models import AgentState
from app.workers.manager import WorkerManager

from fakes import FakeContainer, FakeSpawn


@pytest.fixture
def client(db_file):
    with TestClient(app) as c:
        yield c


@pytest.fixture
def sid(client):
    return client.post("/sessions", json={"channel": "facetime"}).json()["id"]


def sql(query, *args):
    conn = db.connect()
    try:
        return [dict(r) for r in conn.execute(query, args)]
    finally:
        conn.close()


def agent(client, agent_id):
    return client.get(f"/agents/{agent_id}").json()


def post(client, agent_id, instruction="do it", **extra):
    return client.post(f"/agents/{agent_id}/task", json={"instruction": instruction, **extra})


# --- steer vs new task (§5.2.1) ---------------------------------------------------------------------------------

def test_steering_a_working_agent_keeps_its_task(client):
    before = agent(client, "agent-1")
    r = post(client, "agent-1", "Also reject passwords shorter than 8 characters")
    assert r.status_code == 200
    body = AgentState(**r.json())
    assert body.state == "working" and body.task == before["task"]
    assert len(sql("SELECT id FROM tasks WHERE agent_id = 'agent-1'")) == 1, "steering never adds a task"
    assert "steered: Also reject passwords shorter than 8 characters" in client.get("/agents/agent-1/log").json()["lines"]


def test_steering_a_stuck_agent_unsticks_it_on_the_same_task(client):
    conn = db.connect()
    conn.execute("BEGIN")
    tasks.set_state(conn, "agent-1", "stuck", "Blocked: v1 or v2?", "v1 or v2?", db.utcnow())
    conn.execute("COMMIT")
    conn.close()
    assert agent(client, "agent-1")["state"] == "stuck"
    r = post(client, "agent-1", "Use the v2 endpoint")
    assert r.json()["state"] == "working" and r.json()["stuck_reason"] is None
    assert [t["status"] for t in sql("SELECT status FROM tasks WHERE agent_id = 'agent-1'")] == ["working"]


def test_a_done_agent_gets_a_new_task_titled_from_the_instruction(client):
    r = post(client, "agent-3", "Write docs for the billing module. Keep them short.")
    assert r.json()["state"] == "working" and r.json()["task"] == "Write docs for the billing module. Keep them short."
    assert [t["status"] for t in sql("SELECT status FROM tasks WHERE agent_id = 'agent-3' ORDER BY rowid")] == ["done", "working"]


def test_a_long_instruction_gets_a_short_title_for_a_new_task(client):
    instruction = "Add input validation to the signup endpoint so bad emails and short passwords are rejected " * 2
    r = post(client, "agent-3", instruction)
    assert len(r.json()["task"]) <= 60 and r.json()["task"].endswith("…")
    assert sql("SELECT instruction FROM tasks WHERE title = ?", r.json()["task"])[0]["instruction"] == instruction.strip()


# --- validation -------------------------------------------------------------------------------------------------

def test_unknown_agent_and_unknown_session_are_404_and_change_nothing(client):
    assert post(client, "agent-9").status_code == 404
    before = sql("SELECT * FROM tasks"), sql("SELECT * FROM events"), sql("SELECT state, updated_at FROM agents")
    r = post(client, "agent-3", "x", session_id="no-such-session")
    assert r.status_code == 404 and "unknown session" in r.json()["detail"]
    assert (sql("SELECT * FROM tasks"), sql("SELECT * FROM events"), sql("SELECT state, updated_at FROM agents")) == before


@pytest.mark.parametrize("body", [{}, {"instruction": ""}, {"instruction": "   \n\t "}, {"instruction": "x" * 20001},
                                  {"instruction": 5}, {"session_id": "s"}])
def test_bad_bodies_are_422_and_change_nothing(client, body):
    before = sql("SELECT * FROM tasks")
    assert client.post("/agents/agent-1/task", json=body).status_code == 422
    assert sql("SELECT * FROM tasks") == before


def test_the_instruction_is_trimmed(client):
    post(client, "agent-3", "   Fix the thing   ")
    assert sql("SELECT instruction FROM tasks WHERE agent_id = 'agent-3' ORDER BY rowid DESC LIMIT 1")[0]["instruction"] == "Fix the thing"


# --- the action row (§5.3: the harness logs mutating tools, once) ------------------------------------------------

def test_with_a_session_the_harness_writes_exactly_one_send_task_action(client, sid):
    post(client, "agent-1", "Use the v2 endpoint", session_id=sid)
    actions = client.get(f"/sessions/{sid}").json()["actions"]
    assert len(actions) == 1
    a = actions[0]
    assert a["tool"] == "send_task" and a["agent_id"] == "agent-1" and a["session_id"] == sid
    assert json.loads(a["args_json"]) == {"n": 1, "instruction": "Use the v2 endpoint"}
    result = json.loads(a["result_json"])
    assert result["kind"] == "steer" and result["state"] == "working" and result["task"]
    post(client, "agent-3", "Something new", session_id=sid)
    kinds = [json.loads(x["result_json"])["kind"] for x in client.get(f"/sessions/{sid}").json()["actions"]]
    assert kinds == ["steer", "new"]


def test_without_a_session_nothing_is_logged(client):
    post(client, "agent-1", "hello")
    assert sql("SELECT * FROM actions") == []


def test_a_failed_request_logs_nothing(client, sid):
    post(client, "agent-9", "x", session_id=sid)
    client.post("/agents/agent-1/task", json={"instruction": "", "session_id": sid})
    assert client.get(f"/sessions/{sid}").json()["actions"] == []


# --- stop-all ---------------------------------------------------------------------------------------------------

def test_stop_all_pauses_working_agents_keeps_tasks_and_logs_one_action_without_a_session(client):
    tasks_before = sql("SELECT id, status FROM tasks ORDER BY id")
    r = client.post("/stop-all")
    assert r.status_code == 200
    assert [AgentState(**a).state for a in r.json()] == ["paused", "paused", "done"]
    assert sql("SELECT id, status FROM tasks ORDER BY id") == tasks_before
    acts = sql("SELECT * FROM actions")
    assert len(acts) == 1 and acts[0]["tool"] == "stop_all" and acts[0]["session_id"] is None and acts[0]["agent_id"] is None
    assert json.loads(acts[0]["result_json"]) == {"paused": ["agent-1", "agent-2"]}
    assert [a["state"] for a in client.get("/agents").json()] == ["paused", "paused", "done"]


def test_stop_all_twice_is_harmless_and_a_steer_resumes_a_paused_agent(client):
    client.post("/stop-all")
    assert [a["state"] for a in client.post("/stop-all").json()] == ["paused", "paused", "done"]
    assert len(sql("SELECT * FROM actions WHERE tool = 'stop_all'")) == 2
    r = post(client, "agent-1", "Carry on")
    assert r.json()["state"] == "working" and len(sql("SELECT id FROM tasks WHERE agent_id = 'agent-1'")) == 1


def test_a_paused_mock_agent_is_left_alone_by_the_ticker(client):
    import random
    from app.workers import mock
    client.post("/stop-all")
    conn = db.connect()
    rng = random.Random(3)
    for _ in range(200):
        mock.tick_once(conn, rng)
    conn.close()
    states = {a["id"]: a["state"] for a in client.get("/agents").json()}
    assert states["agent-1"] == "paused" and states["agent-2"] == "paused"


# --- a real worker behind the routes (fakes, no Docker) ---------------------------------------------------------

def test_the_route_drives_a_real_worker_and_stop_all_interrupts_it(db_file, tmp_path, monkeypatch):
    monkeypatch.setenv("REAL_WORKERS", "agent-1")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "tok")
    monkeypatch.setenv("DEMO_REPO", str(tmp_path))
    spawn, interrupts = FakeSpawn(), []
    with TestClient(app) as c:
        settings = Settings(real_workers=("agent-1",), demo_repo=tmp_path, secret_name="CLAUDE_CODE_OAUTH_TOKEN")
        c.app.state.manager = WorkerManager(
            settings, spawn=spawn, container_factory=lambda a: FakeContainer(a, spawn, interrupts))
        assert agent(c, "agent-1")["state"] == "idle"
        r = post(c, "agent-1", "Run the tests and fix the failing one")
        assert r.status_code == 200 and r.json()["state"] == "working" and r.json()["task"].startswith("Run the tests")
        for _ in range(100):
            if spawn.argvs:
                break
            time.sleep(0.01)
        assert spawn.argvs[0][-2:] == ["--", "Run the tests and fix the failing one"] and "--resume" not in spawn.argvs[0]
        out = c.post("/stop-all").json()
        assert {a["id"]: a["state"] for a in out}["agent-1"] == "paused"
        assert interrupts and all(p.rc is not None for p in spawn.procs)


def test_list_tasks_returns_history_and_filters_by_status(client):
    all_tasks = client.get('/tasks')
    assert all_tasks.status_code == 200
    assert {t['agent_id'] for t in all_tasks.json()} == {'agent-1', 'agent-2', 'agent-3'}
    done = client.get('/tasks', params={'status': 'done'})
    assert done.status_code == 200
    assert all(t['status'] == 'done' for t in done.json())
    assert {t['agent_id'] for t in done.json()} == {'agent-3'}


def test_pause_resume_preserves_mock_task_and_logs_actions_once(client, sid):
    before = agent(client, 'agent-1')
    paused = client.post('/agents/agent-1/pause', json={'session_id': sid})
    assert paused.status_code == 200 and paused.json()['state'] == 'paused'
    assert paused.json()['task'] == before['task']
    resumed = client.post('/agents/agent-1/resume', json={'session_id': sid})
    assert resumed.status_code == 200 and resumed.json()['state'] == 'working'
    assert resumed.json()['task'] == before['task']
    assert [a['tool'] for a in client.get(f'/sessions/{sid}').json()['actions']] == ['pause_agent', 'resume_agent']


def test_pause_resume_rejects_unknown_session_or_agent(client):
    assert client.post('/agents/agent-9/pause', json={}).status_code == 404
    assert client.post('/agents/agent-1/resume', json={'session_id': 'missing'}).status_code == 404


def test_create_and_assign_tasks_follow_queue_rules(client, sid):
    first = client.post('/tasks', json={'title': 'First', 'instruction': 'Do first', 'agent_id': 'agent-1', 'session_id': sid})
    assert first.status_code == 200 and first.json()['status'] == 'queued'
    before = agent(client, 'agent-1')
    assert agent(client, 'agent-1')['task'] == before['task']
    unassigned = client.post('/tasks', json={'title': 'Next', 'instruction': 'Do next'}).json()
    assert unassigned['status'] == 'queued' and unassigned['agent_id'] is None
    assigned = client.patch('/tasks/' + unassigned['id'], json={'agent_id': 'agent-3'})
    assert assigned.status_code == 200 and assigned.json()['status'] == 'working'
    assert agent(client, 'agent-3')['task'] == 'Next'
    actions = client.get(f'/sessions/{sid}').json()['actions']
    assert len(actions) == 1 and actions[0]['tool'] == 'create_task'


def test_task_cancel_releases_agent_and_starts_oldest_queued(client):
    current = sql("SELECT task_id FROM agents WHERE id = 'agent-1'")[0]['task_id']
    queued = client.post('/tasks', json={'title': 'Queued', 'instruction': 'Next', 'agent_id': 'agent-1'}).json()
    result = client.patch('/tasks/' + current, json={'status': 'cancelled'})
    assert result.status_code == 200 and result.json()['status'] == 'cancelled'
    assert agent(client, 'agent-1')['task'] == 'Queued'
    assert sql('SELECT status FROM tasks WHERE id = ?', queued['id'])[0]['status'] == 'working'


def test_task_conflicts_and_validation_leave_work_intact(client):
    current = sql("SELECT task_id FROM agents WHERE id = 'agent-1'")[0]['task_id']
    assert client.patch('/tasks/' + current, json={'agent_id': 'agent-2'}).status_code == 409
    assert client.patch('/tasks/' + current, json={'status': 'queued'}).status_code == 409
    assert client.post('/tasks', json={'title': 'x', 'instruction': 'y', 'agent_id': 'agent-9'}).status_code == 404
    assert client.patch('/tasks/missing', json={'agent_id': 'agent-1'}).status_code == 404
    assert client.post('/tasks', json={'title': '  ', 'instruction': 'y'}).status_code == 422
    assert agent(client, 'agent-1')['task'] is not None
