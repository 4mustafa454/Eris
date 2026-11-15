"""app/workers/stream.py: Claude Code stream-json → event lines and run outcome."""
import json
from pathlib import Path

import pytest

from app.workers.stream import MAX_LINE, MAX_REASON, Result, StreamParser, _pytest_outcome, first_sentence

FIXTURES = Path(__file__).parent / "fixtures" / "claude"
SID = "8c1f6a52-3b7e-4f0a-9d44-2f5d6e1b7a90"


def run(name, secrets=()):
    """Feed a whole fixture; returns (parser, [Update, ...], all event lines in order)."""
    p = StreamParser(secrets)
    updates = [p.feed(line) for line in (FIXTURES / f"{name}.jsonl").read_text().splitlines()]
    return p, updates, [ln for u in updates for ln in u.lines]


def event(kind, **kw):
    return json.dumps({"type": kind, **kw})


def asst(*blocks):
    return event("assistant", message={"content": list(blocks)})


def use(i, name, **inp):
    return {"type": "tool_use", "id": i, "name": name, "input": inp}


def result_event(i, content, err=False):
    return event("user", message={"content": [{"type": "tool_result", "tool_use_id": i, "content": content, "is_error": err}]})


# --- a whole run -------------------------------------------------------------------------------------------------

def test_a_fail_then_pass_run_becomes_short_phone_readable_lines():
    p, updates, lines = run("done_after_fix")
    assert lines == [
        "run pytest → 1 failed",
        "read shop/signup.py",
        "edit shop/signup.py",
        "run pytest → 4 passed",
        "git commit",
        "grep def signup",
    ]
    assert all(len(ln) <= MAX_LINE and "\n" not in ln for ln in lines)
    assert p.session_id == SID
    r = p.finish(0)
    assert r.kind == "done" and r.reason is None
    assert r.summary.startswith("Added email validation to signup()") and len(r.summary) <= MAX_LINE


def test_assistant_text_updates_the_summary_and_is_not_logged_as_a_line():
    _, updates, lines = run("done_after_fix")
    summaries = [u.summary for u in updates if u.summary]
    assert summaries[0] == "I'll start by running the tests to see what fails."
    assert summaries[1] == "One signup test fails because signup() does not validate."
    assert not any("I'll start" in ln or "One signup" in ln for ln in lines)


def test_the_session_id_comes_from_the_first_event_that_has_one():
    _, updates, _ = run("done_after_fix")
    assert updates[0].session_id == SID  # system/init


def test_blocked_run_gives_the_question_as_the_reason():
    p, _, lines = run("blocked")
    assert lines == ["read shop/client.py"]
    r = p.finish(0)
    assert r.kind == "blocked" and r.reason == "which endpoint, v1 or v2?"
    assert "BLOCKED:" in r.text


def test_max_turns_and_error_results():
    p, _, lines = run("max_turns")
    assert lines == ["find **/*.py"]
    assert p.finish(0) == Result("max_turns", "", "ran out of turns")

    p, _, lines = run("error_result")
    assert lines == ["run pytest → error"]  # pytest output with no summary: "error"
    r = p.finish(1)
    assert r.kind == "error" and "API Error: 529 overloaded" in r.reason


def test_noise_is_ignored_never_raises_and_only_real_activity_is_logged():
    p, updates, lines = run("noise")
    assert lines == ["create_issue"]  # the mcp tool, by its short name; the orphan tool_result adds nothing
    assert p.finish(0).kind == "done" and p.result.text == "Nothing to do."
    non_objects = [updates[i].alive for i in (0, 1, 2, 3)]  # blank, plain text, broken JSON, a list
    assert non_objects == [False, False, False, False]
    assert all(u.alive for u in updates[4:])  # valid JSON objects count as the worker being alive


def test_bytes_lines_are_accepted_and_bad_utf8_does_not_raise():
    p = StreamParser()
    assert p.feed(b'{"type":"system","session_id":"abc"}\n').session_id == "abc"
    assert p.feed(b'{"type":"assistant","message":{"content":[{"type":"text","text":"caf\xe9 \xff ok."}]}}').summary


# --- end of stream -----------------------------------------------------------------------------------------------

