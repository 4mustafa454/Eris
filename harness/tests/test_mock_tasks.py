"""Mock ticker vs AGENTS.md §5.2.1 (task semantics)."""
import itertools
import random
from datetime import datetime, timedelta, timezone

import pytest

from app import agents, db
from app.workers import mock

# every task status change the ticker may make; anything else overwrites or reopens work
ALLOWED = {("queued", "working"), ("working", "stuck"), ("stuck", "working"), ("working", "done")}


@pytest.fixture
def seeded(conn):
    mock.seed_agents(conn)
    return conn


@pytest.fixture
def clock(monkeypatch):
    """Strictly increasing utcnow(), so created_at order is unambiguous."""
    counter = itertools.count()
    base = datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(
        db, "utcnow",
        lambda: (base + timedelta(seconds=next(counter))).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


def _queue(conn, task_id, agent_id, title, created_at):
    conn.execute(
        "INSERT INTO tasks (id, agent_id, title, instruction, status, created_at, updated_at)"
        " VALUES (?, ?, ?, 'do it', 'queued', ?, ?)",
        (task_id, agent_id, title, created_at, created_at),
    )


def _status(conn, task_id):
    return conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()[0]


def _check_invariants(conn):
    for a in conn.execute("SELECT id, state, task_id FROM agents").fetchall():
        tasks = conn.execute("SELECT * FROM tasks WHERE agent_id = ?", (a["id"],)).fetchall()
        live = [t for t in tasks if t["status"] in ("working", "stuck")]
        queued = [t for t in tasks if t["status"] == "queued"]
        assert len(live) <= 1, f"{a['id']} has {len(live)} working/stuck tasks"
        assert len(queued) <= mock.MAX_QUEUED_PER_AGENT

        current = next((t for t in tasks if t["id"] == a["task_id"]), None)
        assert current is not None, f"{a['id']}.task_id does not point at one of its tasks"
        assert current["status"] == a["state"]  # task status mirrors the agent state
        if a["state"] in ("working", "stuck"):
            assert [t["id"] for t in live] == [a["task_id"]]
        else:  # done: nothing live, and the queue must already have started
            assert live == [] and queued == []
    open_titles = [
        r[0] for r in conn.execute(
            "SELECT title FROM tasks WHERE status IN ('queued', 'working', 'stuck')")
    ]
    assert len(open_titles) == len(set(open_titles)), "same title open on two agents"
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_invariants_and_queue_order_over_many_ticks(seeded, clock):
    rng = random.Random(1234)
    snap = lambda: {  # noqa: E731
        r["id"]: (r["status"], r["agent_id"])
        for r in seeded.execute("SELECT id, status, agent_id FROM tasks")
    }
    before = snap()
    started: dict[str, list[str]] = {}  # agent → task ids that started from the queue, in order
    queued_created = 0

    for _ in range(3000):
        mock.tick_once(seeded, rng)
        after = snap()
        for tid, (status, agent_id) in after.items():
            if tid not in before:
                queued_created += status == "queued"
            elif before[tid][0] != status:
                assert (before[tid][0], status) in ALLOWED, (tid, before[tid][0], status)
                if before[tid][0] == "queued":
                    started.setdefault(agent_id, []).append(tid)
        _check_invariants(seeded)
        before = after

    assert queued_created > 10 and sum(map(len, started.values())) > 10  # the paths ran
    open_count = seeded.execute(
        "SELECT COUNT(*) FROM tasks WHERE status IN ('queued', 'working', 'stuck')"
    ).fetchone()[0]
    assert open_count <= 3 * (1 + mock.MAX_QUEUED_PER_AGENT)  # queue stays bounded

    order = {
        r["id"]: (r["created_at"], r["rowid"])
        for r in seeded.execute("SELECT id, created_at, rowid FROM tasks")
    }
    for agent_id, ids in started.items():
        assert ids == sorted(ids, key=order.get), f"{agent_id} queue did not run in created_at order"


def test_queued_tasks_start_in_created_at_order_after_current_finishes(seeded):
    # inserted out of created_at order on purpose: rowid order must not decide
    _queue(seeded, "q-late", "agent-1", "Late", "2026-11-14T12:00:09Z")
    _queue(seeded, "q-mid", "agent-1", "Mid", "2026-11-14T12:00:05Z")
    _queue(seeded, "q-early", "agent-1", "Early", "2026-11-14T12:00:01Z")

    # while task-1 is working, nothing queued may start (and ticks never touch task-1's row)
    assert mock.start_next_queued(seeded, "agent-1", db.utcnow()) is None
    assert _status(seeded, "task-1") == "working"
    assert [_status(seeded, t) for t in ("q-early", "q-mid", "q-late")] == ["queued"] * 3

    for expected_started, expected_finished in [
        ("q-early", "task-1"), ("q-mid", "q-early"), ("q-late", "q-mid")
    ]:
        started = mock.complete_task(seeded, "agent-1", db.utcnow())
        assert started[0] == expected_started
        assert _status(seeded, expected_finished) == "done"
        a = agents.get_agent(seeded, "agent-1")
        assert a["state"] == "working"
        assert seeded.execute("SELECT task_id FROM agents WHERE id='agent-1'").fetchone()[0] == expected_started
        live = seeded.execute(
            "SELECT COUNT(*) FROM tasks WHERE agent_id='agent-1' AND status IN ('working','stuck')"
        ).fetchone()[0]
        assert live == 1

    assert mock.complete_task(seeded, "agent-1", db.utcnow()) is None  # queue drained
    a = agents.get_agent(seeded, "agent-1")
    assert a["state"] == "done" and a["task"] == "Late"  # task_id stays on the last task


def test_new_task_for_busy_agent_is_queued_not_started(seeded, clock):
    task_id, title, status = mock.enqueue_task(seeded, "agent-1", random.Random(1), db.utcnow())
    assert status == "queued" and _status(seeded, task_id) == "queued"
    a1 = agents.get_agent(seeded, "agent-1")
    assert a1["state"] == "working" and a1["task"] == "Add input validation to /signup"
    assert _status(seeded, "task-1") == "working"  # never overwritten


def test_new_task_for_done_agent_starts_now(seeded, clock):
    task_id, title, status = mock.enqueue_task(seeded, "agent-3", random.Random(1), db.utcnow())
    assert status == "working"
    a3 = agents.get_agent(seeded, "agent-3")
    assert a3["state"] == "working" and a3["task"] == title
    assert _status(seeded, "task-3") == "done"  # the finished task is not reopened


def test_queue_is_capped_and_titles_unique(seeded, clock):
    rng = random.Random(2)
    made = [mock.enqueue_task(seeded, "agent-2", rng, db.utcnow()) for _ in range(5)]
    assert [m is not None for m in made] == [True] * mock.MAX_QUEUED_PER_AGENT + [False] * (
        5 - mock.MAX_QUEUED_PER_AGENT)
    titles = [m[1] for m in made if m]
    assert len(titles) == len(set(titles))


def test_start_never_overwrites_a_working_task(seeded):
    # even if bad data left a queued task next to a working one, nothing starts
    _queue(seeded, "q-1", "agent-2", "Queued", "2026-11-14T12:00:00Z")
    assert mock.start_next_queued(seeded, "agent-2", db.utcnow()) is None
    assert _status(seeded, "task-2") == "working" and _status(seeded, "q-1") == "queued"
