"""Docker plumbing for real workers: pure argv builders, the in-container interrupt, and a small async runner.

One long-lived container per real agent (`eris-agent-1`, PID 1 = `sleep infinity` under --init), one `docker exec` per
claude run. Safety (AGENTS.md §8): non-root user, only the demo repo and the agent's own ~/.claude volume mounted, no
docker socket, no capabilities, resource limits. The API token is passed per `exec` as `-e NAME` with no value, so docker
copies it from the harness environment: it is never in argv, never in the container's config, never in the image.

Interrupting a run means signalling processes INSIDE the container (`docker exec <c> pkill ...`), never the host-side
`docker exec` client. PID 1 and the keepalive are never touched.
"""
import asyncio
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

from ..config import SECRET_NAMES, Settings

CLAUDE_PATTERN = "claude -p"   # pkill/pgrep -f pattern for a running claude run (argv starts `claude -p`)
KEEPALIVE = ("sleep", "infinity")
WORKSPACE = "/workspace"
HOME = "/home/worker"
INTERRUPT_WAIT = 5.0           # seconds a run gets to stop after SIGINT before SIGKILL
MEMORY = "2g"
PIDS_LIMIT = "512"
CPUS = "2"
# commands this module itself runs inside the container: never counted as stragglers
_HELPERS = ("ps -eo", "pkill", "pgrep", "kill -KILL")


class WorkerError(Exception):
    """A real worker cannot run (no container, no demo repo, docker failed). The message is safe to show."""


def container_name(agent_id: str) -> str:
    return f"eris-{agent_id}"


def volume_name(agent_id: str) -> str:
    return f"eris-{agent_id}-home"


def workspace_path(agent_id: str, settings: Settings) -> Path:
    return settings.demo_repo / ".worktrees" / agent_id


# --- argv builders (pure) -------------------------------------------------------------------------------------------

def create_argv(agent_id: str, settings: Settings, uid: int, gid: int) -> list[str]:
    """`docker run -d` for the agent's long-lived container. No secrets here: the token goes in per `exec`."""
    codex = settings.engine_for(agent_id) == "codex"
    home_dir = ".codex" if codex else ".claude"
    auth_mount = (["--mount", f"type=bind,source={Path.home() / '.codex/auth.json'},target={HOME}/.codex/auth.json,readonly"]
                  if codex else [])
    return [
        "docker", "run", "-d", "--init",
        "--name", container_name(agent_id),
        "--label", f"eris.agent={agent_id}",
        "--user", f"{uid}:{gid}",
        "--workdir", WORKSPACE,
        "--env", f"HOME={HOME}",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--memory", MEMORY, "--pids-limit", PIDS_LIMIT, "--cpus", CPUS,
        "--mount", f"type=bind,source={workspace_path(agent_id, settings)},target={WORKSPACE}",
        "--mount", f"type=volume,source={volume_name(agent_id)},target={HOME}/{home_dir}",
        *auth_mount,
        settings.codex_worker_image if codex else settings.worker_image,
        *KEEPALIVE,
    ]


def exec_argv(agent_id: str, settings: Settings, instruction: str, resume: str | None = None) -> list[str]:
    """One claude run: `docker exec` + `claude -p …`. The instruction is ONE argv element after `--`."""
    if settings.engine_for(agent_id) == "codex":
        argv = ["docker", "exec", "-i", "--workdir", WORKSPACE, container_name(agent_id), "codex", "exec",
                "--sandbox", "danger-full-access"]
        if resume:
            argv.append("resume")
        argv += ["--json", "--model", settings.codex_model,
                 "--config", f'model_reasoning_effort="{settings.codex_reasoning}"']
        if resume:
            argv.append(resume)
        return [*argv, "--", instruction]
    argv = ["docker", "exec", "-i", "--workdir", WORKSPACE]
    if settings.secret_name:
        argv += ["--env", settings.secret_name]  # no value: docker copies it from our environment
    argv += [
        container_name(agent_id),
        "claude", "-p",
        "--output-format", "stream-json", "--verbose",
        "--dangerously-skip-permissions",
        "--max-turns", str(settings.claude_max_turns),
    ]
    if resume:
        argv += ["--resume", resume]
    return [*argv, "--", instruction]


def in_container(agent_id: str, *cmd: str) -> list[str]:
    """`docker exec <container> <cmd…>` for housekeeping (no tty, no env)."""
    return ["docker", "exec", container_name(agent_id), *cmd]


def top_argv(agent_id: str) -> list[str]:
    return ["docker", "top", container_name(agent_id), "-eo", "pid,args"]


def inspect_argv(agent_id: str) -> list[str]:
    return ["docker", "inspect", "--format", "{{.State.Running}}", container_name(agent_id)]


def remove_argv(agent_id: str) -> list[str]:
    return ["docker", "rm", "-f", container_name(agent_id)]


