import asyncio
import base64
import json
import logging

import httpx

from app.alerts import StuckAlerts
from app.chert import ChertClient, ChertError, livekit_jwt

ENV = {'CHERT_SIGNING_SECRET': 'sig-SECRET', 'CHERT_API_KEY': 'key-SECRET', 'CHERT_PROJECT_ID': 'proj-1',
       'CHERT_LINE_ID': 'line-1', 'ALERT_TO': '+15555550123', 'LIVEKIT_URL': 'wss://lk.example.com',
       'LIVEKIT_API_KEY': 'lkkey', 'LIVEKIT_API_SECRET': 'lk-SECRET', 'AGENT_NAME': 'eris'}
JPEG = b'\xff\xd8fakejpeg'


def recorder(routes):
    calls = []
    def handler(request):
        calls.append(request)
        for (method, suffix), response in routes.items():
            if request.method == method and str(request.url).endswith(suffix):
                return response(request) if callable(response) else response
        return httpx.Response(404)
    return calls, httpx.MockTransport(handler)


def messaging_routes(frame=True):
    routes = {
        ('POST', '/api/v1/send'): httpx.Response(200, json={'status': 'sent', 'lead_id': 'chat-9', 'message_id': 'm1'}),
        ('POST', '/api/v1/attachments'): httpx.Response(200, json={
            'attachment_id': 'att_1', 'upload_url': 'https://upload.example.com/u/1', 'required_headers': {'x-amz': 'y'}}),
        ('PUT', '/u/1'): httpx.Response(200),
        ('POST', '/api/v1/chats/chat-9/messages'): httpx.Response(200, json={'message': {'id': 'm2'}}),
        ('GET', '/frame.jpg'): httpx.Response(200, content=JPEG, headers={'content-type': 'image/jpeg'}) if frame else httpx.Response(503),
    }
    return routes


def test_imessage_sends_text_then_frame_as_attachment():
    calls, transport = recorder(messaging_routes())
    result = asyncio.run(ChertClient(ENV, transport=transport).send_imessage('Agent 1 is stuck: v1 or v2 endpoint?'))
    assert result == {'text': True, 'image': True}
    sent = [c for c in calls if str(c.url).endswith('/api/v1/send')][0]
    assert json.loads(sent.content) == {'phone': '+15555550123', 'body': 'Agent 1 is stuck: v1 or v2 endpoint?'}
    assert sent.headers['authorization'] == 'Bearer sig-SECRET'
    slot = [c for c in calls if str(c.url).endswith('/api/v1/attachments')][0]
    assert json.loads(slot.content) == {'filename': 'eris-frame.jpg', 'content_type': 'image/jpeg', 'size_bytes': len(JPEG)}
    put = [c for c in calls if c.method == 'PUT'][0]
    assert put.content == JPEG and put.headers['x-amz'] == 'y'
    media = [c for c in calls if str(c.url).endswith('/chats/chat-9/messages')][0]
    assert json.loads(media.content) == {'message': {'parts': [{'type': 'media', 'attachment_id': 'att_1'}]}}


def test_imessage_skips_image_when_frame_unavailable():
    calls, transport = recorder(messaging_routes(frame=False))
    result = asyncio.run(ChertClient(ENV, transport=transport).send_imessage('hi'))
    assert result == {'text': True, 'image': False}
    assert not [c for c in calls if 'attachments' in str(c.url)]


def test_imessage_text_survives_attachment_failure():
    routes = messaging_routes()
    routes[('PUT', '/u/1')] = httpx.Response(500)
    _, transport = recorder(routes)
    assert asyncio.run(ChertClient(ENV, transport=transport).send_imessage('hi')) == {'text': True, 'image': False}


def test_missing_config_names_variables_not_values():
    try:
        asyncio.run(ChertClient({'ALERT_TO': '+1555'}).send_imessage('hi'))
    except ChertError as error:
        assert 'CHERT_SIGNING_SECRET' in str(error) and '+1555' not in str(error)
    else:
        raise AssertionError('expected ChertError')


def test_livekit_jwt_shape():
    token = livekit_jwt('k', 's', identity='me', video={'room': 'r'}, ttl=60, now=1000)
    claims = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '=='))
    assert claims == {'iss': 'k', 'sub': 'me', 'nbf': 1000, 'exp': 1060, 'video': {'room': 'r'}}


def call_routes(events, state):
    def twirp(name):
        def respond(request):
            state.setdefault(name, []).append(json.loads(request.content))
            if name == 'ListParticipants':
                return httpx.Response(200, json={'participants': [{'identity': 'agent-AJ_1', 'kind': 'AGENT'}]})
            return httpx.Response(200, json={})
        return respond
    return {
        ('POST', '/twirp/livekit.RoomService/CreateRoom'): twirp('CreateRoom'),
        ('POST', '/twirp/livekit.AgentDispatchService/CreateDispatch'): twirp('CreateDispatch'),
        ('POST', '/twirp/livekit.RoomService/ListParticipants'): twirp('ListParticipants'),
        ('POST', '/twirp/livekit.RoomService/UpdateRoomMetadata'): twirp('UpdateRoomMetadata'),
        ('POST', '/twirp/livekit.RoomService/DeleteRoom'): twirp('DeleteRoom'),
        ('POST', '/v1/calls'): httpx.Response(201, json={'data': {'id': 'call-7'}, 'request_id': 'r'}),
        ('GET', '/v1/calls/call-7/events'): lambda request: httpx.Response(200, json={'data': [{'type': t} for t in events.pop(0)] if events else []}),
    }


