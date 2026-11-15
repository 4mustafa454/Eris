"""Server-sent snapshots of committed harness state."""
import asyncio
import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from .. import agents, db

router = APIRouter()


def snapshots():
    conn = db.connect()
    try:
        return {
            'agent': agents.list_agents(conn),
            'task': [dict(r) for r in conn.execute('SELECT * FROM tasks ORDER BY rowid')],
            'approval': [dict(r) for r in conn.execute('SELECT * FROM approvals ORDER BY rowid')],
            'session': [dict(r) for r in conn.execute('SELECT * FROM sessions ORDER BY rowid')],
        }
    finally:
        conn.close()


async def event_stream(request, interval=0.5):
    previous = {}
    while not await request.is_disconnected():
        current = snapshots()
        for kind, records in current.items():
            seen = previous.setdefault(kind, {})
            for record in records:
                encoded = json.dumps(record, sort_keys=True)
                if seen.get(record['id']) != encoded:
                    seen[record['id']] = encoded
                    yield 'data: ' + json.dumps({'type': kind, 'data': record}) + '\n\n'
        await asyncio.sleep(interval)


@router.get('/events')
async def events(request: Request):
    return StreamingResponse(event_stream(request), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
