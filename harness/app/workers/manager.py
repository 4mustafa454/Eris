"""WorkerManager: drives real Claude Code workers, and applies the same task rules to mock agents.

send_task (POST /agents/{id}/task), per AGENTS.md §5.2.1:
  - the agent has a working/stuck task  → STEER: same task row, same engine session (`--resume`). A run in progress is
    interrupted first (inside the container), then resumed with the new instruction.
  - otherwise                           → NEW task: starts now, fresh session.
A run's stream becomes events.line entries; its final result decides done / stuck (BLOCKED:, max turns) / error.
When a task finishes, the agent's next queued task starts by itself.

Everything outside the DB is injected (container, process spawner, clock), so tests replay recorded streams with no Docker.
"""
import asyncio
import uuid
from dataclasses import dataclass, field

from .. import agents, db, tasks
from ..config import Settings, secret_values
from . import docker
from .stream import MAX_LINE, StreamParser

STOP_GRACE = 10.0        # seconds to wait for a stopped run's stream to end before giving up on it
STDERR_TAIL = 2000


class UnknownAgent(KeyError):
    pass


def _cut(text: str, limit: int = MAX_LINE) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


@dataclass
class Run:
    """One claude run in flight for an agent."""
    agent_id: str
    task: asyncio.Task | None = None
    proc: object | None = None
    stopped: bool = False        # interrupted (steer) or stopped (stop-all): its result must not change the agent
    parser: StreamParser = field(default_factory=StreamParser)


