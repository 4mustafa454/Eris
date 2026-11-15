from collections.abc import Iterator
import sqlite3

from . import db


def get_conn() -> Iterator[sqlite3.Connection]:
    """One connection per request."""
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()
