"""Eris harness (FastAPI, :8787). Run from harness/: uvicorn app.main:app --port 8787"""
import asyncio
import sys
from contextlib import asynccontextmanager
from dataclasses import replace

from fastapi import FastAPI

from . import config, db
from .alerts import StuckAlerts
from .routes import agents as agents_routes
from .routes import context as context_routes
from .routes import sessions as sessions_routes
from .routes import events as events_routes
from .routes import tasks as tasks_routes
from .routes import approvals as approvals_routes
from .routes import search as search_routes
from .routes import settings as settings_routes
from .workers import mock
from .workers.manager import WorkerManager


@asynccontextmanager
async def lifespan(app: FastAPI):
    for warning in config.env_file_warnings():
        print(f"[eris] {warning}", file=sys.stderr)
    config.load_env_file()
    settings = config.load_settings()  # fails at startup, naming the variable, if REAL_WORKERS & co are wrong
    db.init_db()
    conn = db.connect()
    try:
        persisted = settings_routes._config(conn)
        settings = replace(settings, codex_model=persisted['CODEX_MODEL'], codex_reasoning=persisted['CODEX_REASONING'],
                           alert_channels=tuple(persisted['ALERT_CHANNELS'].split(',')), alert_mode=persisted['ALERT_MODE'])
        mock.seed_agents(conn, real=settings.real_workers)
    finally:
        conn.close()
    manager = WorkerManager(settings)
    app.state.settings = settings
    app.state.manager = manager
    alerts = StuckAlerts(settings.ntfy_topic, channels=settings.alert_channels, mode=settings.alert_mode)
    app.state.alerts = alerts
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
app.include_router(tasks_routes.router)
app.include_router(approvals_routes.router)
app.include_router(search_routes.router)
app.include_router(settings_routes.router)
