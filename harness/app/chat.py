"""Web PM: the shared prompt and tool schemas, executed through harness routes."""
import asyncio
import json
import os
import re
from datetime import datetime, timezone

import httpx
import jsonschema
from fastapi import HTTPException

from . import db, pm, sessions
from .routes.settings import SECRETS, _config

READ_ONLY = frozenset({'get_status', 'explain_agent', 'show_grid', 'focus_agent', 'search_history'})
MAX_TOOL_ROUNDS = 8
IDLE_SECONDS = 600


def _redact(value):
    for key in SECRETS:
        secret = os.environ.get(key)
        if secret:
            value = value.replace(secret, '[redacted]')
    return value


def _redact_value(value):
    if isinstance(value, str):
        return _redact(value)
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _redact_value(item) for key, item in value.items()}
    return value


def _clear_decision(text, decision):
    """Require an explicit decision in the user's current turn before approving or denying."""
    affirmative = bool(re.search(r'\b(?:yes|approve|approved|go ahead|do it)\b', text, re.I))
    negative = bool(re.search(r'\b(?:no|deny|denied|reject|decline|do not|don\u2019t|don\'t)\b', text, re.I))
    return (affirmative and not negative) if decision == 'approved' else (negative and not affirmative)


def _agent_id(number):
    if not isinstance(number, int) or isinstance(number, bool) or number < 1:
        raise ValueError('invalid agent number')
    return f'agent-{number}'


