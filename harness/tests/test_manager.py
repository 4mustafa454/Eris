"""WorkerManager with a fake spawner and a fake container: no Docker. Replays recorded stream-json runs."""
import asyncio
import pytest
from fastapi.testclient import TestClient

from app import agents, config, db, tasks
from app.config import ConfigError, Settings
from app.workers import docker, mock
from app.workers.manager import UnknownAgent, WorkerManager

from fakes import SID, TOKEN, FakeContainer, FakeProc, FakeSpawn, fixture  # noqa: E402,F401


@pytest.fixture
def world(db_file, tmp_path):
    """A DB seeded with agent-1 real (idle), agent-2 mock working, agent-3 mock done; and a manager on fakes."""
    conn = db.connect()
    mock.seed_agents(conn, real=("agent-1",))
    conn.close()
    settings = Settings(real_workers=("agent-1",), demo_repo=tmp_path, secret_name="CLAUDE_CODE_OAUTH_TOKEN")

    class World:
        pass

    w = World()
    w.spawn, w.interrupts, w.containers = FakeSpawn(), [], {}
    w.settings = settings

    def factory(agent_id):
        w.containers[agent_id] = FakeContainer(agent_id, w.spawn, w.interrupts)
        return w.containers[agent_id]

    w.manager = WorkerManager(settings, container_factory=factory, spawn=w.spawn, env={"CLAUDE_CODE_OAUTH_TOKEN": TOKEN})
    return w


def state(agent_id="agent-1"):
    conn = db.connect()
    try:
        return agents.get_agent(conn, agent_id)
    finally:
        conn.close()


def log(agent_id="agent-1", n=50):
    conn = db.connect()
    try:
        return agents.get_log(conn, agent_id, n)
    finally:
        conn.close()


def rows(sql, *args):
    conn = db.connect()
    try:
        return [dict(r) for r in conn.execute(sql, args)]
    finally:
        conn.close()


def task_rows(agent_id="agent-1"):
    return rows("SELECT * FROM tasks WHERE agent_id = ? ORDER BY rowid", agent_id)


def session(agent_id="agent-1"):
    return rows("SELECT engine_session FROM agents WHERE id = ?", agent_id)[0]["engine_session"]


async def until(cond, timeout=3.0):
    end = asyncio.get_running_loop().time() + timeout
    while not cond():
        assert asyncio.get_running_loop().time() < end, "timed out waiting"
        await asyncio.sleep(0.005)


def arun(coro):
    return asyncio.run(coro)


# --- seeding ----------------------------------------------------------------------------------------------------

def test_a_real_agent_is_seeded_idle_with_nothing_to_show(world):
    a = state("agent-1")
    assert a["state"] == "idle" and a["task"] is None and a["summary"] is None
    assert log("agent-1") == [] and task_rows("agent-1") == []
    assert state("agent-2")["state"] == "working" and state("agent-3")["state"] == "done"  # the mock ones as before


def test_the_mock_ticker_never_touches_a_real_agent(world):
    conn = db.connect()
    import random
    rng = random.Random(7)
    moved = {mock.tick_once(conn, rng, skip=frozenset({"agent-1"})) for _ in range(300)}
    conn.close()
    assert "agent-1" not in moved and moved <= {"agent-2", "agent-3"}
    assert state("agent-1")["state"] == "idle" and log("agent-1") == [] and task_rows("agent-1") == []
    conn = db.connect()
    assert mock.tick_once(conn, rng, skip=frozenset({"agent-1", "agent-2", "agent-3"})) is None
    conn.close()


# --- a new task -------------------------------------------------------------------------------------------------

