import os
from pathlib import Path

from fastapi.testclient import TestClient

from app import db
from app.main import app


def test_settings_mask_secrets_and_save_them_only_in_the_isolated_env_file(db_file, tmp_path, monkeypatch):
    env_file = tmp_path / 'settings.env'
    env_file.write_text('# retain comment\nOTHER=keep\n')
    monkeypatch.setenv('ERIS_ENV_FILE', str(env_file))
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    secret = 'sk-secret-test-value-1234'
    with TestClient(app) as client:
        response = client.put('/settings', json={'OPENAI_API_KEY': secret, 'LLM_MODEL': 'local-model'})
        assert response.status_code == 200
        assert secret not in response.text
        assert response.json()['OPENAI_API_KEY'] == {'set': True, 'value': 'sk-…1234'}
        assert response.json()['LLM_MODEL'] == 'local-model'
        assert secret not in client.get('/settings').text
        conn = db.connect()
        assert secret not in str(conn.execute('SELECT * FROM settings').fetchall())
        conn.close()
    assert secret in env_file.read_text() and '# retain comment' in env_file.read_text()
    assert os.stat(env_file).st_mode & 0o777 == 0o600
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)


def test_settings_reject_bad_input_and_provider_checks_are_safe(db_file, tmp_path, monkeypatch):
    monkeypatch.setattr(Path, 'home', staticmethod(lambda: tmp_path))
    with TestClient(app) as client:
        assert client.put('/settings', json={'UNKNOWN': 'x'}).status_code == 422
        assert client.put('/settings', json={'OPENAI_API_KEY': 'x\nY=z'}).status_code == 422
        assert client.put('/settings', json={'ALERT_MODE': 'bad'}).status_code == 422
        for provider in ('deepgram', 'openai', 'ollama', 'livekit', 'claude', 'codex', 'chert', 'ntfy'):
            if provider == 'ollama':
                continue  # no real network in tests
            response = client.post('/settings/test/' + provider)
            assert response.status_code == 200 and isinstance(response.json()['ok'], bool)
            assert isinstance(response.json()['detail'], str)
        assert client.post('/settings/test/unknown').status_code == 404