def test_finish_without_a_result_is_an_error_naming_the_exit_code():
    p = StreamParser()
    p.feed(asst(use("t1", "Read", file_path="/workspace/a.py")))
    r = p.finish(137)
    assert r.kind == "error" and "exit code 137" in r.reason
    assert StreamParser().finish(None).reason == "the worker stopped without a result"


def test_finish_returns_the_result_event_when_there_was_one():
    p, _, _ = run("blocked")
    assert p.finish(0) is p.result and p.finish(1) is p.result  # the exit code does not override a real result


# --- BLOCKED: ----------------------------------------------------------------------------------------------------

def final(text, **kw):
    return event("result", subtype="success", is_error=False, result=text, **kw)


@pytest.mark.parametrize("text,reason", [
    ("BLOCKED: which endpoint, v1 or v2?", "which endpoint, v1 or v2?"),
    ("I stopped.\nBLOCKED:   need the   DB url  ", "need the DB url"),
    ("  BLOCKED: indented still counts", "indented still counts"),
    ("BLOCKED: first\nsome text\nBLOCKED: the last one wins", "the last one wins"),
    ("BLOCKED:", "blocked (no question given)"),
])
def test_blocked_marker_forms(text, reason):
    p = StreamParser()
    u = p.feed(final(text))
    assert u.result.kind == "blocked" and u.result.reason == reason


@pytest.mark.parametrize("text", [
    "All done, nothing blocked.", "blocked: lowercase is not the marker", "NOT BLOCKED: x", "Done. BLOCKED: mid-line", "",
])
def test_things_that_are_not_the_marker(text):
    assert StreamParser().feed(final(text)).result.kind == "done"


def test_a_long_blocked_reason_is_cut():
    r = StreamParser().feed(final("BLOCKED: " + "why " * 200)).result
    assert len(r.reason) <= MAX_REASON and r.reason.endswith("…")


# --- lines -------------------------------------------------------------------------------------------------------

def lines_of(*blocks):
    p = StreamParser()
    return p.feed(asst(*blocks)).lines


def test_each_known_tool_has_a_short_line():
    assert lines_of(
        use("a", "Read", file_path="/workspace/shop/billing.py"),
        use("b", "Write", file_path="/workspace/notes.md"),
        use("c", "MultiEdit", file_path="/workspace/shop/signup.py"),
        use("d", "Glob", pattern="tests/*.py"),
        use("e", "LS", path="/workspace/shop"),
        use("f", "WebFetch", url="https://x"),
        use("g", "TodoWrite", todos=[]),
        use("h", "Bash", command="ls -la"),
    ) == ["read shop/billing.py", "write notes.md", "edit shop/signup.py", "find tests/*.py", "ls shop", "webfetch", "run ls -la"]


def test_paths_outside_the_workspace_are_kept_as_given():
    assert lines_of(use("a", "Read", file_path="/etc/hosts")) == ["read /etc/hosts"]


def test_git_commit_is_just_git_commit():
    assert lines_of(use("a", "Bash", command="git commit -am 'Validate the email'")) == ["git commit"]


def test_a_long_command_is_cut_to_80_characters_with_an_ellipsis():
    line = lines_of(use("a", "Bash", command="echo " + "x" * 300))[0]
    assert len(line) == MAX_LINE and line.endswith("…") and line.startswith("run echo xxx")


def test_multiline_commands_and_control_characters_become_one_clean_line():
    line = lines_of(use("a", "Bash", command="cd shop &&\n  ls\x07\x1b[0m\t-la"))[0]
    assert "\n" not in line and "\x07" not in line and "\x1b" not in line and "\t" not in line
    assert line.startswith("run cd shop && ls")


def test_a_failed_non_pytest_tool_is_logged_with_its_name():
    p = StreamParser()
    p.feed(asst(use("e1", "Edit", file_path="/workspace/a.py"), use("m1", "mcp__github__create_issue", title="t")))
    assert p.feed(result_event("e1", "String to replace not found", err=True)).lines == ["edit → error"]
    assert p.feed(result_event("m1", "403", err=True)).lines == ["create_issue → error"]


