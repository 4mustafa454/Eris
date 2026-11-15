from fastapi.testclient import TestClient

from app import db, dev
from app.main import app


def test_seed_approval_is_pending_and_visible(db_file, capsys):
    with TestClient(app) as client:
        assert dev.main(['seed-approval', 'agent-1', 'git_push', '--detail', 'push main']) == 0
        pending = client.get('/approvals', params={'status': 'pending'}).json()
        assert len(pending) == 1 and pending[0]['action'] == 'git_push' and pending[0]['detail'] == 'push main'
        assert client.get('/context').json()['pending_approvals'][0]['id'] == pending[0]['id']
        from app.routes.events import snapshots
        assert [a['id'] for a in snapshots()['approval']] == [pending[0]['id']]


def test_seed_approval_unknown_agent(db_file, capsys):
    with TestClient(app):
        assert dev.main(['seed-approval', 'agent-99', 'git_push']) == 1
        assert db.connect().execute('SELECT COUNT(*) FROM approvals').fetchone()[0] == 0


def _seed(client):
    assert dev.main(['seed-approval', 'agent-1', 'git_push']) == 0
    return client.get('/approvals', params={'status': 'pending'}).json()[0]['id']


def test_seed_puts_working_agent_into_awaiting_state(db_file):
    with TestClient(app) as client:
        assert client.get('/agents/agent-1').json()['state'] == 'working'
        _seed(client)
        agent = client.get('/agents/agent-1').json()
        assert agent['state'] == 'stuck' and agent['stuck_reason'] == 'Awaiting approval: git_push'
        assert client.get('/agents/agent-2').json()['state'] == 'working'


def test_approve_returns_agent_to_working_and_steers(db_file):
    with TestClient(app) as client:
        aid = _seed(client)
        assert client.post(f'/approvals/{aid}', json={'decision': 'approved'}).json()['status'] == 'approved'
        agent = client.get('/agents/agent-1').json()
        assert agent['state'] == 'working' and agent['stuck_reason'] is None
        assert 'Approved: git_push' in agent['summary']


def test_deny_steers_agent_with_denial(db_file):
    with TestClient(app) as client:
        aid = _seed(client)
        assert client.post(f'/approvals/{aid}', json={'decision': 'denied'}).json()['status'] == 'denied'
        agent = client.get('/agents/agent-1').json()
        assert agent['state'] == 'working' and 'Denied: git_push' in agent['summary']


def test_agent_not_awaiting_is_left_alone(db_file):
    with TestClient(app) as client:
        aid = _seed(client)
        client.post('/agents/agent-1/pause')  # operator moved it on meanwhile
        client.post(f'/approvals/{aid}', json={'decision': 'approved'})
        assert client.get('/agents/agent-1').json()['state'] == 'paused'
