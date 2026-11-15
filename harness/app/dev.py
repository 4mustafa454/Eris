"""Dev-only helpers: python -m app.dev seed-approval <agent-id> "<action>" [--detail TEXT]."""
import argparse
import json
import sqlite3
import sys

from . import agents, config, db
from .workers import mock
from .approvals import create_approval


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog='app.dev')
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('seed-approval', help='create a pending approval')
    s.add_argument('agent_id')
    s.add_argument('action')
    s.add_argument('--detail')
    args = p.parse_args(argv)
    config.load_env_file()
    db.init_db()
    conn = db.connect()
    try:
        mock.seed_agents(conn, real=config.load_settings().real_workers)  # same as harness startup; no-op if seeded
        if agents.get_agent(conn, args.agent_id) is None:
            print(f'unknown agent: {args.agent_id}', file=sys.stderr)
            return 1
        try:
            row = create_approval(conn, args.agent_id, args.action, args.detail)
        except sqlite3.Error as exc:
            print(f'could not create approval: {exc}', file=sys.stderr)
            return 1
        print(json.dumps(row))
        return 0
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
