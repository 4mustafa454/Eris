"""Test doubles for the worker manager: a fake `docker exec` process, spawner and container. No Docker involved."""
import asyncio
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures" / "claude"
SID = "8c1f6a52-3b7e-4f0a-9d44-2f5d6e1b7a90"
TOKEN = "sk-ant-oat01-SECRET-VALUE-123"


def fixture(name):
    return (FIXTURES / f"{name}.jsonl").read_text().splitlines()


class FakeProc:
    def __init__(self):
        self.q = asyncio.Queue()
        self.rc = None
        self.stderr_tail = ""
        self.client_killed = False
        self._done = asyncio.Event()

    @property
    def stdout(self):
        return self._lines()

    async def _lines(self):
        while True:
            item = await self.q.get()
            if item is None:
                return
            yield item

    def say(self, *lines):
        for line in lines:
            self.q.put_nowait(line)

    def end(self, rc=0):
        if not self._done.is_set():
            self.rc = rc
            self._done.set()
            self.q.put_nowait(None)

    async def wait(self):
        await self._done.wait()
        return self.rc

    def kill_client(self):
        self.client_killed = True
        self.end(137)


class FakeSpawn:
    def __init__(self):
        self.argvs, self.procs = [], []

    async def __call__(self, argv):
        proc = FakeProc()
        self.argvs.append(argv)
        self.procs.append(proc)
        return proc


class FakeContainer:
    def __init__(self, agent_id, spawn, calls, ensure_error=None):
        self.agent_id, self.spawn, self.calls, self.ensure_error = agent_id, spawn, calls, ensure_error
        self.late = []  # lines the dying run still emits after the interrupt (it must not matter)

    async def ensure(self):
        if self.ensure_error:
            raise self.ensure_error

    async def interrupt(self):
        self.calls.append(self.agent_id)
        for proc in self.spawn.procs:
            if proc.rc is None:
                proc.say(*self.late)
                proc.end(130)
        return "stopped"


