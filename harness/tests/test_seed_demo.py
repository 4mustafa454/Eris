"""scripts/seed-demo.sh: the rehearsal reset, run against a sandbox with a fake `docker`."""
import http.server
import os
import subprocess
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "seed-demo.sh"

FAKE_DOCKER = """#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$1 $2" in
  "ps -a")     printf '%s' "${FAKE_CONTAINERS:-}" ;;
  "volume ls") printf '%s' "${FAKE_VOLUMES:-}" ;;
esac
exit 0
"""


@pytest.fixture
def sandbox(tmp_path):
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "docker").write_text(FAKE_DOCKER)
    (fake / "docker").chmod(0o755)
    db = tmp_path / "data" / "eris.db"
    db.parent.mkdir()
    for suffix in ("", "-wal", "-shm"):
        Path(f"{db}{suffix}").write_text("old")
    repo = tmp_path / "demo-repo"
    subprocess.run([str(ROOT / "scripts" / "make-demo-repo.sh"), str(repo)], check=True, capture_output=True)
    (repo / "worker-was-here.txt").write_text("leftover from a rehearsal")

    class Box:
        pass

    b = Box()
    b.db, b.repo, b.log, b.tmp = db, repo, tmp_path / "docker.log", tmp_path
    b.env = {
        "PATH": f"{fake}:{os.environ['PATH']}", "ERIS_DB_PATH": str(db), "DEMO_REPO": str(repo),
        "HARNESS_URL": "http://127.0.0.1:9", "FAKE_DOCKER_LOG": str(b.log),
        "FAKE_CONTAINERS": "eris-agent-1\neris-agent-2\nunrelated-container\n",
        "FAKE_VOLUMES": "eris-agent-1-home\neris-agent-2-home\nsome-other-volume\n",
    }
    return b


def run(box, *args, stdin="", env=None):
    return subprocess.run([str(SCRIPT), *args], input=stdin, capture_output=True, text=True, env={**box.env, **(env or {})})


def calls(box):
    return box.log.read_text().splitlines() if box.log.exists() else []


def test_yes_resets_everything_and_removes_only_the_eris_worker_containers_and_volumes(sandbox):
    r = run(sandbox, "--yes")
    assert r.returncode == 0, r.stderr
    assert not sandbox.db.exists() and not Path(f"{sandbox.db}-wal").exists() and not Path(f"{sandbox.db}-shm").exists()
    assert not (sandbox.repo / "worker-was-here.txt").exists()
    log = subprocess.run(["git", "-C", str(sandbox.repo), "log", "--oneline"], capture_output=True, text=True).stdout
    assert len(log.splitlines()) == 1
    rm = [c for c in calls(sandbox) if c.startswith(("rm", "volume rm"))]
    assert rm == ["rm -f eris-agent-1", "rm -f eris-agent-2", "volume rm eris-agent-1-home", "volume rm eris-agent-2-home"]
    assert "unrelated" not in " ".join(rm) and "some-other-volume" not in " ".join(rm)
    assert "Start the harness again" in r.stdout


def test_running_it_twice_works(sandbox):
    assert run(sandbox, "--yes").returncode == 0
    r = run(sandbox, "--yes")
    assert r.returncode == 0, r.stderr
    assert len(subprocess.run(["git", "-C", str(sandbox.repo), "log", "--oneline"], capture_output=True, text=True).stdout.splitlines()) == 1


def test_without_yes_it_asks_and_n_changes_nothing(sandbox):
    r = run(sandbox, stdin="n\n")
    assert r.returncode == 1 and "aborted, nothing changed" in r.stdout
    assert sandbox.db.exists() and (sandbox.repo / "worker-was-here.txt").exists()
    assert not [c for c in calls(sandbox) if c.startswith(("rm", "volume rm"))]
    assert run(sandbox, stdin="").returncode == 1, "no answer (no terminal) also aborts"
    assert sandbox.db.exists()


def test_without_yes_a_y_proceeds(sandbox):
    r = run(sandbox, stdin="y\n")
    assert r.returncode == 0 and not sandbox.db.exists()
    assert "eris-agent-1" in r.stdout and "unrelated" not in r.stdout, "the prompt lists exactly what will go"


def test_it_refuses_while_the_harness_is_running_and_deletes_nothing(sandbox):
    class Ok(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"[]")

        def log_message(self, *a):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Ok)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        r = run(sandbox, "--yes", env={"HARNESS_URL": f"http://127.0.0.1:{server.server_address[1]}"})
    finally:
        server.shutdown()
    assert r.returncode == 1 and "harness is running" in r.stderr
    assert sandbox.db.exists() and (sandbox.repo / "worker-was-here.txt").exists()
    assert not [c for c in calls(sandbox) if c.startswith(("rm", "volume rm"))]


def test_without_docker_it_still_resets_the_db_and_the_repo(sandbox):
    r = run(sandbox, "--yes", env={"DOCKER": "no-such-docker-binary"})
    assert r.returncode == 0, r.stderr
    assert "docker not found" in r.stdout and not sandbox.db.exists()
    assert not (sandbox.repo / "worker-was-here.txt").exists()


def test_a_relative_demo_repo_is_relative_to_harness_like_the_harness_reads_it(sandbox, tmp_path):
    r = run(sandbox, "--yes", env={"DEMO_REPO": "../scripts-test-repo"})
    try:
        assert r.returncode == 0, r.stderr
        assert (ROOT / "scripts-test-repo" / ".git").exists()
    finally:
        subprocess.run(["rm", "-rf", str(ROOT / "scripts-test-repo")])


def test_bad_arguments(sandbox):
    assert run(sandbox, "--wat").returncode == 2
    assert sandbox.db.exists()


def test_with_approval_flag_creates_one_pending_approval_on_a_fresh_db(sandbox):
    r = run(sandbox, "--yes", "--with-approval=agent-2")
    assert r.returncode == 0, r.stderr
    import sqlite3
    rows = sqlite3.connect(sandbox.db).execute("SELECT agent_id, action, status FROM approvals").fetchall()
    assert rows == [("agent-2", "git_push", "pending")]


def test_unknown_flag_still_rejected(sandbox):
    assert run(sandbox, "--bogus").returncode == 2
