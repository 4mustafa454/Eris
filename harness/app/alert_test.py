"""Send ONE alert over one channel, to check Chert is set up: `python -m app.alert_test imessage|call [text] [--dry-run]`.

Reads harness/.env. Real by default (that is the point); --dry-run only logs. Never prints a secret.
"""
import argparse
import asyncio
import logging
import os
import sys

from . import config
from .alerts import StuckAlerts


async def run(channel, text, dry_run):
    name = {'imessage': 'imessage', 'call': 'facetime_call'}[channel]
    alerts = StuckAlerts(None, channels=(name,), mode='text' if channel == 'imessage' else 'call', dry_run=dry_run)
    if dry_run:
        await alerts.dispatch(text)
        return 0
    send = alerts._imessage if channel == 'imessage' else alerts._facetime_call
    try:
        result = await send(text)
    except Exception as error:
        from .chert import ChertError, _why
        print(f'failed: {error if isinstance(error, ChertError) else _why(error)}', file=sys.stderr)
        return 1
    print('sent:', result if result is not None else 'ok')
    if channel == 'call':
        print('call requested; waiting for it to be answered (Ctrl+C to stop watching)')
        await asyncio.gather(*alerts.chert.tasks)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python -m app.alert_test')
    parser.add_argument('channel', choices=['imessage', 'call'])
    parser.add_argument('text', nargs='?', default='Agent 1 is stuck: this is a test alert')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    config.load_env_file()
    return asyncio.run(run(args.channel, args.text, args.dry_run))


if __name__ == '__main__':
    raise SystemExit(main())
