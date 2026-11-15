import asyncio
import json
import time

from fastapi.testclient import TestClient

from app.main import app


def tool_call(identifier, name, args):
    return {'id': identifier, 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}


def test_chat_uses_shared_prompt_and_logs_read_and_mutating_tools_once(db_file, monkeypatch):
    seen = []
    async def complete(messages, tools):
        seen.append((list(messages), tools))
        if len(seen) == 1:
            return {'content': None, 'tool_calls': [tool_call('a', 'get_status', {}), tool_call('b', 'send_task', {'n': 1, 'instruction': 'Use v2'})]}
        return {'content': 'Agent 1 was told to use v2.'}
    monkeypatch.setattr(app.state, 'chat_completion', complete, raising=False)
    with TestClient(app) as client:
        response = client.post('/chat', json={'text': 'Tell agent 1 to use v2.'})
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['reply'] == 'Agent 1 was told to use v2.'
        detail = client.get('/sessions/' + result['session_id']).json()
        assert detail['channel'] == 'web'
        assert [(m['role'], m['text']) for m in detail['messages']] == [('user', 'Tell agent 1 to use v2.'), ('pm', result['reply'])]
        assert [a['tool'] for a in detail['actions']] == ['get_status', 'send_task']
        assert [a['tool'] for a in result['actions']] == ['get_status', 'send_task']
        assert 'You are Eris' in seen[0][0][0]['content']
        assert {t['function']['name'] for t in seen[0][1]} >= {'get_status', 'send_task', 'decide_approval'}


def test_chat_stop_all_is_logged_to_its_session_once(db_file, monkeypatch):
    calls = []
    async def complete(messages, tools):
        calls.append(1)
        return {'tool_calls': [tool_call('a', 'stop_all', {})]} if len(calls) == 1 else {'content': 'Stopped.'}
    monkeypatch.setattr(app.state, 'chat_completion', complete, raising=False)
    with TestClient(app) as client:
        result = client.post('/chat', json={'text': 'Stop everything'}).json()
        detail = client.get('/sessions/' + result['session_id']).json()
        assert [a['tool'] for a in detail['actions']] == ['stop_all']
        assert detail['actions'][0]['session_id'] == result['session_id']


def test_chat_continues_existing_session_and_handles_missing_session(db_file, monkeypatch):
    captured = []
    async def complete(messages, tools):
        captured.extend(messages)
        return {'content': 'The earlier call discussed v2.'}
    monkeypatch.setattr(app.state, 'chat_completion', complete, raising=False)
    with TestClient(app) as client:
        sid = client.post('/sessions', json={'channel': 'facetime'}).json()['id']
        client.post(f'/sessions/{sid}/messages', json={'role': 'user', 'text': 'Remember v2.'})
        response = client.post('/chat', json={'session_id': sid, 'text': 'What did I say?'})
        assert response.status_code == 200 and response.json()['session_id'] == sid
        assert any(m['content'] == 'Remember v2.' for m in captured)
        assert client.post('/chat', json={'session_id': 'missing', 'text': 'Hi'}).status_code == 404
        assert client.post('/chat', json={'text': '  '}).status_code == 422


def test_idle_chat_is_summarized_and_ended(db_file, monkeypatch):
    async def complete(messages, tools):
        if not tools:
            return {'content': 'The user asked for status. Agent 1 is working.'}
        return {'content': 'Agent 1 is working.'}
    monkeypatch.setattr(app.state, 'chat_completion', complete, raising=False)
    with TestClient(app) as client:
        sid = client.post('/chat', json={'text': 'Status?'}).json()['session_id']
        client.portal.call(lambda: app.state.pm_chat.schedule(sid, 0))
        for _ in range(30):
            detail = client.get('/sessions/' + sid).json()
            if detail['ended_at']:
                break
            time.sleep(.02)
        assert detail['summary'] == 'The user asked for status. Agent 1 is working.'
        assert detail['ended_at']


def test_chat_does_not_approve_without_clear_current_user_consent(db_file, monkeypatch):
    from app import db
    replies = []
    async def complete(messages, tools):
        replies.append(1)
        return {'tool_calls': [tool_call('a', 'decide_approval', {'id': 'a1', 'decision': 'approved'})]} if len(replies) == 1 else {'content': 'Please confirm.'}
    monkeypatch.setattr(app.state, 'chat_completion', complete, raising=False)
    with TestClient(app) as client:
        conn = db.connect()
        conn.execute("INSERT INTO approvals (id, agent_id, action, status, created_at) VALUES ('a1', 'agent-1', 'git_push', 'pending', ?)", (db.utcnow(),))
        conn.close()
        result = client.post('/chat', json={'text': 'What is pending?'}).json()
        assert client.get('/approvals', params={'status': 'pending'}).json()[0]['id'] == 'a1'
        assert [a['tool'] for a in result['actions']] == ['decide_approval']
        assert 'clear approval' in result['actions'][0]['result_json']


def test_chat_redacts_configured_secrets_from_prompt_and_log(db_file, monkeypatch):
    secret = 'sk-known-secret-value'
    captured = []
    async def complete(messages, tools):
        captured.extend(messages)
        return {'content': 'Received ' + secret}
    monkeypatch.setenv('OPENAI_API_KEY', secret)
    monkeypatch.setattr(app.state, 'chat_completion', complete, raising=False)
    with TestClient(app) as client:
        result = client.post('/chat', json={'text': 'The value is ' + secret}).json()
        detail = client.get('/sessions/' + result['session_id']).json()
        assert secret not in str(captured) + str(detail) + str(result)
        assert '[redacted]' in detail['messages'][0]['text']


def test_chat_dispatches_all_shared_tools_to_harness_routes_once(db_file, monkeypatch):
    from app import db
    attempts = []
    calls = [
        tool_call('1', 'explain_agent', {'n': 1}),
        tool_call('2', 'show_grid', {}),
        tool_call('3', 'focus_agent', {'n': 2}),
        tool_call('4', 'search_history', {'query': 'status'}),
        tool_call('5', 'create_task', {'title': 'New', 'instruction': 'Write tests', 'agent': 1}),
        tool_call('6', 'pause_agent', {'n': 1}),
        tool_call('7', 'resume_agent', {'n': 1}),
        tool_call('8', 'decide_approval', {'id': 'ap-test', 'decision': 'approved'}),
        tool_call('9', 'stop_all', {}),
    ]
    async def complete(messages, tools):
        attempts.append(1)
        return {'tool_calls': calls} if len(attempts) == 1 else {'content': 'Done.'}
    monkeypatch.setattr(app.state, 'chat_completion', complete, raising=False)
    with TestClient(app) as client:
        conn = db.connect()
        conn.execute("INSERT INTO approvals (id, agent_id, action, status, created_at) VALUES ('ap-test', 'agent-1', 'git_push', 'pending', ?)", (db.utcnow(),))
        conn.close()
        result = client.post('/chat', json={'text': 'Yes, approve and perform these actions.'})
        assert result.status_code == 200, result.text
        data = result.json()
        assert [a['tool'] for a in data['actions']] == [c['function']['name'] for c in calls]
        assert all(a['session_id'] == data['session_id'] for a in data['actions'])
        assert client.get('/approvals?status=approved').json()[0]['id'] == 'ap-test'
        assert any(t['title'] == 'New' and t['status'] == 'queued' for t in client.get('/tasks').json())
