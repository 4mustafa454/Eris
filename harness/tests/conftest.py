import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db  # noqa: E402


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