def test_new_task_runs_streams_lines_and_finishes_done(world):
    async def main():
        m = world.manager
        s = await m.send_task("agent-1", "Run the tests and fix the failing one. Commit when green.")
        assert s["state"] == "working" and s["task"].startswith("Run the tests and fix the failing one")
        await until(lambda: world.spawn.procs)
        argv = world.spawn.argvs[0]
        assert "--resume" not in argv and argv[-2:] == ["--", "Run the tests and fix the failing one. Commit when green."]
        proc = world.spawn.procs[0]
        proc.say(*fixture("done_after_fix")[:5])  # up to the first pytest result and a read
        await until(lambda: "read shop/signup.py" in log())
        assert state()["state"] == "working" and session() == SID
        assert "run pytest → 1 failed" in log()
        proc.say(*fixture("done_after_fix")[5:])
        proc.end(0)
        await m.wait_idle("agent-1")

    arun(main())
    a = state()
    assert a["state"] == "done" and a["summary"].startswith("Added email validation") and a["stuck_reason"] is None
    assert log() == [
        "start task: Run the tests and fix the failing one. Commit when green.",
        "run pytest → 1 failed", "read shop/signup.py", "edit shop/signup.py",
        "run pytest → 4 passed", "git commit", "grep def signup",
        "done: Added email validation to signup(); all 4 tests pass and the change is…",
    ]
    t = task_rows()
    assert len(t) == 1 and t[0]["status"] == "done" and t[0]["instruction"].startswith("Run the tests")
    assert [e["type"] for e in rows("SELECT type FROM events WHERE agent_id='agent-1' ORDER BY id")][-1] == "done"


def test_blocked_marks_the_agent_stuck_with_the_question(world):
    async def main():
        await world.manager.send_task("agent-1", "Register new users with the partner API")
        await until(lambda: world.spawn.procs)
        world.spawn.procs[0].say(*fixture("blocked"))
        world.spawn.procs[0].end(0)
        await world.manager.wait_idle("agent-1")

    arun(main())
    a = state()
    assert a["state"] == "stuck" and a["stuck_reason"] == "which endpoint, v1 or v2?"
    assert a["summary"] == "Blocked: which endpoint, v1 or v2?"
    assert task_rows()[0]["status"] == "stuck"
    assert log()[-1] == "BLOCKED: which endpoint, v1 or v2?"
    assert rows("SELECT type FROM events WHERE agent_id='agent-1' ORDER BY id DESC LIMIT 1")[0]["type"] == "stuck"


def test_max_turns_is_stuck_and_an_error_result_is_error(world):
    async def run_fixture(name):
        await world.manager.send_task("agent-1", "go")
        await until(lambda: world.spawn.procs)
        world.spawn.procs[-1].say(*fixture(name))
        world.spawn.procs[-1].end(0)
        await world.manager.wait_idle("agent-1")

    arun(run_fixture("max_turns"))
    a = state()
    assert a["state"] == "stuck" and a["stuck_reason"] == "ran out of turns"
    assert log()[-1] == "stuck: ran out of turns" and task_rows()[0]["status"] == "stuck"

    # steering resumes the same task; this time the run ends with an API error
    async def steer_into_error():
        await world.manager.send_task("agent-1", "keep going")
        await until(lambda: len(world.spawn.procs) == 2)
        world.spawn.procs[1].say(*fixture("error_result"))
        world.spawn.procs[1].end(1)
        await world.manager.wait_idle("agent-1")

    arun(steer_into_error())
    a = state()
    assert a["state"] == "error" and "API Error: 529 overloaded" in a["stuck_reason"]
    assert log()[-1].startswith("error: API Error: 529")
    assert task_rows()[0]["status"] == "stuck", "an errored agent still has its one live, steerable task"


def test_a_crash_without_a_result_is_an_error_with_the_exit_code_and_a_redacted_stderr_tail(world):
    async def main():
        await world.manager.send_task("agent-1", "go")
        await until(lambda: world.spawn.procs)
        world.spawn.procs[0].stderr_tail = f"line\nauth failed for {TOKEN}\n"
        world.spawn.procs[0].end(137)
        await world.manager.wait_idle("agent-1")

    arun(main())
    a = state()
    assert a["state"] == "error" and "exit code 137" in a["stuck_reason"]
    assert TOKEN not in str(rows("SELECT * FROM agents")) + str(rows("SELECT * FROM events"))
    assert "[redacted]" in a["stuck_reason"]


def test_a_real_captured_run_replays_to_an_error_state_with_claudes_message(world):
    """The auth-failure stream captured from the real container (Claude Code 2.1.316), token redacted."""
    async def main():
        await world.manager.send_task("agent-1", "Run the tests and fix the failing one")
        await until(lambda: world.spawn.procs)
        world.spawn.procs[0].say(*fixture("auth_error_real"))
        world.spawn.procs[0].end(1)
        await world.manager.wait_idle("agent-1")

    arun(main())
    a = state()
    assert a["state"] == "error" and a["stuck_reason"] == "Failed to authenticate. API Error: 401 Invalid bearer token"
    assert session() == "a7475922-8c91-4ae9-8c07-1e942c308ea7"
    assert log()[-1] == "error: Failed to authenticate. API Error: 401 Invalid bearer token"
    assert task_rows()[0]["status"] == "stuck", "the task stays steerable"