class WorkerManager:
    def __init__(self, settings: Settings, *, container_factory=None, spawn=None, now=db.utcnow, env=None):
        self.settings = settings
        self._container_factory = container_factory or (lambda agent_id: docker.Container(agent_id, settings))
        self._spawn = spawn or spawn_process
        self._now = now
        self._env = env
        self._containers: dict[str, object] = {}
        self._runs: dict[str, Run] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    # -- public ---------------------------------------------------------------------------------------------------

    def is_real(self, agent_id: str) -> bool:
        return self.settings.is_real(agent_id)

    def is_running(self, agent_id: str) -> bool:
        run = self._runs.get(agent_id)
        return bool(run and run.task and not run.task.done())

    async def wait_idle(self, agent_id: str) -> None:
        """Wait until the agent has no run in flight (follows the chain when a finished task starts the next queued one)."""
        while self.is_running(agent_id):
            run = self._runs[agent_id]
            try:
                await asyncio.shield(run.task)
            except BaseException:
                pass
            if self._runs.get(agent_id) is run:
                break

    async def send_task(self, agent_id: str, instruction: str) -> dict:
        """Steer the agent's current task, or start a new one. Returns the AgentState dict."""
        return (await self.send(agent_id, instruction))[0]

    async def send(self, agent_id: str, instruction: str) -> tuple[dict, str]:
        """Like send_task, and also says what happened: (AgentState dict, 'steer' | 'new')."""
        async with self._lock(agent_id):
            conn = db.connect()
            try:
                if agents.get_agent(conn, agent_id) is None:
                    raise UnknownAgent(agent_id)
                note = _cut(instruction, 60)
                conn.execute("BEGIN")
                previous = tasks.steer(conn, agent_id, self._now(), note)
                resume = None
                new_task_id = None
                if previous is not None:  # steering: the task row is unchanged
                    resume = conn.execute("SELECT engine_session FROM agents WHERE id = ?", (agent_id,)).fetchone()[0]
                else:  # a new task, fresh session
                    new_task_id = f"task-{uuid.uuid4().hex[:8]}"
                    tasks.add_task(conn, agent_id, tasks.title_from(instruction), instruction, self._now(), new_task_id)
                    conn.execute("UPDATE agents SET engine_session = NULL WHERE id = ?", (agent_id,))
                conn.execute("COMMIT")
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
            finally:
                conn.close()

            if self.is_real(agent_id):
                if previous is not None:
                    await self._stop_run(agent_id)  # interrupt inside the container, then resume with the instruction
                self._start_run(agent_id, instruction, resume)
            conn = db.connect()
            try:
                return agents.get_agent(conn, agent_id), ("steer" if previous is not None else "new")
            finally:
                conn.close()

    async def stop_all(self) -> list[dict]:
        """Kill switch: stop every run (inside its container), set working/stuck agents to paused, keep their tasks."""
        conn = db.connect()
        try:
            ids = [a["id"] for a in agents.list_agents(conn)]
        finally:
            conn.close()
        await asyncio.gather(*(self._stop_agent(a) for a in ids if self.is_real(a)))
        conn = db.connect()
        try:
            conn.execute("BEGIN")
            now = self._now()
            for agent in agents.list_agents(conn):
                if agent["state"] in ("working", "stuck", "error") and tasks.has_live_task(conn, agent["id"]):
                    tasks.set_state(conn, agent["id"], "paused", "Stopped by stop-all", None, now)
                    agents.add_event(conn, agent["id"], "state_changed", "stopped")
            conn.execute("COMMIT")
            return agents.list_agents(conn)
        finally:
            conn.close()

    async def recover(self) -> None:
        """At startup: a real agent left `working` lost its run when the harness stopped. Mark it stuck, and stop any
        claude run that is still going inside its container (nobody would be reading it)."""
        conn = db.connect()
        try:
            conn.execute("BEGIN")
            now = self._now()
            for agent in agents.list_agents(conn):
                if self.is_real(agent["id"]) and agent["state"] == "working":
                    reason = "harness restarted during this run"
                    tasks.set_state(conn, agent["id"], "stuck", f"Blocked: {reason}", reason, now)
                    agents.add_event(conn, agent["id"], "stuck", _cut(f"stuck: {reason}"))
            conn.execute("COMMIT")
        finally:
            conn.close()
        for agent_id in self.settings.real_workers:
            try:
                await self._container(agent_id).interrupt()
            except Exception:  # docker not up yet: nothing is running that we could stop
                pass

    async def shutdown(self) -> None:
        """Harness stopping: stop runs so they do not outlive us unobserved."""
        await asyncio.gather(*(self._stop_agent(a) for a in list(self._runs)), return_exceptions=True)

    # -- internals ------------------------------------------------------------------------------------------------

    def _lock(self, agent_id: str) -> asyncio.Lock:
        return self._locks.setdefault(agent_id, asyncio.Lock())

    def _container(self, agent_id: str):
        if agent_id not in self._containers:
            self._containers[agent_id] = self._container_factory(agent_id)
        return self._containers[agent_id]

    def _start_run(self, agent_id: str, instruction: str, resume: str | None) -> None:
        run = Run(agent_id, parser=StreamParser(secret_values(self._env)))
        self._runs[agent_id] = run
        run.task = asyncio.create_task(self._run(run, instruction, resume))

    async def _stop_agent(self, agent_id: str) -> None:
        async with self._lock(agent_id):
            stopped_a_run = await self._stop_run(agent_id)
        if not stopped_a_run:
            try:  # nothing was running, but a stray pytest may outlive a run that already ended
                await self._container(agent_id).interrupt()
            except Exception:
                pass

    async def _stop_run(self, agent_id: str) -> bool:
        """Stop the agent's run in flight, if any: interrupt inside its container, wait for the stream to end, sweep.
        Returns whether there was a run to stop."""
        run = self._runs.get(agent_id)
        if run is None or run.task is None or run.task.done():
            return False
        run.stopped = True
        try:
            await self._container(agent_id).interrupt()  # INT, 5 s, KILL, children: all inside the container
        except Exception as error:
            self._event(agent_id, "line", _cut(f"stop failed: {error}"))
        try:
            await asyncio.wait_for(asyncio.shield(run.task), STOP_GRACE)
        except asyncio.TimeoutError:
            run.task.cancel()
            if run.proc is not None:
                run.proc.kill_client()
            try:
                await run.task
            except BaseException:
                pass
        try:  # final sweep: catches a claude that only started inside the container after the first interrupt
            await self._container(agent_id).interrupt()
        except Exception:
            pass
        return True

    async def _run(self, run: Run, instruction: str, resume: str | None) -> None:
        agent_id = run.agent_id
        stderr_tail = ""
        try:
            await self._container(agent_id).ensure()
            if run.stopped:  # stopped before it ever started: it must not start now
                return
            argv = docker.exec_argv(agent_id, self.settings, instruction, resume)
            run.proc = await self._spawn(argv)
            if run.stopped:  # stopped while the process was starting: the interrupt may have come too early
                await self._container(agent_id).interrupt()
            async for line in run.proc.stdout:
                self._dump(agent_id, run, line)
                if run.stopped:
                    continue  # drain; an interrupted run no longer changes the agent
                self._apply(agent_id, run.parser.feed(line))
            exit_code = await run.proc.wait()
            stderr_tail = getattr(run.proc, "stderr_tail", "")
            if run.stopped:
                return
            result = run.parser.finish(exit_code)
            if result.kind == "error" and run.parser.result is None and stderr_tail.strip():
                result.reason = run.parser.redact(_cut(f"{result.reason}: {stderr_tail.strip().splitlines()[-1]}", 200))
            self._finish(agent_id, result, run.parser)
        except asyncio.CancelledError:
            raise
        except docker.WorkerError as error:
            if not run.stopped:
                self._fail(agent_id, str(error), run.parser)
        except Exception as error:  # never leave an agent "working" with nothing running
            if not run.stopped:
                self._fail(agent_id, f"worker failed: {type(error).__name__}", run.parser)

    def _dump(self, agent_id: str, run: Run, line) -> None:
        """ERIS_STREAM_LOG: append the raw stream line, redacted, for debugging. Never breaks a run."""
        path = self.settings.stream_log
        if path is None:
            return
        try:
            text = line.decode("utf-8", "replace") if isinstance(line, bytes) else line
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a") as f:
                f.write(f"{agent_id}\t{run.parser.redact(text.rstrip(chr(10)))}\n")
        except Exception:
            pass

    # -- DB writes (each its own short transaction) ---------------------------------------------------------------

    def _tx(self, fn):
        conn = db.connect()
        try:
            conn.execute("BEGIN")
            try:
                out = fn(conn, self._now())
                conn.execute("COMMIT")
                return out
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        finally:
            conn.close()

    def _event(self, agent_id: str, type_: str, line: str) -> None:
        self._tx(lambda conn, now: agents.add_event(conn, agent_id, type_, line))

    def _apply(self, agent_id: str, update) -> None:
        if not (update.lines or update.summary or update.session_id):
            return

        def write(conn, now):
            for line in update.lines:
                agents.add_event(conn, agent_id, "line", line)
            if update.summary:
                conn.execute("UPDATE agents SET summary = ?, updated_at = ? WHERE id = ?", (update.summary, now, agent_id))
            elif update.lines:
                conn.execute("UPDATE agents SET updated_at = ? WHERE id = ?", (now, agent_id))
            if update.session_id:
                conn.execute("UPDATE agents SET engine_session = ? WHERE id = ?", (update.session_id, agent_id))

        self._tx(write)

    def _finish(self, agent_id: str, result, parser: StreamParser) -> None:
        def write(conn, now):
            if result.kind == "done":
                summary = result.summary or "Finished the task"
                started = tasks.complete_task(conn, agent_id, now, summary=summary, line=_cut(f"done: {summary}"))
                if started:
                    conn.execute("UPDATE agents SET engine_session = NULL WHERE id = ?", (agent_id,))
                    row = conn.execute("SELECT instruction FROM tasks WHERE id = ?", (started[0],)).fetchone()
                    return row["instruction"]
            elif result.kind == "blocked":
                tasks.set_state(conn, agent_id, "stuck", _cut(f"Blocked: {result.reason}"), result.reason, now)
                agents.add_event(conn, agent_id, "stuck", _cut(f"BLOCKED: {result.reason}"))
            elif result.kind == "max_turns":
                tasks.set_state(conn, agent_id, "stuck", "Ran out of turns", result.reason, now)
                agents.add_event(conn, agent_id, "stuck", _cut(f"stuck: {result.reason}"))
            else:
                tasks.set_state(conn, agent_id, "error", _cut(f"Error: {result.reason}"), result.reason, now)
                agents.add_event(conn, agent_id, "line", _cut(f"error: {result.reason}"))
            return None

        next_instruction = self._tx(write)
        if next_instruction is not None:  # the next queued task started: run it, fresh session
            self._start_run(agent_id, next_instruction, None)

    def _fail(self, agent_id: str, reason: str, parser: StreamParser) -> None:
        reason = parser.redact(reason)

        def write(conn, now):
            tasks.set_state(conn, agent_id, "error", _cut(f"Error: {reason}"), reason, now)
            agents.add_event(conn, agent_id, "line", _cut(f"error: {reason}"))

        self._tx(write)


# --- the real process spawner ---------------------------------------------------------------------------------------

class _Proc:
    """A running `docker exec …` client: stdout lines, a stderr tail, wait, and host-side cleanup."""

    def __init__(self, proc: asyncio.subprocess.Process):
        self._proc = proc
        self.stdout = proc.stdout
        self.stderr_tail = ""
        self._drain = asyncio.create_task(self._read_stderr())

    async def _read_stderr(self) -> None:
        tail = b""
        async for chunk in self._proc.stderr:
            tail = (tail + chunk)[-STDERR_TAIL:]
            self.stderr_tail = tail.decode("utf-8", "replace")

    async def wait(self) -> int:
        code = await self._proc.wait()
        await self._drain
        return code

    def kill_client(self) -> None:
        """Last resort, host side only: the in-container kill is what actually stops claude."""
        try:
            self._proc.kill()
        except ProcessLookupError:
            pass


async def spawn_process(argv: list[str]) -> _Proc:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=16 * 1024 * 1024,  # one stream-json line can carry a whole file
        )
    except FileNotFoundError:
        raise docker.WorkerError("docker is not installed or not on PATH") from None
    return _Proc(proc)