def test_call_creates_room_dispatches_agent_and_posts_customer_managed_call():
    state = {}
    events = [[], ['bridge_ready'], ['call.ended']]
    calls, transport = recorder(call_routes(events, state))
    async def run():
        client = ChertClient(ENV, transport=transport, sleep=lambda s: asyncio.sleep(0))
        call_id = await client.place_call('Agent 1 is stuck: v1 or v2 endpoint?')
        await asyncio.gather(*client.tasks)
        return call_id
    assert asyncio.run(run()) == 'call-7'
    room = state['CreateRoom'][0]
    assert json.loads(room['metadata'])['alert_reason'] == 'Agent 1 is stuck: v1 or v2 endpoint?'
    dispatch = state['CreateDispatch'][0]
    assert dispatch['agent_name'] == 'eris' and dispatch['room'] == room['name']
    post = [c for c in calls if c.method == 'POST' and str(c.url) == 'https://facetime.trychert.com/api/v1/calls'][0]
    body = json.loads(post.content)
    assert post.headers['authorization'] == 'Bearer key-SECRET' and post.headers['x-chert-project-id'] == 'proj-1'
    assert 8 <= len(post.headers['idempotency-key']) <= 200
    assert body['mode'] == 'customer_managed' and body['direction'] == 'outbound' and body['line_id'] == 'line-1'
    assert body['destination'] == '+15555550123' and body['destination_type'] == 'phone'
    assert body['media'] == {'audio': True, 'video': True} and body['livekit_url'] == 'wss://lk.example.com'
    assert body['remote_participant_identity'] == 'agent-AJ_1'
    claims = json.loads(base64.urlsafe_b64decode(body['participant_token'].split('.')[1] + '=='))
    assert claims['sub'].startswith('chert-bridge-') and claims['video']['room'] == room['name'] and claims['video']['roomJoin']
    # bridge_ready -> room metadata keeps the reason and adds the signal the supervisor waits for
    meta = json.loads(state['UpdateRoomMetadata'][0]['metadata'])
    assert meta['chert_bridge_ready'] is True and meta['chert_call'] == 'call-7' and meta['alert_reason'].startswith('Agent 1')
    assert state['DeleteRoom']  # terminal event -> room removed


def test_call_failure_deletes_the_room():
    state = {}
    routes = call_routes([], state)
    routes[('POST', '/v1/calls')] = httpx.Response(409)
    _, transport = recorder(routes)
    async def run():
        await ChertClient(ENV, transport=transport, sleep=lambda s: asyncio.sleep(0)).place_call('x')
    try:
        asyncio.run(run())
    except httpx.HTTPStatusError:
        pass
    else:
        raise AssertionError('expected failure')
    assert state['DeleteRoom']


def test_dry_run_logs_and_sends_nothing_and_hides_secrets(monkeypatch, caplog):
    monkeypatch.setenv('ALERT_TO', '+15555550123')
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    sent = []
    async def sender(message):
        sent.append(message)
    calls, transport = recorder({})
    alerts = StuckAlerts('t', channels=('ntfy', 'imessage', 'facetime_call'), mode='text_then_call', sender=sender,
                         dry_run=True, chert=ChertClient(ENV, transport=transport))
    with caplog.at_level(logging.WARNING):
        asyncio.run(alerts.dispatch('Agent 2 needs approval: git push'))
    assert sent == [] and calls == []
    text = caplog.text
    assert '[dry-run] ntfy' in text and '[dry-run] imessage' in text and '[dry-run] facetime_call' in text
    assert 'Agent 2 needs approval: git push' in text
    assert '+15555550123' not in text and '***0123' in text and 'SECRET' not in text


def test_dry_run_follows_environment(monkeypatch):
    monkeypatch.setenv('ALERT_DRY_RUN', '1')
    assert StuckAlerts('t').dry_run is True
    monkeypatch.setenv('ALERT_DRY_RUN', '')
    assert StuckAlerts('t').dry_run is False


def test_ladder_text_then_call_order_and_failure_does_not_log_secrets(caplog):
    order = []
    class Fake:
        async def send_imessage(self, m): order.append('imessage'); raise httpx.ConnectError('https://x?key=key-SECRET')
        async def place_call(self, m): order.append('call')
    alerts = StuckAlerts(None, channels=('imessage', 'facetime_call'), mode='text_then_call', dry_run=False, chert=Fake())
    with caplog.at_level(logging.WARNING):
        asyncio.run(alerts.dispatch('Agent 1 is stuck: x'))
    assert order == ['imessage', 'call'] and 'SECRET' not in caplog.text
