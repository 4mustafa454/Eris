"""Outbound alert channels over Chert: iMessage (Messaging API) and a FaceTime call (Calls API).

Endpoints are the ones in docs.trychert.com (checked 2026-11-15):
  Messaging  https://console.trychert.com/api/v1  Authorization: Bearer <CHERT_SIGNING_SECRET>
    POST /send {phone, body}                       -> {lead_id (= chat id), message_id}
    POST /attachments {filename, content_type, size_bytes} -> {attachment_id, upload_url, required_headers}
    PUT  <upload_url> raw bytes (+ required_headers)
    POST /chats/{lead_id}/messages {message: {parts: [{type: media, attachment_id}]}}
  Calls      https://facetime.trychert.com/api/v1  Authorization: Bearer <CHERT_API_KEY>, X-Chert-Project-Id
    POST /calls (Idempotency-Key) mode=customer_managed -> 201 {data: {id}}
    GET  /calls/{id}/events,  POST /calls/{id}/end
For the call we also drive LiveKit (Twirp, signed with LIVEKIT_API_KEY/SECRET): create the room with the alert reason in
its metadata, explicitly dispatch the supervisor (AGENT_NAME), mint the bridge token, and when Chert reports bridge_ready
set `chert_bridge_ready` in the room metadata (what `chert dev` does for inbound calls), so the supervisor's existing
greet-on-bridge_ready path fires.

Secrets are never logged: failures log the channel and the exception type or HTTP status, nothing else.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import time
import uuid

import httpx

log = logging.getLogger(__name__)

MESSAGING_URL = 'https://console.trychert.com/api/v1'
CALLS_URL = 'https://facetime.trychert.com/api/v1'
DEFAULT_FRAME_URL = 'http://localhost:8788/frame.jpg'
BRIDGE_PREFIX = 'chert-bridge-'  # the supervisor treats these identities as the caller (supervisor/src/greeting.mjs)


class ChertError(Exception):
    """A configuration or delivery problem. The message never contains a secret."""


def mask_number(number):
    digits = (number or '').strip()
    return '***' + digits[-4:] if len(digits) > 4 else '***'


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def livekit_jwt(api_key, api_secret, *, identity, video, ttl=600, now=None):
    """HS256 LiveKit access token. `video` is the grants object, e.g. {'room': 'x', 'roomJoin': True}."""
    now = int(now if now is not None else time.time())
    claims = {'iss': api_key, 'sub': identity, 'nbf': now, 'exp': now + ttl, 'video': video}
    head = _b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    body = _b64(json.dumps(claims, separators=(',', ':')).encode())
    sig = hmac.new(api_secret.encode(), f'{head}.{body}'.encode(), hashlib.sha256).digest()
    return f'{head}.{body}.{_b64(sig)}'


def _event_names(payload):
    """Event type strings from a GET /calls/{id}/events body, whatever the envelope (list, {data: [...]}, {events: [...]})."""
    data = payload.get('data', payload) if isinstance(payload, dict) else payload
    if isinstance(data, dict):
        data = data.get('events', data.get('items', []))
    names = []
    for item in data if isinstance(data, list) else []:
        if isinstance(item, dict):
            value = item.get('type') or item.get('event') or item.get('name') or ''
            names.append(str(value))
    return names


TERMINAL_HINTS = ('ended', 'failed', 'declined', 'cancel', 'timeout', 'terminal', 'busy', 'missed')


class ChertClient:
    """Sends one alert over Chert. `env` is os.environ-like; `transport` lets tests mock every HTTP call."""

    def __init__(self, env, *, transport=None, sleep=asyncio.sleep, clock=time.time):
        self.env = env
        self.transport = transport
        self.sleep = sleep
        self.clock = clock
        self.tasks = set()  # background call watchers

    def _get(self, name):
        value = (self.env.get(name) or '').strip()
        return None if not value or value.startswith('YOUR_') else value

    def _need(self, *names):
        missing = [n for n in names if not self._get(n)]
        if missing:
            raise ChertError('missing in harness/.env: ' + ', '.join(missing))
        return [self._get(n) for n in names]

    def _client(self):
        return httpx.AsyncClient(timeout=10, transport=self.transport)

    # ---- iMessage ---------------------------------------------------------------------------------------------

    async def fetch_frame(self):
        """The supervisor's current frame as JPEG bytes, or None when it is not available."""
        url = self._get('FRAME_URL') or DEFAULT_FRAME_URL
        try:
            async with httpx.AsyncClient(timeout=2, transport=self.transport) as client:
                response = await client.get(url)
            if response.status_code == 200 and response.content and 'image' in response.headers.get('content-type', 'image/jpeg'):
                return response.content
        except httpx.HTTPError:
            pass
        return None

    async def send_imessage(self, text):
        secret, phone = self._need('CHERT_SIGNING_SECRET', 'ALERT_TO')
        headers = {'authorization': f'Bearer {secret}', 'content-type': 'application/json'}
        frame = await self.fetch_frame()
        async with self._client() as client:
            sent = await client.post(f'{MESSAGING_URL}/send', headers=headers, json={'phone': phone, 'body': text})
            sent.raise_for_status()
            if frame is None:
                return {'text': True, 'image': False}
            try:
                chat_id = sent.json()['lead_id']  # docs: lead_id is the chat id for /chats/{id} routes
                slot = await client.post(f'{MESSAGING_URL}/attachments', headers=headers, json={
                    'filename': 'eris-frame.jpg', 'content_type': 'image/jpeg', 'size_bytes': len(frame)})
                slot.raise_for_status()
                slot = slot.json()
                upload = await client.put(slot['upload_url'], content=frame,
                                          headers={**(slot.get('required_headers') or {}), 'content-length': str(len(frame))})
                upload.raise_for_status()
                media = await client.post(f'{MESSAGING_URL}/chats/{chat_id}/messages', headers=headers, json={
                    'message': {'parts': [{'type': 'media', 'attachment_id': slot['attachment_id']}]}})
                media.raise_for_status()
            except (httpx.HTTPError, KeyError, ValueError) as error:
                log.warning('iMessage image attachment failed (%s); the text was sent', _why(error))
                return {'text': True, 'image': False}
        return {'text': True, 'image': True}

    # ---- FaceTime call ----------------------------------------------------------------------------------------

    async def _twirp(self, client, service, method, body, *, grants):
        url, key, secret = self._need('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET')
        token = livekit_jwt(key, secret, identity='eris-harness', video=grants, ttl=60, now=self.clock())
        base = url.replace('wss://', 'https://', 1).replace('ws://', 'http://', 1).rstrip('/')
        response = await client.post(f'{base}/twirp/livekit.{service}/{method}', json=body,
                                     headers={'authorization': f'Bearer {token}'})
        response.raise_for_status()
        return response.json() if response.content else {}

    async def place_call(self, reason, *, agent_wait=20.0):
        """Create room + dispatch, mint the bridge token, POST /calls. Returns the call id; a watcher finishes the rest."""
        api_key, project, line, to, lk_url, lk_key, lk_secret = self._need(
            'CHERT_API_KEY', 'CHERT_PROJECT_ID', 'CHERT_LINE_ID', 'ALERT_TO', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET')
        agent_name = self._get('AGENT_NAME') or 'eris'
        room = f'eris-alert-{uuid.uuid4().hex[:12]}'
        admin = {'roomCreate': True, 'roomAdmin': True, 'room': room, 'roomList': True}
        metadata = {'alert_reason': reason, 'alert': True}
        async with self._client() as client:
            await self._twirp(client, 'RoomService', 'CreateRoom',
                              {'name': room, 'metadata': json.dumps(metadata), 'empty_timeout': 120}, grants=admin)
            try:
                await self._twirp(client, 'AgentDispatchService', 'CreateDispatch',
                                  {'agent_name': agent_name, 'room': room, 'metadata': json.dumps(metadata)}, grants=admin)
                agent_identity = await self._wait_for_agent(client, room, admin, agent_wait)
                bridge = BRIDGE_PREFIX + uuid.uuid4().hex[:12]
                token = livekit_jwt(lk_key, lk_secret, identity=bridge, ttl=3600, now=self.clock(), video={
                    'room': room, 'roomJoin': True, 'canPublish': True, 'canSubscribe': True})
                created = await client.post(f'{CALLS_URL}/calls', headers={
                    'authorization': f'Bearer {api_key}', 'x-chert-project-id': project,
                    'idempotency-key': f'eris-alert-{room}', 'content-type': 'application/json'}, json={
                    'direction': 'outbound', 'mode': 'customer_managed', 'line_id': line,
                    'destination': to, 'destination_type': 'email' if '@' in to else 'phone',
                    'media': {'audio': True, 'video': True}, 'livekit_url': lk_url,
                    'participant_token': token, 'remote_participant_identity': agent_identity})
                created.raise_for_status()
                call_id = created.json()['data']['id']
            except Exception:
                await self._delete_room(client, room, admin)
                raise
        watcher = asyncio.create_task(self._watch_call(call_id, room, metadata, project, api_key, admin))
        self.tasks.add(watcher)
        watcher.add_done_callback(self.tasks.discard)
        return call_id

    async def _wait_for_agent(self, client, room, grants, timeout):
        """The supervisor's identity once it has joined the room (Chert needs it as remote_participant_identity)."""
        deadline = self.clock() + timeout
        while True:
            listing = await self._twirp(client, 'RoomService', 'ListParticipants', {'room': room}, grants=grants)
            for p in listing.get('participants', []):
                if p.get('kind') in (4, 'AGENT'):
                    return p['identity']
            if self.clock() >= deadline:
                raise ChertError('the supervisor did not join the alert room (is it running with AGENT_NAME and your LiveKit project?)')
            await self.sleep(0.5)

    async def _delete_room(self, client, room, grants):
        try:
            await self._twirp(client, 'RoomService', 'DeleteRoom', {'room': room}, grants=grants)
        except Exception as error:
            log.warning('could not delete alert room (%s)', _why(error))

    async def _watch_call(self, call_id, room, metadata, project, api_key, admin, *, give_up=150.0, poll=1.0):
        """On bridge_ready tell the supervisor (room metadata); on a terminal event, or no answer, clean up."""
        headers = {'authorization': f'Bearer {api_key}', 'x-chert-project-id': project}
        deadline = self.clock() + give_up
        ready = False
        try:
            async with self._client() as client:
                while self.clock() < deadline:
                    response = await client.get(f'{CALLS_URL}/calls/{call_id}/events', headers=headers)
                    names = _event_names(response.json()) if response.status_code == 200 else []
                    if not ready and any(n in ('bridge_ready', 'call.started', 'call.bridge_ready') for n in names):
                        ready = True
                        deadline = self.clock() + 330  # a call is capped at 5 minutes
                        merged = {**metadata, 'chert_call': call_id, 'chert_bridge_ready': True,
                                  'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(self.clock()))}
                        await self._twirp(client, 'RoomService', 'UpdateRoomMetadata',
                                          {'room': room, 'metadata': json.dumps(merged)}, grants=admin)
                    if any(any(h in n.lower() for h in TERMINAL_HINTS) for n in names):
                        break
                    await self.sleep(poll)
                else:
                    if not ready:  # nobody answered: stop dialing
                        await client.post(f'{CALLS_URL}/calls/{call_id}/end', headers={
                            **headers, 'idempotency-key': f'eris-end-{call_id}', 'content-type': 'application/json'}, json={})
                await self._delete_room(client, room, admin)
        except Exception as error:
            log.warning('alert call watcher stopped (%s)', _why(error))


def _why(error):
    """Safe description of a failure: the type, plus the HTTP status. Never the URL, headers or body."""
    if isinstance(error, httpx.HTTPStatusError):
        return f'HTTP {error.response.status_code}'
    return type(error).__name__
