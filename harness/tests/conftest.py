import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db  # noqa: E402


@pytest.fixture(autouse=True)
def _no_real_workers(tmp_path, monkeypatch):
    """Tests never read a developer's harness/.env and never start with real workers unless they ask for them."""
    monkeypatch.setenv("ERIS_ENV_FILE", str(tmp_path / "no-such.env"))
    for name in ("REAL_WORKERS", "WORKER_IMAGE", "CLAUDE_MAX_TURNS", "DEMO_REPO", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def db_file(tmp_path, monkeypatch):
    path = tmp_path / "eris-test.db"
    monkeypatch.setenv("ERIS_DB_PATH", str(path))
    db.init_db()
    return path


@pytest.fixture
def conn(db_file):
    c = db.connect()
    yield c
    c.close()
