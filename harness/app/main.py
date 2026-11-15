"""Eris harness (FastAPI, :8787). Run from harness/: uvicorn app.main:app --port 8787"""
import asyncio
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import config, db
from .alerts import StuckAlerts
from .routes import agents as agents_routes
from .routes import context as context_routes
from .routes import sessions as sessions_routes
from .routes import events as events_routes
from .workers import mock
from .workers.manager import WorkerManager


@asynccontextmanager
async def lifespan(app: FastAPI):
    for warning in config.env_file_warnings():
        print(f"[eris] {warning}", file=sys.stderr)
    config.load_env_file()
    settings = config.load_settings()  # fails at startup, naming the variable, if REAL_WORKERS & co are wrong
    manager = WorkerManager(settings)
    app.state.settings = settings
    app.state.manager = manager
    db.init_db()
    conn = db.connect()
    try:
        mock.seed_agents(conn, real=settings.real_workers)
    finally:
        conn.close()
    alerts = StuckAlerts(settings.ntfy_topic) if settings.ntfy_topic else None
    if alerts:
        alerts.start_at_current()
    await manager.recover()
    alert_task = asyncio.create_task(alerts.run()) if alerts else None
    skip = frozenset(settings.real_workers)
    ticker = asyncio.create_task(mock.run_ticker(skip=skip)) if mock.ticker_enabled() else None
    try:
        yield
    finally:
        if alert_task:
            alert_task.cancel()
            try:
                await alert_task
            except asyncio.CancelledError:
                pass
        if ticker:
            ticker.cancel()
            try:
                await ticker
            except asyncio.CancelledError:
                pass
        await manager.shutdown()


app = FastAPI(title="Eris harness", lifespan=lifespan)
app.include_router(agents_routes.router)
app.include_router(sessions_routes.router)
app.include_router(context_routes.router)
app.include_router(events_routes.router)
