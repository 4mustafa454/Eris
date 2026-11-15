import asyncio
import json

from app import agents, db
from app.alerts import StuckAlerts
from app.routes.events import event_stream
from app.workers import mock


def seed():
    conn = db.connect()
    mock.seed_agents(conn)
    conn.close()


def test_sse_emits_committed_changes_in_the_contract_shape(db_file):
    seed()
    class Request:
        async def is_disconnected(self):
            return False

    async def check():
        stream = event_stream(Request(), interval=0.001)
        first = json.loads((await anext(stream))[6:])
        assert first['type'] == 'agent' and first['data']['id'] == 'agent-1'
        await stream.aclose()
    asyncio.run(check())


def test_stuck_alerts_are_debounced_per_agent_and_survive_restart(db_file):
    seed()
    sent = []
    now = [1000.0]
    async def sender(message):
        sent.append(message)
    async def check():
        alerts = StuckAlerts('fake', sender=sender, clock=lambda: now[0])
        alerts.start_at_current()
        conn = db.connect()
        agents.add_event(conn, 'agent-1', 'stuck', 'reason')
        agents.add_event(conn, 'agent-1', 'stuck', 'reason again')
        agents.add_event(conn, 'agent-2', 'stuck', 'reason')
        await alerts.poll()
        assert sent == ['agent-1 needs help. Open Eris for details.', 'agent-2 needs help. Open Eris for details.']
        now[0] += 119
        restarted = StuckAlerts('fake', sender=sender, clock=lambda: now[0])
        restarted.start_at_current()
        agents.add_event(conn, 'agent-1', 'stuck', 'third')
        await restarted.poll()
        assert len(sent) == 2
        now[0] += 1
        agents.add_event(conn, 'agent-1', 'stuck', 'fourth')
        await restarted.poll()
        assert len(sent) == 3
        conn.close()
    asyncio.run(check())


def test_alert_delivery_failure_does_not_escape(db_file):
    seed()
    async def fail(message):
        raise OSError('notification error')
    async def check():
        alerts = StuckAlerts('fake', sender=fail)
        conn = db.connect()
        agents.add_event(conn, 'agent-1', 'stuck', 'reason')
        conn.close()
        await alerts.poll()
    asyncio.run(check())


def test_facetime_recap_sent_once_after_summary_and_end(db_file):
    from fastapi.testclient import TestClient
    from app.main import app
    received = []
    class Alerts:
        async def send_recap(self, text):
            received.append(text)
    with TestClient(app) as client:
        app.state.alerts = Alerts()
        sid = client.post('/sessions', json={'channel': 'facetime'}).json()['id']
        assert client.patch(f'/sessions/{sid}', json={'ended_at': '2026-11-15T00:00:00Z'}).status_code == 200
        assert not received
        assert client.patch(f'/sessions/{sid}', json={'summary': 'Agent 1 continued. Work remains.'}).status_code == 200
        assert client.patch(f'/sessions/{sid}', json={'summary': 'Agent 1 continued. Work remains.'}).status_code == 200
        assert received == ['Agent 1 continued. Work remains.']


def test_alert_modes_route_to_selected_channels_in_order():
    async def check():
        sent = []
        async def ntfy(message): sent.append(('ntfy', message))
        async def imessage(message): sent.append(('imessage', message))
        async def call(message): sent.append(('facetime_call', message))
        alerts = StuckAlerts('fake', channels=('ntfy', 'imessage', 'facetime_call'), sender=ntfy)
        alerts._imessage, alerts._facetime_call = imessage, call
        for mode, expected in [('text', ['ntfy', 'imessage']), ('call', ['facetime_call']),
                               ('text_then_call', ['ntfy', 'imessage', 'facetime_call'])]:
            sent.clear()
            await alerts.dispatch('test', mode=mode)
            assert [name for name, _ in sent] == expected
    asyncio.run(check())


def test_alert_config_validates_modes_and_channel_names():
    from app.config import ConfigError, load_settings
    import pytest
    s = load_settings({'ALERT_CHANNELS': 'ntfy,imessage,facetime_call', 'ALERT_MODE': 'text_then_call'})
    assert s.alert_channels == ('ntfy', 'imessage', 'facetime_call') and s.alert_mode == 'text_then_call'
    with pytest.raises(ConfigError, match='ALERT_MODE'):
        load_settings({'ALERT_MODE': 'unknown'})
    with pytest.raises(ConfigError, match='ALERT_CHANNELS'):
        load_settings({'ALERT_CHANNELS': 'ntfy,ntfy'})