# --- parsing (pure) -------------------------------------------------------------------------------------------------

def parse_ps(output: str) -> list[tuple[int, str]]:
    """`ps -eo pid=,args=` / `docker top … -eo pid,args` output → [(pid, args)], skipping a header."""
    rows = []
    for line in output.splitlines():
        m = re.match(r"\s*(\d+)\s+(.*\S)\s*$", line)
        if m:
            rows.append((int(m.group(1)), m.group(2)))
    return rows


def stragglers(ps_output: str) -> list[int]:
    """Pids to kill after a run is stopped: everything except PID 1, the `sleep infinity` keepalive, and our own helpers."""
    keep = " ".join(KEEPALIVE)
    pids = []
    for pid, args in parse_ps(ps_output):
        if pid <= 1 or args == keep or args.startswith(keep + " "):
            continue
        if any(args.startswith(h) for h in _HELPERS):
            continue
        pids.append(pid)
    return sorted(pids)


def has_claude(top_output: str) -> bool:
    """True if any process in `docker top` output is a claude run."""
    return any("claude" in args for _, args in parse_ps(top_output))


# --- running commands -----------------------------------------------------------------------------------------------

@dataclass
class Ran:
    rc: int
    out: str = ""
    err: str = ""


class Runner:
    """Runs short docker commands. Tests replace it with a fake; the manager uses this one."""

    async def run(self, argv: list[str], timeout: float = 30.0) -> Ran:
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
        except FileNotFoundError:
            raise WorkerError("docker is not installed or not on PATH") from None
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise WorkerError(f"docker {argv[1] if len(argv) > 1 else ''} timed out after {timeout:.0f}s") from None
        return Ran(proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace"))


class Container:
    """One agent's container: create/start it, interrupt its runs, look inside, remove it."""

    def __init__(self, agent_id: str, settings: Settings, runner=None, *, sleep=asyncio.sleep, clock=time.monotonic,
                 uid: int | None = None, gid: int | None = None):
        self.agent_id = agent_id
        self.settings = settings
        self.runner = runner or Runner()
        self._sleep, self._clock = sleep, clock
        self.uid = os.getuid() if uid is None else uid
        self.gid = os.getgid() if gid is None else gid

    async def ensure(self) -> None:
        """The container exists and is running. Creates it (or starts a stopped one). Raises WorkerError with a fix."""
        repo = workspace_path(self.agent_id, self.settings)
        if not (repo / ".git").exists():
            raise WorkerError(f"{repo} is not a git repo: run scripts/make-demo-repo.sh")
        state = await self.runner.run(inspect_argv(self.agent_id))
        if state.rc == 0 and state.out.strip() == "true":
            return
        if state.rc == 0:  # exists but stopped
            started = await self.runner.run(["docker", "start", container_name(self.agent_id)])
            if started.rc != 0:
                raise WorkerError(f"could not start {container_name(self.agent_id)}: {started.err.strip()[:200]}")
            return
        made = await self.runner.run(create_argv(self.agent_id, self.settings, self.uid, self.gid), timeout=120.0)
        if made.rc != 0:
            raise WorkerError(f"could not create {container_name(self.agent_id)}: {made.err.strip()[:200]}")

    async def top(self) -> str:
        ran = await self.runner.run(top_argv(self.agent_id))
        return ran.out if ran.rc == 0 else ""

    async def _running(self) -> bool:
        return (await self.runner.run(in_container(self.agent_id, "pgrep", "-f", CLAUDE_PATTERN))).rc == 0

    async def interrupt(self, wait: float = INTERRUPT_WAIT, poll: float = 0.25) -> str:
        """Stop the agent's run from inside the container. Returns 'idle', 'stopped' or 'killed'.

        SIGINT to claude, wait up to `wait` seconds, then SIGKILL; then kill any leftover children (pytest and the
        like). PID 1 and the keepalive are never signalled.
        """
        outcome = "idle"
        signalled = await self.runner.run(in_container(self.agent_id, "pkill", "-INT", "-f", CLAUDE_PATTERN))
        if signalled.rc == 0:
            outcome = "stopped"
            deadline = self._clock() + wait
            while await self._running():
                if self._clock() >= deadline:
                    await self.runner.run(in_container(self.agent_id, "pkill", "-KILL", "-f", CLAUDE_PATTERN))
                    outcome = "killed"
                    break
                await self._sleep(poll)
        for _ in range(3):  # new children can appear while we kill: sweep until quiet
            ps = await self.runner.run(in_container(self.agent_id, "ps", "-eo", "pid=,args="))
            pids = stragglers(ps.out) if ps.rc == 0 else []
            if not pids:
                break
            await self.runner.run(in_container(self.agent_id, "kill", "-KILL", *map(str, pids)))
        return outcome

    async def remove(self) -> None:
        await self.runner.run(remove_argv(self.agent_id))