def test_docker_trouble_is_an_error_state_not_a_hang(world):
    async def main():
        world.manager._containers["agent-1"] = FakeContainer(
            "agent-1", world.spawn, world.interrupts, ensure_error=docker.WorkerError("docker is not installed or not on PATH"))
        await world.manager.send_task("agent-1", "go")
        await world.manager.wait_idle("agent-1")

    arun(main())
    a = state()
    assert a["state"] == "error" and a["stuck_reason"] == "docker is not installed or not on PATH"
    assert world.spawn.procs == [] and log()[-1] == "error: docker is not installed or not on PATH"


def test_secrets_in_the_stream_never_reach_the_database(world):
    async def main():
        await world.manager.send_task("agent-1", "go")
        await until(lambda: world.spawn.procs)
        world.spawn.procs[0].say(
            f'{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"a","name":"Bash","input":{{"command":"echo {TOKEN}"}}}}]}}}}',
            f'{{"type":"result","subtype":"success","is_error":false,"result":"The key is {TOKEN}. Done."}}',
        )
        world.spawn.procs[0].end(0)
        await world.manager.wait_idle("agent-1")

    arun(main())
    dump = str(rows("SELECT * FROM agents")) + str(rows("SELECT * FROM events")) + str(rows("SELECT * FROM tasks"))
    assert TOKEN not in dump and "[redacted]" in dump


# --- steering ---------------------------------------------------------------------------------------------------

def test_steering_a_stuck_agent_resumes_the_same_session_and_task(world):
    async def main():
        m = world.manager
        await m.send_task("agent-1", "Register new users with the partner API")
        await until(lambda: world.spawn.procs)
        world.spawn.procs[0].say(*fixture("blocked"))
        world.spawn.procs[0].end(0)
        await m.wait_idle("agent-1")
        assert state()["state"] == "stuck" and session() == SID
        s = await m.send_task("agent-1", "Use the v2 endpoint")
        assert s["state"] == "working" and s["stuck_reason"] is None
        await until(lambda: len(world.spawn.procs) == 2)
        argv = world.spawn.argvs[1]
        assert argv[argv.index("--resume") + 1] == SID and argv[-2:] == ["--", "Use the v2 endpoint"]
        world.spawn.procs[1].say(*fixture("done_after_fix"))
        world.spawn.procs[1].end(0)
        await m.wait_idle("agent-1")

    arun(main())
    assert world.interrupts == [], "nothing was running, so nothing needed interrupting"
    assert len(task_rows()) == 1 and task_rows()[0]["status"] == "done", "same task row, no new task"
    assert state()["state"] == "done"
    assert "steered: Use the v2 endpoint" in log()


def test_steering_mid_run_interrupts_inside_the_container_then_resumes_and_ignores_the_dying_run(world):
    async def main():
        m = world.manager
        await m.send_task("agent-1", "Add input validation to /signup")
        await until(lambda: world.spawn.procs)
        first = world.spawn.procs[0]
        first.say(*fixture("done_after_fix")[:3])
        await until(lambda: session() == SID)
        # the dying run still manages to emit a final "done" result after the interrupt: it must change nothing
        world.containers["agent-1"].late = fixture("done_after_fix")[-1:]
        s = await m.send_task("agent-1", "Wait, also reject passwords shorter than 8 characters")
        assert world.interrupts == ["agent-1", "agent-1"] and first.rc == 130  # the interrupt, then the final sweep
        assert s["state"] == "working"
        await until(lambda: len(world.spawn.procs) == 2)
        argv = world.spawn.argvs[1]
        assert argv[argv.index("--resume") + 1] == SID
        assert argv[-1] == "Wait, also reject passwords shorter than 8 characters"
        await asyncio.sleep(0.05)
        a = state()
        assert a["state"] == "working", "the interrupted run's late result was ignored"
        assert task_rows()[0]["status"] == "working"
        world.spawn.procs[1].say(*fixture("done_after_fix")[-1:])
        world.spawn.procs[1].end(0)
        await m.wait_idle("agent-1")

    arun(main())
    assert len(task_rows()) == 1 and state()["state"] == "done"


