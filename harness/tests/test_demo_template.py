"""The demo repo workers operate on (AGENTS.md §7): its own git repo, one commit, one deliberately broken test."""
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "make-demo-repo.sh"

AGENTS_MD = (
    "- Run tests: pytest -q\n"
    "- Commit locally after each passing change. Never push.\n"
    '- If blocked, end your reply with one line starting "BLOCKED:" followed by the question.\n'
)


def _run(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)


@pytest.fixture
def repo(tmp_path):
    target = tmp_path / "demo-repo"
    r = _run(str(SCRIPT), str(target))
    assert r.returncode == 0, r.stderr
    return target


def test_builds_a_git_repo_with_one_commit_and_no_remote(repo):
    log = _run("git", "-C", str(repo), "log", "--format=%an|%s").stdout.strip().splitlines()
    assert len(log) == 1 and log[0].startswith("Eris Demo|")
    assert _run("git", "-C", str(repo), "remote").stdout.strip() == ""
    assert _run("git", "-C", str(repo), "status", "--porcelain").stdout == ""
    assert _run("git", "-C", str(repo), "branch", "--show-current").stdout.strip() == "main"


def test_agent_repositories_are_self_contained_and_independent(repo):
    for name in ("agent-1", "agent-3"):
        clone = repo / ".worktrees" / name
        assert (clone / ".git").is_dir()
        assert _run("git", "-C", str(clone), "branch", "--show-current").stdout.strip() == name
        assert _run("git", "-C", str(clone), "remote").stdout.strip() == ""
    (repo / ".worktrees/agent-1/only-one.txt").write_text("isolated")
    assert not (repo / ".worktrees/agent-3/only-one.txt").exists()


def test_exactly_one_test_fails_and_it_is_the_signup_one(repo):
    r = _run(sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", cwd=repo)
    assert r.returncode == 1
    assert re.search(r"1 failed, 3 passed", r.stdout), r.stdout
    assert "test_signup_rejects_an_invalid_email" in r.stdout


def test_worker_rules_are_the_ones_in_the_contract(repo):
    assert (repo / "AGENTS.md").read_text() == AGENTS_MD
    assert (repo / "CLAUDE.md").read_text().strip() == "@AGENTS.md"


def test_the_blocker_is_explicit_in_tasks_and_in_the_client_note(repo):
    for name in ("TASKS.md", "shop/client.py"):
        text = (repo / name).read_text()
        assert "Don't choose an endpoint yourself" in text, name
        assert "BLOCKED: which endpoint, v1 or v2?" in text, name


def test_refuses_to_overwrite_without_force_and_rebuilds_with_it(repo):
    again = _run(str(SCRIPT), str(repo))
    assert again.returncode != 0 and "already exists" in again.stderr
    (repo / "scratch.txt").write_text("leftover")
    forced = _run(str(SCRIPT), "--force", str(repo))
    assert forced.returncode == 0
    assert not (repo / "scratch.txt").exists()
    assert len(_run("git", "-C", str(repo), "log", "--oneline").stdout.strip().splitlines()) == 1


def test_the_real_demo_repo_is_ignored_by_the_root_repo():
    r = _run("git", "-C", str(ROOT), "check-ignore", "demo-repo/AGENTS.md")
    assert r.returncode == 0, "demo-repo/ must be in the root .gitignore so workers never see the root AGENTS.md"
