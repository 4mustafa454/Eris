"""Masked settings and provider checks; secrets stay in the harness environment file."""
import os
import re
import shutil
import tempfile
import threading
from pathlib import Path
from dataclasses import replace

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from .. import db
from ..config import HARNESS_DIR
from ..deps import get_conn

router = APIRouter()
_LOCK = threading.Lock()
SECRETS = ('OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY', 'ANTHROPIC_API_KEY',
           'CLAUDE_CODE_OAUTH_TOKEN', 'LLM_API_KEY', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'NTFY_TOPIC')
DEFAULTS = {'STT_PROVIDER': 'deepgram', 'TTS_PROVIDER': 'deepgram', 'LLM_PROVIDER': 'openai',
            'LLM_BASE_URL': '', 'LLM_MODEL': 'gpt-5-mini', 'LIVEKIT_URL': '',
            'CODEX_MODEL': 'gpt-6.1-terra', 'CODEX_REASONING': 'medium',
            'ALERT_CHANNELS': 'ntfy', 'ALERT_MODE': 'text'}
PROVIDERS = {'stt': ['deepgram', 'elevenlabs', 'openai-compatible'],
             'tts': ['deepgram', 'elevenlabs', 'openai-compatible'],
             'llm': ['openai', 'openai-compatible'], 'workers': ['claude', 'codex'],
             'alerts': ['ntfy', 'imessage', 'facetime_call']}


def _mask(value):
    if not value:
        return {'set': False, 'value': None}
    masked = value[:3] + '…' + value[-4:] if len(value) > 7 else '••••'
    return {'set': True, 'value': masked}


def _config(conn):
    rows = dict(conn.execute('SELECT key, value FROM settings').fetchall())
    return {key: rows.get(key, os.environ.get(key, default)) for key, default in DEFAULTS.items()}


def _document(conn):
    out = _config(conn)
    out.update({key: _mask(os.environ.get(key)) for key in SECRETS})
    out['providers'] = PROVIDERS
    return out


def _save_secrets(values):
    path = Path(os.environ.get('ERIS_ENV_FILE') or HARNESS_DIR / '.env')
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        lines = path.read_text().splitlines()
    except FileNotFoundError:
        lines = []
    remaining = dict(values)
    new_lines = []
    for line in lines:
        name = line.partition('=')[0].strip().removeprefix('export ').strip()
        if name in values:
            if name in remaining:
                new_lines.append(f'{name}={remaining.pop(name)}')
        else:
            new_lines.append(line)
    new_lines.extend(f'{name}={value}' for name, value in remaining.items())
    fd, temporary = tempfile.mkstemp(prefix='.eris-env-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write('\n'.join(new_lines) + '\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@router.get('/settings')
def get_settings(conn=Depends(get_conn)):
    return _document(conn)


@router.put('/settings')
def put_settings(body: dict, request: Request, conn=Depends(get_conn)):
    allowed = set(SECRETS) | set(DEFAULTS)
    if any(key not in allowed for key in body):
        raise HTTPException(422, 'unknown setting')
    if any(not isinstance(value, str) or '\n' in value or '\r' in value or '\x00' in value for value in body.values()):
        raise HTTPException(422, 'settings must be single-line strings')
    for key, allowed_values in {'STT_PROVIDER': PROVIDERS['stt'], 'TTS_PROVIDER': PROVIDERS['tts'],
                                'LLM_PROVIDER': PROVIDERS['llm'], 'ALERT_MODE': ['text', 'call', 'text_then_call'],
                                'CODEX_REASONING': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']}.items():
        if key in body and body[key] not in allowed_values:
            raise HTTPException(422, f'invalid {key}')
    if 'ALERT_CHANNELS' in body:
        channels = [part.strip() for part in body['ALERT_CHANNELS'].split(',')]
        if len(set(channels)) != len(channels) or any(part not in PROVIDERS['alerts'] for part in channels):
            raise HTTPException(422, 'invalid ALERT_CHANNELS')
    if 'NTFY_TOPIC' in body and body['NTFY_TOPIC'] and not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', body['NTFY_TOPIC']):
        raise HTTPException(422, 'invalid NTFY_TOPIC')
    secrets = {key: value for key, value in body.items() if key in SECRETS}
    with _LOCK:
        try:
            conn.execute('BEGIN IMMEDIATE')
            for key, value in body.items():
                if key in DEFAULTS:
                    conn.execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, value))
            if secrets:
                _save_secrets(secrets)
            conn.execute('COMMIT')
        except Exception:
            if conn.in_transaction:
                conn.execute('ROLLBACK')
            raise HTTPException(500, 'could not save settings') from None
        os.environ.update(secrets)
        current = _config(conn)
        alerts = getattr(request.app.state, 'alerts', None)
        if alerts:
            alerts.topic = os.environ.get('NTFY_TOPIC') or None
            alerts.channels = tuple(current['ALERT_CHANNELS'].split(','))
            alerts.mode = current['ALERT_MODE']
        manager = getattr(request.app.state, 'manager', None)
        if manager:
            manager.settings = replace(manager.settings, codex_model=current['CODEX_MODEL'],
                                       codex_reasoning=current['CODEX_REASONING'])
            request.app.state.settings = manager.settings
            for container in manager._containers.values():
                container.settings = manager.settings
    return _document(conn)


