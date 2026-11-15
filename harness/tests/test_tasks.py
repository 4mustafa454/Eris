"""app/tasks.py: the §5.2.1 rules used by both mock and real workers."""
import pytest

from app import agents, db, tasks
from app.workers import mock

NOW = "2026-11-14T12:00:00Z"


@pytest.fixture
def seeded(conn):
    mock.seed_agents(conn)  # agent-1 working, agent-2 working, agent-3 done
    return conn


def _rows(conn, agent_id):
    return [dict(r) for r in conn.execute("SELECT * FROM tasks WHERE agent_id = ? ORDER BY rowid", (agent_id,))]


def _live(conn, agent_id):
    return [t for t in _rows(conn, agent_id) if t["status"] in ("working", "stuck")]


def test_title_from_is_short_whole_words_and_one_line():
    assert tasks.title_from("Fix the failing test") == "Fix the failing test"
    assert tasks.title_from("  Fix   the\nfailing\ttest ") == "Fix the failing test"
    long = "Add input validation to the signup endpoint so that bad emails and short passwords are rejected cleanly"
    t = tasks.title_from(long)
    assert len(t) <= tasks.TITLE_MAX and t.endswith("…") and not t[:-1].endswith(" ")
    assert long.startswith(t[:-1])
    one_word = tasks.title_from("x" * 200)
    assert len(one_word) <= tasks.TITLE_MAX and one_word.endswith("…")


def test_new_task_for_a_done_agent_starts_now_and_does_not_reopen_the_old_one(seeded):
    status = tasks.add_task(seeded, "agent-3", "Fix the test", "Fix the failing test", NOW, "task-new")
    assert status == "working"
    a = agents.get_agent(seeded, "agent-3")
    assert a["state"] == "working" and a["task"] == "Fix the test" and a["stuck_reason"] is None
    assert [t["status"] for t in _rows(seeded, "agent-3")] == ["done", "working"]
    assert agents.get_log(seeded, "agent-3", 1) == ["start task: Fix the test"]


def test_new_task_for_a_busy_agent_is_queued_and_never_overwrites(seeded):
    before = agents.get_agent(seeded, "agent-1")
    assert tasks.is_busy(seeded, "agent-1")
    assert tasks.add_task(seeded, "agent-1", "Second", "do the second", NOW, "task-q") == "queued"
    assert agents.get_agent(seeded, "agent-1")["task"] == before["task"]
    assert [t["status"] for t in _rows(seeded, "agent-1")] == ["working", "queued"]
    assert len(_live(seeded, "agent-1")) == 1
    # when the current task completes, the queued one starts
    assert tasks.complete_task(seeded, "agent-1", NOW) == ("task-q", "Second")
    assert [t["status"] for t in _rows(seeded, "agent-1")] == ["done", "working"]


def test_steer_keeps_the_task_row_and_moves_stuck_to_working(seeded):
    task_before = agents.get_agent(seeded, "agent-1")["task"]
    tasks.set_state(seeded, "agent-1", "stuck", "Blocked: v1 or v2?", "which endpoint?", NOW)
    assert agents.get_agent(seeded, "agent-1")["stuck_reason"] == "which endpoint?"
    assert tasks.steer(seeded, "agent-1", NOW, "use v2") == "stuck"
    a = agents.get_agent(seeded, "agent-1")
    assert a["state"] == "working" and a["stuck_reason"] is None and a["task"] == task_before
    rows = _rows(seeded, "agent-1")
    assert len(rows) == 1 and rows[0]["status"] == "working"  # same row, no new task
    assert agents.get_log(seeded, "agent-1", 1) == ["steered: use v2"]


def test_steer_a_working_agent_is_allowed_and_changes_nothing_but_the_summary(seeded):
    assert tasks.steer(seeded, "agent-2", NOW, "also add a docstring") == "working"
    assert len(_rows(seeded, "agent-2")) == 1 and agents.get_agent(seeded, "agent-2")["state"] == "working"


@pytest.mark.parametrize("state", ["paused", "error"])
def test_steer_resumes_a_paused_or_errored_agent_that_still_has_its_task(seeded, state):
    tasks.set_state(seeded, "agent-1", state, "x", "why" if state == "error" else None, NOW)
    assert tasks.steer(seeded, "agent-1", NOW, "carry on") == state
    assert agents.get_agent(seeded, "agent-1")["state"] == "working"
    assert len(_live(seeded, "agent-1")) == 1


def test_steer_without_a_live_task_returns_none_so_the_caller_starts_a_new_one(seeded):
    assert tasks.steer(seeded, "agent-3", NOW, "anything") is None  # done: nothing to steer
    assert agents.get_agent(seeded, "agent-3")["state"] == "done"
    assert len(_rows(seeded, "agent-3")) == 1


def test_set_state_mirrors_on_the_task_row(seeded):
    status = lambda: _rows(seeded, "agent-1")[0]["status"]  # noqa: E731
    tasks.set_state(seeded, "agent-1", "stuck", "s", "r", NOW)
    assert status() == "stuck"
    tasks.set_state(seeded, "agent-1", "error", "boom", "boom", NOW)
    assert agents.get_agent(seeded, "agent-1")["state"] == "error" and status() == "stuck"  # still the one live task
    tasks.set_state(seeded, "agent-1", "paused", "stopped", None, NOW)
    assert agents.get_agent(seeded, "agent-1")["state"] == "paused" and status() == "stuck"  # paused leaves it alone
    tasks.set_state(seeded, "agent-1", "working", "go", None, NOW)
    assert status() == "working"
    tasks.set_state(seeded, "agent-1", "done", "fin", None, NOW)
    assert status() == "done"
    tasks.set_state(seeded, "agent-1", "working", "again", None, NOW)
    assert status() == "done", "a finished task is never reopened by a state change"


def test_complete_task_takes_a_summary_and_a_line_with_mock_defaults(seeded):
    tasks.complete_task(seeded, "agent-1", NOW, summary="Fixed the signup test", line="done: all tests pass")
    a = agents.get_agent(seeded, "agent-1")
    assert a["state"] == "done" and a["summary"] == "Fixed the signup test"
    assert agents.get_log(seeded, "agent-1", 1) == ["done: all tests pass"]
    tasks.complete_task(seeded, "agent-2", NOW)
    assert agents.get_agent(seeded, "agent-2")["summary"] == tasks.DEFAULT_DONE_SUMMARY
    assert agents.get_log(seeded, "agent-2", 1) == [tasks.DEFAULT_DONE_LINE]


def test_start_never_starts_a_second_live_task(seeded):
    tasks.add_task(seeded, "agent-2", "Queued", "later", NOW, "task-q")
    assert tasks.start_next_queued(seeded, "agent-2", NOW) is None
    assert len(_live(seeded, "agent-2")) == 1
    assert seeded.execute("PRAGMA foreign_key_check").fetchall() == []