def test_a_successful_non_pytest_tool_result_adds_nothing():
    p = StreamParser()
    p.feed(asst(use("e1", "Edit", file_path="/workspace/a.py")))
    assert p.feed(result_event("e1", "ok")).lines == []


def test_several_tool_uses_in_one_message_keep_their_order():
    assert lines_of(use("a", "Read", file_path="/workspace/x.py"), use("b", "Edit", file_path="/workspace/x.py")) == [
        "read x.py", "edit x.py"]


# --- pytest ------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("output,expected", [
    ("1 failed, 3 passed in 0.08s", "1 failed"),
    ("2 failed, 1 error in 0.3s", "2 failed"),
    ("1 error in 0.1s", "1 error"),
    ("4 passed in 0.04s", "4 passed"),
    ("no tests ran in 0.01s", "no tests ran"),
    ("bash: pytest: command not found", "error"),
    ("", "error"),
    ("3 failed in 1s\n...\n1 failed, 2 passed in 1s", "1 failed"),  # the last summary wins
])
def test_pytest_outcome(output, expected):
    assert _pytest_outcome(output) == expected


@pytest.mark.parametrize("cmd", [
    "pytest", "pytest -q tests/test_signup.py", "python -m pytest -q", "python3 -m pytest", "cd /workspace && pytest -q",
    "pytest -q 2>&1 | tail -5",
])
def test_pytest_commands_are_shown_when_they_finish_with_their_outcome(cmd):
    p = StreamParser()
    assert p.feed(asst(use("t", "Bash", command=cmd))).lines == []
    assert p.feed(result_event("t", "2 failed, 1 passed in 0.2s", err=True)).lines == ["run pytest → 2 failed"]


@pytest.mark.parametrize("cmd", ["pip install pytest", "echo pytest-cov", "cat pytest.ini", "git add tests/pytest_helpers.py"])
def test_commands_that_only_mention_pytest_are_not_test_runs(cmd):
    p = StreamParser()
    assert p.feed(asst(use("t", "Bash", command=cmd))).lines == [f"run {cmd}"]  # shown at once, not held back
    assert p.feed(result_event("t", "1 failed", err=True)).lines == ["bash → error"]  # and no pytest outcome line


def test_git_commit_is_recognised_inside_a_compound_command():
    assert lines_of(use("a", "Bash", command="git add -A && git commit -m 'x'")) == ["git commit"]
    assert lines_of(use("a", "Bash", command="git status")) == ["run git status"]
    assert lines_of(use("a", "Bash", command="echo git commit")) == ["run echo git commit"]


def test_a_tool_use_without_a_name_is_ignored():
    assert lines_of({"type": "tool_use", "id": "x", "input": {}}, {"type": "tool_use", "name": "", "id": "y"}) == []


# --- secrets -----------------------------------------------------------------------------------------------------

SECRET = "sk-ant-oat01-SECRET-VALUE-123"


def test_known_secret_values_are_redacted_everywhere_the_parser_returns_text():
    p = StreamParser([SECRET, ""])
    u = p.feed(asst({"type": "text", "text": f"The token is {SECRET}."}, use("a", "Bash", command=f"echo {SECRET}")))
    assert SECRET not in json.dumps([u.lines, u.summary]) and "[redacted]" in u.lines[0] and "[redacted]" in u.summary
    r = p.feed(final(f"BLOCKED: is {SECRET} the right key?")).result
    assert SECRET not in json.dumps([r.text, r.reason, r.summary]) and "[redacted]" in r.reason
    e = StreamParser([SECRET]).feed(event("result", subtype="error_during_execution", is_error=True, result=f"bad key {SECRET}")).result
    assert SECRET not in e.reason and SECRET not in e.text


def test_first_sentence():
    assert first_sentence("Fixed it. Then more.") == "Fixed it."
    assert first_sentence("no punctuation here") == "no punctuation here"
    assert len(first_sentence("word " * 100)) <= MAX_LINE
    assert first_sentence("  multi\nline\ttext. Next.") == "multi line text."


