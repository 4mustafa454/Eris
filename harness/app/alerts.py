"""Debounced ntfy notifications for committed stuck events."""
import asyncio
import time

import httpx

from . import db


class StuckAlerts:
    def __init__(self, topic, *, sender=None, clock=time.time):
        self.topic = topic
        self.sender = sender or self._send
        self.clock = clock
        self.cursor = 0

    async def _send(self, message):
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.post(f'https://ntfy.sh/{self.topic}', content=message.encode('utf-8'))
            response.raise_for_status()

    def start_at_current(self):
        conn = db.connect()
        try:
            self.cursor = conn.execute('SELECT COALESCE(MAX(id), 0) FROM events').fetchone()[0]
        finally:
            conn.close()

    async def poll(self):
        conn = db.connect()
        try:
            rows = conn.execute("SELECT id, agent_id FROM events WHERE id > ? AND type = 'stuck' ORDER BY id", (self.cursor,)).fetchall()
            for row in rows:
                self.cursor = row['id']
                key = 'ntfy.last.' + row['agent_id']
                now = self.clock()
                previous = conn.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
                if previous and now - float(previous[0]) < 120:
                    continue
                conn.execute('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, str(now)))
                try:
                    await self.sender(f"{row['agent_id']} needs help. Open Eris for details.")
                except Exception:
                    pass  # an alert outage must not affect worker control
        finally:
            conn.close()

    async def run(self):
        while True:
            await self.poll()
            await asyncio.sleep(0.5)