class PMChat:
    def __init__(self, app):
        self.app = app
        self.locks = {}
        self.timers = {}

    async def complete(self, messages, tools):
        """Call the configured OpenAI-compatible provider without exposing its error body."""
        conn = db.connect()
        try:
            config = _config(conn)
        finally:
            conn.close()
        base = (config['LLM_BASE_URL'] or 'https://api.openai.com/v1').rstrip('/')
        # Never forward an OpenAI key to an independently configured compatible endpoint.
        key = os.environ.get('OPENAI_API_KEY') if base == 'https://api.openai.com/v1' else os.environ.get('LLM_API_KEY')
        if not key and base == 'https://api.openai.com/v1':
            raise HTTPException(503, 'PM provider is not configured')
        headers = {'Authorization': f'Bearer {key}'} if key else {}
        payload = {'model': config['LLM_MODEL'], 'messages': messages}
        if tools:
            payload['tools'] = tools
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(base + '/chat/completions', json=payload, headers=headers)
                response.raise_for_status()
                return response.json()['choices'][0]['message']
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
            raise HTTPException(502, 'PM provider request failed') from None

    async def _request(self, method, path, *, body=None, params=None):
        transport = httpx.ASGITransport(app=self.app)
        async with httpx.AsyncClient(transport=transport, base_url='http://harness') as client:
            return await client.request(method, path, json=body, params=params)

    async def execute(self, name, args, session_id, user_text=''):
        definitions = {definition['name']: definition for definition in pm.load_tools()}
        if name not in definitions:
            return {'error': 'Unknown tool'}
        try:
            jsonschema.validate(args, definitions[name]['parameters'])
        except jsonschema.ValidationError:
            result = {'error': 'Invalid tool arguments'}
            conn = db.connect()
            try:
                sessions.add_action(conn, session_id, name, args if isinstance(args, dict) else {}, result, None)
            finally:
                conn.close()
            return result

        if name == 'decide_approval' and not _clear_decision(user_text, args['decision']):
            result = {'error': 'A clear approval or denial is required.'}
            conn = db.connect()
            try:
                sessions.add_action(conn, session_id, name, args, result, None)
            finally:
                conn.close()
            return result

        aid = _agent_id(args['n']) if 'n' in args else None
        result = None
        response = None
        if name == 'get_status':
            response = await self._request('GET', '/agents')
        elif name == 'explain_agent':
            response = await self._request('GET', f'/agents/{aid}/log', params={'lines': 40})
        elif name in ('show_grid', 'focus_agent'):
            result = {'available': False, 'detail': 'Video controls are available on calls only.'}
        elif name == 'search_history':
            response = await self._request('GET', '/search', params={'q': args['query']})
        elif name == 'send_task':
            response = await self._request('POST', f'/agents/{aid}/task', body={'instruction': args['instruction'], 'session_id': session_id})
        elif name in ('pause_agent', 'resume_agent'):
            response = await self._request('POST', f"/agents/{aid}/{'pause' if name == 'pause_agent' else 'resume'}", body={'session_id': session_id})
        elif name == 'stop_all':
            token = sessions.action_session.set(session_id)
            try:
                response = await self._request('POST', '/stop-all')
            finally:
                sessions.action_session.reset(token)
        elif name == 'create_task':
            aid = _agent_id(args['agent']) if 'agent' in args else None
            response = await self._request('POST', '/tasks', body={'title': args['title'], 'instruction': args['instruction'], 'agent_id': aid, 'session_id': session_id})
        elif name == 'decide_approval':
            response = await self._request('POST', f"/approvals/{args['id']}", body={'decision': args['decision'], 'session_id': session_id})
        if response is not None:
            result = response.json() if response.is_success else {'error': f'Harness request failed ({response.status_code})'}
        if name in READ_ONLY:
            # Display-only controls have no agent FK when the requested agent does not exist.
            agent_for_log = aid if aid and response is not None and response.status_code != 404 else None
            await self._request('POST', f'/sessions/{session_id}/actions', body={
                'tool': name, 'args': args, 'result': result if isinstance(result, dict) else {'data': result},
                'agent_id': agent_for_log,
            })
        elif response is not None and not response.is_success:
            conn = db.connect()
            try:
                sessions.add_action(conn, session_id, name, args, result, None)
            finally:
                conn.close()
        return result

    async def turn(self, session_id, text):
        async with self.locks.setdefault(session_id, asyncio.Lock()):
            old_timer = self.timers.pop(session_id, None)
            if old_timer:
                old_timer.cancel()
            detail = await self._request('GET', f'/sessions/{session_id}')
            if detail.status_code == 404:
                raise HTTPException(404, 'unknown session')
            if not detail.is_success:
                raise HTTPException(502, 'could not read session')
            previous = detail.json()
            context = (await self._request('GET', '/context')).json()
            messages = [{'role': 'system', 'content': _redact(pm.render_prompt(context))}]
            for message in previous['messages']:
                role = {'user': 'user', 'pm': 'assistant', 'system': 'system'}[message['role']]
                messages.append({'role': role, 'content': _redact(message['text'])})
            text = _redact(text)
            created = await self._request('POST', f'/sessions/{session_id}/messages', body={'role': 'user', 'text': text})
            if not created.is_success:
                raise HTTPException(502, 'could not save message')
            messages.append({'role': 'user', 'content': text})
            definitions = pm.load_tools()
            tools = [{'type': 'function', 'function': definition} for definition in definitions]
            conn = db.connect()
            try:
                start_id = conn.execute('SELECT COALESCE(MAX(id), 0) FROM actions').fetchone()[0]
            finally:
                conn.close()
            try:
                for _ in range(MAX_TOOL_ROUNDS):
                    completion = getattr(self.app.state, 'chat_completion', self.complete)
                    message = await completion(messages, tools)
                    calls = message.get('tool_calls') or []
                    if not calls:
                        reply = message.get('content')
                        if not isinstance(reply, str) or not reply.strip():
                            raise HTTPException(502, 'PM provider returned an empty reply')
                        reply = _redact(reply.strip())
                        stored = await self._request('POST', f'/sessions/{session_id}/messages', body={'role': 'pm', 'text': reply})
                        if not stored.is_success:
                            raise HTTPException(502, 'could not save reply')
                        conn = db.connect()
                        try:
                            actions = [dict(row) for row in conn.execute('SELECT * FROM actions WHERE session_id = ? AND id > ? ORDER BY id', (session_id, start_id))]
                        finally:
                            conn.close()
                        return {'session_id': session_id, 'reply': reply, 'actions': actions}
                    calls = _redact_value(calls)
                    messages.append({'role': 'assistant', 'content': _redact_value(message.get('content')), 'tool_calls': calls})
                    for call in calls:
                        function = call.get('function') or {}
                        try:
                            args = json.loads(function.get('arguments') or '{}')
                        except (ValueError, TypeError):
                            args = None
                        args = _redact_value(args)
                        result = await self.execute(function.get('name'), args, session_id, text)
                        messages.append({'role': 'tool', 'tool_call_id': call.get('id'), 'content': _redact(json.dumps(result))})
                raise HTTPException(502, 'PM exceeded the tool call limit')
            finally:
                self.schedule(session_id)

    def schedule(self, session_id, delay=IDLE_SECONDS):
        old = self.timers.pop(session_id, None)
        if old:
            old.cancel()
        self.timers[session_id] = asyncio.create_task(self._finish_idle(session_id, delay))

    async def _finish_idle(self, session_id, delay):
        try:
            await asyncio.sleep(delay)
            async with self.locks.setdefault(session_id, asyncio.Lock()):
                response = await self._request('GET', f'/sessions/{session_id}')
                if not response.is_success:
                    return
                detail = response.json()
                transcript = _redact('\n'.join(f"{m['role']}: {m['text']}" for m in detail['messages'])[-24000:])
                prompt = [{'role': 'system', 'content': _redact(pm.render_prompt((await self._request('GET', '/context')).json()))},
                          {'role': 'user', 'content': 'Write a concise two or three sentence summary of this conversation and any pending work:\n' + transcript}]
                try:
                    completion = getattr(self.app.state, 'chat_completion', self.complete)
                    result = await completion(prompt, [])
                    summary = _redact(result.get('content', '').strip())
                except Exception:
                    summary = ''
                if not summary:
                    summary = 'The conversation ended. The team status is available in Eris.'
                await self._request('PATCH', f'/sessions/{session_id}', body={'ended_at': db.utcnow(), 'summary': summary})
        finally:
            if self.timers.get(session_id) is asyncio.current_task():
                self.timers.pop(session_id, None)

    def restore(self):
        conn = db.connect()
        try:
            rows = conn.execute("SELECT s.id, MAX(m.created_at) AS last_message FROM sessions s JOIN messages m ON m.session_id = s.id WHERE s.channel = 'web' AND s.ended_at IS NULL GROUP BY s.id").fetchall()
        finally:
            conn.close()
        now = datetime.now(timezone.utc)
        for row in rows:
            try:
                last = datetime.fromisoformat(row['last_message'].replace('Z', '+00:00'))
                self.schedule(row['id'], max(0, IDLE_SECONDS - (now - last).total_seconds()))
            except ValueError:
                self.schedule(row['id'])

    async def close(self):
        pending = list(self.timers.values())
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        self.timers.clear()