def test_two_task_requests_at_once_are_serialised_the_second_one_steers(world):
    async def main():
        await asyncio.gather(
            world.manager.send_task("agent-1", "first instruction"),
            world.manager.send_task("agent-1", "second instruction"),
        )
        await until(lambda: any(a[-1] == "second instruction" for a in world.spawn.argvs))
        for proc in world.spawn.procs:
            proc.end(0)
        await world.manager.wait_idle("agent-1")

    arun(main())
    assert len(task_rows()) == 1 and task_rows()[0]["instruction"] == "first instruction"
    live = [p for p, a in zip(world.spawn.procs, world.spawn.argvs) if p.rc is None]
    assert live == [], "nothing is left running"


def test_stop_all_right_after_a_task_leaves_nothing_running(world):
    async def main():
        await world.manager.send_task("agent-1", "go")   # the run task is created but has not started yet
        out = await world.manager.stop_all()
        await asyncio.sleep(0.05)
        return out

    out = arun(main())
    assert all(p.rc is not None for p in world.spawn.procs), "whatever started was stopped"
    assert {a["id"]: a["state"] for a in out}["agent-1"] == "paused"
    assert not world.manager.is_running("agent-1")


def test_a_run_stopped_before_it_gets_to_spawn_never_spawns(world):
    class SlowEnsure(FakeContainer):
        async def ensure(self):
            await asyncio.sleep(0.05)  # e.g. `docker run` creating the container

    async def main():
        world.manager._containers["agent-1"] = SlowEnsure("agent-1", world.spawn, world.interrupts)
        await world.manager.send_task("agent-1", "go")
        await asyncio.sleep(0.01)     # the run is inside ensure()
        await world.manager.stop_all()
        await asyncio.sleep(0.1)

    arun(main())
    assert world.spawn.procs == [], "claude must not start after a stop"
    assert state()["state"] == "paused"


def test_a_stop_that_lands_while_the_process_is_starting_interrupts_again(world):
    class SlowSpawn(FakeSpawn):
        async def __call__(self, argv):
            await asyncio.sleep(0.05)  # `docker exec` takes a moment to start
            return await super().__call__(argv)

    world.spawn.__class__ = SlowSpawn

    async def main():
        await world.manager.send_task("agent-1", "go")
        await asyncio.sleep(0.01)  # ensure() done, spawn in flight
        await world.manager.stop_all()
        await asyncio.sleep(0.1)

    arun(main())
    assert all(p.rc is not None for p in world.spawn.procs), "whatever started was stopped"
    assert state()["state"] == "paused"


# --- the queue --------------------------------------------------------------------------------------------------

def test_when_a_task_finishes_the_next_queued_one_starts_with_a_fresh_session(world):
    async def main():
        m = world.manager
        await m.send_task("agent-1", "First task")
        await until(lambda: world.spawn.procs)
        conn = db.connect()
        conn.execute("BEGIN")
        status = tasks.add_task(conn, "agent-1", "Second", "Do the second thing", db.utcnow(), "task-q")
        conn.execute("COMMIT")
        conn.close()
        assert status == "queued" and state()["task"] == "First task"  # a busy agent's new task waits
        world.spawn.procs[0].say(*fixture("done_after_fix"))
        world.spawn.procs[0].end(0)
        await until(lambda: len(world.spawn.procs) == 2)
        argv = world.spawn.argvs[1]
        assert "--resume" not in argv and argv[-1] == "Do the second thing"
        assert state()["task"] == "Second" and state()["state"] == "working" and session() is None
        world.spawn.procs[1].say(*fixture("blocked"))
        world.spawn.procs[1].end(0)
        await m.wait_idle("agent-1")

    arun(main())
    assert [(t["title"], t["status"]) for t in task_rows()] == [("First task", "done"), ("Second", "stuck")]


# --- stop-all and recovery --------------------------------------------------------------------------------------