async def _check_http(url, headers=None):
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(url, headers=headers)
        return {'ok': response.is_success, 'detail': f'Provider returned HTTP {response.status_code}'}
    except httpx.HTTPError:
        return {'ok': False, 'detail': 'Provider could not be reached'}


@router.post('/settings/test/{provider}')
async def test_provider(provider: str, conn=Depends(get_conn)):
    config = _config(conn)
    if provider == 'openai':
        key = os.environ.get('OPENAI_API_KEY')
        return await _check_http('https://api.openai.com/v1/models', {'Authorization': f'Bearer {key}'}) if key else {'ok': False, 'detail': 'OPENAI_API_KEY is not set'}
    if provider == 'deepgram':
        key = os.environ.get('DEEPGRAM_API_KEY')
        return await _check_http('https://api.deepgram.com/v1/projects', {'Authorization': f'Token {key}'}) if key else {'ok': False, 'detail': 'DEEPGRAM_API_KEY is not set'}
    if provider == 'ollama':
        base = (config['LLM_BASE_URL'] or 'http://localhost:11434/v1').rstrip('/')
        return await _check_http(base + '/models')
    if provider == 'livekit':
        configured = bool(config['LIVEKIT_URL'] and os.environ.get('LIVEKIT_API_KEY') and os.environ.get('LIVEKIT_API_SECRET'))
        return {'ok': configured, 'detail': 'LiveKit credentials configured; connectivity not tested' if configured else 'LiveKit configuration is incomplete'}
    if provider == 'claude':
        configured = bool(os.environ.get('CLAUDE_CODE_OAUTH_TOKEN') or os.environ.get('ANTHROPIC_API_KEY'))
        return {'ok': configured, 'detail': 'Claude credential configured; worker execution not tested' if configured else 'Claude credential is not set'}
    if provider == 'codex':
        present = (Path.home() / '.codex' / 'auth.json').is_file()
        return {'ok': present, 'detail': 'Codex auth file is present; authentication not tested' if present else 'Codex auth file is missing'}
    if provider == 'chert':
        present = shutil.which('chert') is not None
        return {'ok': present, 'detail': 'Chert CLI is available; line connectivity not tested' if present else 'Chert CLI is not on PATH'}
    if provider == 'ntfy':
        present = bool(os.environ.get('NTFY_TOPIC'))
        return {'ok': present, 'detail': 'ntfy topic is configured; no notification sent' if present else 'NTFY_TOPIC is not set'}
    raise HTTPException(404, 'unknown provider')
