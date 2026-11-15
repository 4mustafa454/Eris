"""Static checks on the worker Dockerfile (the real build needs Docker: scripts/build-worker.sh)."""
import re
from pathlib import Path

from app import config

ROOT = Path(__file__).resolve().parents[2]
TEXT = (ROOT / "workers" / "claude-code" / "Dockerfile").read_text()
LINES = [line.strip() for line in TEXT.splitlines()]
VERSION = config.DEFAULT_IMAGE.split(":")[1]


def test_claude_code_is_pinned_and_the_version_agrees_everywhere():
    assert f"ARG CLAUDE_CODE_VERSION={VERSION}" in TEXT
    assert "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" in TEXT
    assert "latest" not in TEXT.lower()
    build = (ROOT / "scripts" / "build-worker.sh").read_text()
    assert f"eris-claude-code:{VERSION}" in build


def test_the_worker_is_not_root_and_the_last_user_is_worker():
    users = [line for line in LINES if line.startswith("USER ")]
    assert users == ["USER worker"]
    assert "refusing to build a root worker" in TEXT
    assert "WORKER_UID" in TEXT and "WORKER_GID" in TEXT


def test_the_existing_node_user_at_1000_is_reused_not_fought():
    """Creating `worker` with the host UID/GID must not fail when the base image's `node` user owns 1000."""
    assert 'getent passwd "${WORKER_UID}"' in TEXT and 'getent group "${WORKER_GID}"' in TEXT
    assert 'usermod -l worker -d /home/worker -m -g worker "$u"' in TEXT
    assert 'groupmod -n worker "$g"' in TEXT
    assert "useradd" in TEXT and "groupadd" in TEXT, "and a free UID/GID still creates the user"
    assert "userdel -r node" in TEXT and "groupdel node" in TEXT


def test_it_has_what_the_harness_and_the_demo_need():
    install = next(line for line in LINES if "apt-get install" in line)
    for package in ("git", "python3", "python3-pytest", "procps"):  # procps: pkill/pgrep/ps for the in-container interrupt
        assert package in install, package
    assert 'CMD ["sleep", "infinity"]' in TEXT
    assert "WORKDIR /workspace" in TEXT and "ENV HOME=/home/worker" in TEXT
    assert "/home/worker/.claude" in TEXT


def test_no_secrets_no_remote_no_root_tricks():
    forbidden = ["TOKEN", "API_KEY", "SECRET", "PASSWORD", "sudo", "docker.sock", "--privileged", "git remote", "git push", "COPY ", "ADD "]
    for word in forbidden:
        assert word not in TEXT, word
    assert re.search(r"^FROM node:24-", TEXT, re.M) and TEXT.count("FROM ") == 1


def test_git_is_local_only():
    assert "safe.directory /workspace" in TEXT
    assert "user.email" in TEXT and "user.name" in TEXT


def test_codex_image_is_pinned_and_uses_the_same_non_root_setup():
    codex = (ROOT / "workers" / "codex" / "Dockerfile").read_text()
    build = (ROOT / "scripts" / "build-codex-worker.sh").read_text()
    version = config.Settings().codex_worker_image.split(":")[1]
    assert f"ARG CODEX_VERSION={version}" in codex
    assert f"eris-codex:{version}" in build
    assert "@openai/codex@${CODEX_VERSION}" in codex
    assert 'getent passwd "${WORKER_UID}"' in codex
    assert 'getent group "${WORKER_GID}"' in codex
    assert "USER worker" in codex and "refusing to build a root worker" in codex
    assert "/home/worker/.codex" in codex and 'CMD ["sleep", "infinity"]' in codex