def test_cuts_prefer_a_word_boundary_but_never_throw_away_most_of_the_text():
    from app.workers.stream import _cut
    assert _cut("alpha beta gamma delta", 15) == "alpha beta…"          # not "alpha beta gam…"
    assert _cut("alpha beta gamma delta", 22) == "alpha beta gamma delta"
    assert _cut("x" * 50, 20) == "x" * 19 + "…"                          # no space: a hard cut
    assert _cut("a " + "x" * 50, 20) == "a " + "x" * 17 + "…"            # the only boundary would keep almost nothing
    assert _cut("run pytest tests", 12).endswith("…") and len(_cut("run pytest tests", 12)) <= 12


def test_finish_redacts_what_it_returns():
    p = StreamParser([SECRET])
    assert SECRET not in p.finish(1).reason
    assert p.redact(f"a {SECRET} b {SECRET}") == "a [redacted] b [redacted]" and p.redact("") == ""


# --- a REAL stream (captured from Claude Code 2.1.316 in the worker container; an auth failure, token redacted) --------

REAL_SID = "a7475922-8c91-4ae9-8c07-1e942c308ea7"


def test_the_real_auth_failure_stream_is_an_error_with_claudes_own_message():
    p, updates, lines = run("auth_error_real")
    assert lines == [], "init, api_retry and the synthetic assistant message produce no event lines"
    assert p.session_id == REAL_SID and updates[0].session_id == REAL_SID  # the real system/init
    assert all(u.alive for u in updates), "every line, including system/api_retry, is a valid event (the worker is alive)"
    r = p.finish(1)
    # the real result event says subtype "success" but is_error true: is_error wins
    assert r.kind == "error" and r.reason == "Failed to authenticate. API Error: 401 Invalid bearer token"


def test_the_terminal_reason_also_marks_running_out_of_turns():
    line = event("result", subtype="success", is_error=True, terminal_reason="max_turns", result="")
    assert StreamParser().feed(line).result == Result("max_turns", "", "ran out of turns")


def test_summaries_are_plain_text_because_the_pm_reads_them_aloud():
    assert first_sentence("`signup()` now **raises** `ValueError` for bad emails. Next.") == "signup() now raises ValueError for bad emails."
    u = StreamParser().feed(asst({"type": "text", "text": "I fixed `signup()`."}))
    assert u.summary == "I fixed signup()."
    r = StreamParser().feed(final("Added **validation** to `signup()`.")).result
    assert r.summary == "Added validation to signup()."


def test_tool_names_match_case_insensitively():
    assert lines_of(use("a", "bash", command="ls -la"), use("b", "BASH", command="git commit -m x"), use("c", "read", file_path="/workspace/a.py"),
                    use("d", "todowrite", todos=[])) == ["run ls -la", "git commit", "read a.py"]
    p = StreamParser()
    assert p.feed(asst(use("t", "bash", command="pytest -q"))).lines == []  # a lowercase bash running pytest is still held for its outcome
    assert p.feed(result_event("t", "3 passed in 0.1s")).lines == ["run pytest → 3 passed"]
    p.feed(asst(use("e", "edit", file_path="/workspace/a.py")))
    assert p.feed(result_event("e", "nope", err=True)).lines == ["edit → error"]


# --- REAL streams captured from the worker container (Claude Code 2.1.316), token never present ----------------------

def test_a_real_interrupted_run_has_lines_but_no_result():
    p, updates, lines = run("interrupted_run_real")
    assert lines == ["run pytest → 6 passed"], "real pytest output is parsed into its outcome"
    assert p.session_id and all(u.alive for u in updates)
    r = p.finish(130)  # the harness ignores this for a run it stopped; as a plain end of stream it is an error
    assert r.kind == "error" and "exit code 130" in r.reason and p.result is None


def test_a_real_completed_run_ends_done_with_a_plain_summary():
    p, updates, lines = run("steered_run_real")
    assert lines == ["run cat tests/test_billing.py tests/conftest.py", "git commit"]
    r = p.finish(0)
    assert r.kind == "done" and r.summary == "I added four billing tests, and all 10 tests pass."
    assert "rate_limit_event" in (FIXTURES / "steered_run_real.jsonl").read_text(), "unknown real event types are in the stream and ignored"
    assert [u for u in updates if u.lines or u.summary or u.result] and not any(u.result for u in updates[:-1])
