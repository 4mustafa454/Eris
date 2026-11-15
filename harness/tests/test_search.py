from fastapi.testclient import TestClient
from app.main import app


def test_search_returns_matching_sessions_and_updates_with_fts_triggers(db_file):
    with TestClient(app) as client:
        sid = client.post('/sessions', json={'channel': 'web'}).json()['id']
        client.post(f'/sessions/{sid}/messages', json={'role': 'user', 'text': 'Please use the v2 endpoint.'})
        hits = client.get('/search', params={'q': 'endpoint'}).json()
        assert len(hits) == 1 and hits[0]['session_id'] == sid
        assert 'endpoint' in hits[0]['snippet'] and hits[0]['created_at']
        assert client.get('/search', params={'q': 'missingword'}).json() == []
        assert client.get('/search', params={'q': '"unterminated'}).json() == []
        assert client.get('/search', params={'q': 'v2-endpoint?'}).json()[0]['session_id'] == sid
