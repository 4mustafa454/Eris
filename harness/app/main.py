"""Eris harness (FastAPI, :8787). Run from harness/: uvicorn app.main:app --port 8787"""
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import db
from .routes import agents as agents_routes
from .routes import context as context_routes
from .routes import sessions as sessions_routes
from .workers import mock


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    conn = db.connect()
    try:
        mock.seed_agents(conn)
    finally:
        conn.close()
    ticker = asyncio.create_task(mock.run_ticker()) if mock.ticker_enabled() else None
    try:
        yield
    finally:
        if ticker:
            ticker.cancel()
            try:
                await ticker
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Eris harness", lifespan=lifespan)
app.include_router(agents_routes.router)
app.include_router(sessions_routes.router)
app.include_router(context_routes.router)
