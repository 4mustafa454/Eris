import json

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import app


@pytest.fixture
def client(db_file):
    with TestClient(app) as c:
        yield c


def _new(client, channel="web"):
    r = client.post("/sessions", json={"channel": channel})
    assert r.status_code == 200
    return r.json()


def test_create_session(client):
    s = _new(client, "facetime")
    assert s["channel"] == "facetime"
    assert s["started_at"].endswith("Z")
    assert s["ended_at"] is None and s["summary"] is None and s["title"] is None


def test_transcript_ordered_and_actions_empty(client):
    sid = _new(client)["id"]
    for role, text in [("user", "status?"), ("pm", "Agent 2 is writing tests.")]:
        r = client.post(f"/sessions/{sid}/messages", json={"role": role, "text": text})
        assert r.status_code == 200 and r.json()["session_id"] == sid
    detail = client.get(f"/sessions/{sid}").json()
    assert [m["text"] for m in detail["messages"]] == ["status?", "Agent 2 is writing tests."]
    assert [m["role"] for m in detail["messages"]] == ["user", "pm"]
    assert detail["actions"] == []


def test_detail_includes_actions(client, db_file):
    sid = _new(client)["id"]
    conn = db.connect()
    conn.execute(
        "INSERT INTO actions (session_id, tool, args_json, result_json, created_at)"
        " VALUES (?, 'get_status', ?, ?, ?)",
        (sid, json.dumps({}), json.dumps({"ok": True}), db.utcnow()),
    )
    conn.close()
    actions = client.get(f"/sessions/{sid}").json()["actions"]
    assert [a["tool"] for a in actions] == ["get_status"]


def test_patch_persists_and_is_partial(client):
    sid = _new(client)["id"]
    r = client.patch(f"/sessions/{sid}", json={"summary": "Agent 3 renamed the package."})
    assert r.status_code == 200
    r = client.patch(f"/sessions/{sid}", json={"ended_at": "2026-11-14T19:30:00Z", "title": "Call"})
    body = r.json()
    assert body["summary"] == "Agent 3 renamed the package."  # untouched by the second patch
    assert body["ended_at"] == "2026-11-14T19:30:00Z" and body["title"] == "Call"
    assert client.get(f"/sessions/{sid}").json()["summary"] == "Agent 3 renamed the package."


def test_list_filter_limit_newest_first(client):
    ids = [_new(client, ch)["id"] for ch in ("web", "facetime", "web", "imessage")]
    allr = client.get("/sessions").json()
    assert [s["id"] for s in allr] == list(reversed(ids))
    assert [s["id"] for s in client.get("/sessions", params={"channel": "web"}).json()] == [
        ids[2], ids[0]]
    assert [s["id"] for s in client.get("/sessions", params={"limit": 2}).json()] == [ids[3], ids[2]]


def test_validation_errors(client):
    assert client.post("/sessions", json={"channel": "sms"}).status_code == 422
    sid = _new(client)["id"]
    assert client.post(f"/sessions/{sid}/messages", json={"role": "bot", "text": "x"}).status_code == 422
    assert client.get("/sessions", params={"channel": "sms"}).status_code == 422
    assert client.get("/sessions", params={"limit": 0}).status_code == 422


def test_unknown_session_404(client):
    assert client.get("/sessions/nope").status_code == 404
    assert client.patch("/sessions/nope", json={"summary": "x"}).status_code == 404
    assert client.post("/sessions/nope/messages", json={"role": "user", "text": "x"}).status_code == 404


def test_message_is_searchable_via_fts(client, db_file):
    sid = _new(client)["id"]
    client.post(f"/sessions/{sid}/messages", json={"role": "user", "text": "rename the package"})
    conn = db.connect()
    hits = conn.execute("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'package'").fetchall()
    conn.close()
    assert len(hits) == 1
