from collections.abc import Iterator
import sqlite3

from fastapi import Request

from . import db


def get_conn() -> Iterator[sqlite3.Connection]:
    """One connection per request."""
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


def get_manager(request: Request):
    """The WorkerManager created in the app lifespan."""
    return request.app.state.manager