def test_stop_all_interrupts_every_run_and_pauses_working_agents_but_keeps_their_tasks(world):
    async def main():
        m = world.manager
        await m.send_task("agent-1", "Add input validation to /signup")
        await until(lambda: world.spawn.procs)
        world.spawn.procs[0].say(*fixture("done_after_fix")[:2])
        await until(lambda: session() == SID)
        before = {t["id"]: t["status"] for t in rows("SELECT id, status FROM tasks")}
        out = await m.stop_all()
        by = {a["id"]: a["state"] for a in out}
        assert by == {"agent-1": "paused", "agent-2": "paused", "agent-3": "done"}
        assert "agent-1" in world.interrupts and world.spawn.procs[0].rc == 130
        assert {t["id"]: t["status"] for t in rows("SELECT id, status FROM tasks")} == before, "tasks are untouched"
        assert "stopped" in log("agent-1")
        # a steer after stop-all resumes the same session
        await m.send_task("agent-1", "Carry on")
        await until(lambda: len(world.spawn.procs) == 2)
        assert world.spawn.argvs[1][world.spawn.argvs[1].index("--resume") + 1] == SID
        assert state()["state"] == "working"
        world.spawn.procs[1].end(0)
        await m.wait_idle("agent-1")

    arun(main())


def test_stop_all_with_nothing_running_still_works_and_survives_a_dead_container(world):
    async def main():
        world.manager._containers["agent-1"] = FakeContainer("agent-1", world.spawn, world.interrupts)

        async def boom():
            raise docker.WorkerError("docker is not installed or not on PATH")

        world.manager._containers["agent-1"].interrupt = boom
        out = await world.manager.stop_all()
        return {a["id"]: a["state"] for a in out}

    assert arun(main()) == {"agent-1": "idle", "agent-2": "paused", "agent-3": "done"}


def test_recover_marks_a_run_the_harness_lost_as_stuck_and_stops_stray_runs(world):
    conn = db.connect()
    conn.execute("BEGIN")
    tasks.add_task(conn, "agent-1", "Lost run", "do it", db.utcnow(), "task-lost")
    conn.execute("COMMIT")
    conn.close()
    assert state()["state"] == "working"

    async def main():
        await WorkerManager(world.settings, container_factory=lambda a: FakeContainer(a, world.spawn, world.interrupts),
                            spawn=world.spawn).recover()

    arun(main())
    a = state()
    assert a["state"] == "stuck" and a["stuck_reason"] == "harness restarted during this run"
    assert task_rows()[0]["status"] == "stuck" and world.interrupts == ["agent-1"]
    assert state("agent-2")["state"] == "working", "mock agents are not touched"


# --- mock agents use the same rules, with no process ------------------------------------------------------------

def test_mock_agents_get_the_same_task_semantics_without_a_process(world):
    async def main():
        m = world.manager
        s = await m.send_task("agent-3", "Write docs for the billing module")  # done → a new task starts now
        assert s["state"] == "working" and s["task"] == "Write docs for the billing module"
        s = await m.send_task("agent-2", "Also cover the discount code")  # working → steer, same task
        assert s["state"] == "working" and s["task"] == "Write tests for the billing module"

    arun(main())
    assert world.spawn.procs == [] and world.interrupts == []
    assert len(task_rows("agent-2")) == 1 and [t["status"] for t in task_rows("agent-3")] == ["done", "working"]


def test_unknown_agent(world):
    with pytest.raises(UnknownAgent):
        arun(world.manager.send_task("agent-9", "x"))


# --- the app lifespan -------------------------------------------------------------------------------------------

def test_the_app_starts_with_a_real_worker_even_when_docker_is_missing(db_file, tmp_path, monkeypatch):
    from app.main import app
    monkeypatch.setenv("REAL_WORKERS", "agent-1")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN)
    monkeypatch.setenv("DEMO_REPO", str(tmp_path))
    monkeypatch.setenv("PATH", str(tmp_path))  # no docker binary anywhere
    with TestClient(app) as c:
        by = {a["id"]: a["state"] for a in c.get("/agents").json()}
        assert by["agent-1"] == "idle" and by["agent-2"] == "working"
        assert c.app.state.settings.real_workers == ("agent-1",)


def test_a_bad_real_workers_setting_stops_startup_naming_the_variable(db_file, monkeypatch):
    from app.main import app
    monkeypatch.setenv("REAL_WORKERS", "agent-9")
    with pytest.raises(ConfigError, match="REAL_WORKERS"):
        with TestClient(app):
            pass
