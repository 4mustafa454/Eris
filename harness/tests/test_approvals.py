import json

from fastapi.testclient import TestClient

from app import db
from app.main import app


def test_list_and_decide_approval_once_with_session_action(db_file):
    with TestClient(app) as client:
        conn = db.connect()
        conn.execute("INSERT INTO approvals (id, agent_id, action, status, created_at) VALUES ('a1', 'agent-1', 'git_push', 'pending', ?)", (db.utcnow(),))
        conn.close()
        sid = client.post('/sessions', json={'channel': 'web'}).json()['id']
        assert [a['id'] for a in client.get('/approvals', params={'status': 'pending'}).json()] == ['a1']
        response = client.post('/approvals/a1', json={'decision': 'approved', 'session_id': sid})
        assert response.status_code == 200
        assert response.json()['status'] == 'approved' and response.json()['decided_at']
        assert client.get('/approvals', params={'status': 'pending'}).json() == []
        assert client.post('/approvals/a1', json={'decision': 'denied', 'session_id': sid}).status_code == 409
        actions = client.get(f'/sessions/{sid}').json()['actions']
        assert len(actions) == 1 and actions[0]['tool'] == 'decide_approval'
        assert json.loads(actions[0]['args_json']) == {'id': 'a1', 'decision': 'approved'}


def test_approval_validation_and_rollback(db_file):
    with TestClient(app) as client:
        conn = db.connect()
        conn.execute("INSERT INTO approvals (id, agent_id, action, status, created_at) VALUES ('a2', 'agent-2', 'git_push', 'pending', ?)", (db.utcnow(),))
        conn.close()
        assert client.post('/approvals/missing', json={'decision': 'denied'}).status_code == 404
        assert client.post('/approvals/a2', json={'decision': 'maybe'}).status_code == 422
        assert client.post('/approvals/a2', json={'decision': 'denied', 'session_id': 'missing'}).status_code == 404
        assert client.get('/approvals', params={'status': 'pending'}).json()[0]['id'] == 'a2'
        assert client.post('/approvals/a2', json={'decision': 'denied'}).json()['status'] == 'denied'
