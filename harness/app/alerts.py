"""Debounced ntfy notifications for committed stuck events."""
import asyncio
import logging
import os
import time

import httpx

from . import db
from .approvals import AWAITING
from .chert import ChertClient, mask_number, _why

MAX_LEN = 100


def format_alert(name, reason):
    """'Agent 2 needs approval: git push' / 'Agent 1 is stuck: v1 or v2 endpoint?' (<= MAX_LEN chars)."""
    reason = ' '.join((reason or '').split())
    if reason.startswith(AWAITING):
        text = f"{name} needs approval: {reason[len(AWAITING):]}"
    elif reason:
        text = f"{name} is stuck: {reason}"
    else:
        text = f"{name} is stuck"
    return text if len(text) <= MAX_LEN else text[:MAX_LEN - 1].rstrip() + '…'


class StuckAlerts:
    def __init__(self, topic, *, channels=('ntfy',), mode='text', sender=None, clock=time.time,
                 dry_run=None, chert=None):
        self.topic = topic
        self.channels = channels
        self.mode = mode
        self.sender = sender or self._send
        self.clock = clock
        self.cursor = 0
        self._dry_run = dry_run  # None: follow ALERT_DRY_RUN in the environment
        self.chert = chert or ChertClient(os.environ)

    async def _send(self, message):
        if not self.topic:
            return
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.post(f'https://ntfy.sh/{self.topic}', content=message.encode('utf-8'))
            response.raise_for_status()

    @property
    def dry_run(self):
        if self._dry_run is not None:
            return self._dry_run
        return os.environ.get('ALERT_DRY_RUN', '').strip().lower() in ('1', 'true', 'yes', 'on')

    async def _imessage(self, message):
        await self.chert.send_imessage(message)

    async def _facetime_call(self, message):
        await self.chert.place_call(message)

    async def dispatch(self, message, *, mode=None):
        mode = mode or self.mode
        text_channels = {'ntfy': self.sender, 'imessage': self._imessage}
        call_channels = {'facetime_call': self._facetime_call}
        for group in ((text_channels,) if mode == 'text' else (call_channels,) if mode == 'call'
                      else (text_channels, call_channels)):
            for channel in self.channels:
                send = group.get(channel)
                if send and self.dry_run:
                    to = mask_number(os.environ.get('ALERT_TO')) if channel != 'ntfy' else 'ntfy topic'
                    logging.getLogger(__name__).warning('[dry-run] %s to %s would send: %s', channel, to, message)
                elif send:
                    try:
                        await send(message)
                    except Exception as error:
                        logging.getLogger(__name__).warning('Alert delivery failed for %s (%s)', channel, _why(error))

    async def send_recap(self, summary):
        await self.dispatch(f"Call recap: {summary}", mode='text')

    def start_at_current(self):
        conn = db.connect()
        try:
            self.cursor = conn.execute('SELECT COALESCE(MAX(id), 0) FROM events').fetchone()[0]
        finally:
            conn.close()

    async def poll(self):
        conn = db.connect()
        try:
            rows = conn.execute("SELECT e.id, e.agent_id, e.line, a.name, a.state, a.stuck_reason FROM events e "
                                "JOIN agents a ON a.id = e.agent_id WHERE e.id > ? AND e.type = 'stuck' ORDER BY e.id", (self.cursor,)).fetchall()
            for row in rows:
                self.cursor = row['id']
                key = 'ntfy.last.' + row['agent_id']
                now = self.clock()
                previous = conn.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
                if previous and now - float(previous[0]) < 120:
                    continue
                conn.execute('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, str(now)))
                reason = row['stuck_reason'] if row['state'] == 'stuck' and row['stuck_reason'] else row['line']
                await self.dispatch(format_alert(row['name'], reason))
        finally:
            conn.close()

    async def run(self):
        while True:
            await self.poll()
            await asyncio.sleep(0.5)
