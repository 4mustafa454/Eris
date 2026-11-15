"""app/workers/docker.py: exact docker argv, straggler parsing, and the in-container interrupt (simulated container)."""
import asyncio
from pathlib import Path

import pytest

from app.config import Settings
from app.workers import docker as d
from app.workers.docker import Container, Ran, WorkerError

REPO = Path(__file__).resolve().parents[2] / "demo-repo"
SETTINGS = Settings(real_workers=("agent-1",), demo_repo=REPO, secret_name="CLAUDE_CODE_OAUTH_TOKEN")
TOKEN = "sk-ant-oat01-SECRET-VALUE-123"


def pairs(argv, flag):
    """The values that follow each occurrence of `flag`."""
    return [argv[i + 1] for i, a in enumerate(argv) if a == flag]


# --- docker run ---------------------------------------------------------------------------------------------------

def test_create_argv_is_locked_down():
    argv = d.create_argv("agent-1", SETTINGS, 1234, 5678)
    assert argv[:4] == ["docker", "run", "-d", "--init"]
    assert pairs(argv, "--name") == ["eris-agent-1"] and pairs(argv, "--user") == ["1234:5678"]
    assert pairs(argv, "--cap-drop") == ["ALL"] and pairs(argv, "--security-opt") == ["no-new-privileges"]
    assert pairs(argv, "--memory") and pairs(argv, "--pids-limit") and pairs(argv, "--cpus")
    assert argv[-3:] == [SETTINGS.worker_image, "sleep", "infinity"]  # PID 1 is the keepalive (under tini)
    assert pairs(argv, "--workdir") == ["/workspace"] and pairs(argv, "--env") == ["HOME=/home/worker"]


def test_create_argv_has_exactly_two_mounts_the_repo_and_the_agents_own_home():
    argv = d.create_argv("agent-1", SETTINGS, 1000, 1000)
    mounts = pairs(argv, "--mount")
    assert mounts == [
        f"type=bind,source={REPO}/.worktrees/agent-1,target=/workspace",
        "type=volume,source=eris-agent-1-home,target=/home/worker/.claude",
    ]
    forbidden_flags = {"--privileged", "--network", "--net", "-v", "--volume", "--pid", "--ipc", "--uts", "--device",
                       "--userns", "--cap-add", "--group-add"}
    assert not forbidden_flags & set(argv), forbidden_flags & set(argv)
    joined = " ".join(argv)
    assert "docker.sock" not in joined and "--security-opt=" not in joined
    sources = [m.split("source=")[1].split(",")[0] for m in mounts]
    assert sources == [str(REPO / '.worktrees/agent-1'), "eris-agent-1-home"] and str(Path.home()) not in sources, "no host home dir"


def test_create_argv_never_carries_a_secret_not_even_its_name():
    argv = d.create_argv("agent-1", SETTINGS, 1000, 1000)
    assert not any(n in " ".join(argv) for n in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "TOKEN", "sk-ant"))


def test_each_agent_gets_its_own_container_and_volume():
    a, b = d.create_argv("agent-1", SETTINGS, 1, 1), d.create_argv("agent-2", SETTINGS, 1, 1)
    assert "eris-agent-1" in a and "eris-agent-2" in b and "eris-agent-1-home" not in " ".join(b)


def test_codex_uses_its_own_repo_home_and_read_only_auth_mount():
    settings = Settings(real_workers=("agent-3",), demo_repo=REPO, engines={"agent-3": "codex"})
    argv = d.create_argv("agent-3", settings, 1000, 1000)
    mounts = pairs(argv, "--mount")
    assert mounts == [
        f"type=bind,source={REPO}/.worktrees/agent-3,target=/workspace",
        "type=volume,source=eris-agent-3-home,target=/home/worker/.codex",
        f"type=bind,source={Path.home()}/.codex/auth.json,target=/home/worker/.codex/auth.json,readonly",
    ]
    assert argv[-3] == settings.codex_worker_image


def test_codex_start_and_resume_pass_model_reasoning_and_sandbox():
    settings = Settings(engines={"agent-3": "codex"}, codex_model="gpt-6.1-terra", codex_reasoning="medium")
    for sid in (None, "thread-id"):
        argv = d.exec_argv("agent-3", settings, "--literal prompt", sid)
        assert pairs(argv, "--model") == ["gpt-6.1-terra"]
        assert pairs(argv, "--config") == ['model_reasoning_effort="medium"']
        assert pairs(argv, "--sandbox") == ["danger-full-access"]
        assert argv[-2:] == ["--", d.worker_prompt("--literal prompt")]
        if sid:
            assert argv.index("--sandbox") < argv.index("resume") and argv[-3] == sid


# --- docker exec --------------------------------------------------------------------------------------------------

def test_exec_argv_has_the_claude_flags_and_the_token_by_name_only():
    argv = d.exec_argv("agent-1", SETTINGS, "Fix the failing test")
    assert argv[:3] == ["docker", "exec", "-i"]
    assert pairs(argv, "--env") == ["CLAUDE_CODE_OAUTH_TOKEN"]  # no "=value": docker copies it from our environment
    i = argv.index("eris-agent-1")
    assert argv[i + 1: i + 3] == ["claude", "-p"], "claude -p stays adjacent so pkill -f 'claude -p' finds it"
    assert "--output-format" in argv and argv[argv.index("--output-format") + 1] == "stream-json"
    assert "--verbose" in argv and "--dangerously-skip-permissions" in argv
    assert argv[argv.index("--max-turns") + 1] == "30"
    assert "--resume" not in argv
    assert argv[-2:] == ["--", d.worker_prompt("Fix the failing test")]
    assert TOKEN not in " ".join(argv)


def test_exec_argv_uses_the_api_key_name_when_that_is_what_is_set():
    s = Settings(real_workers=("agent-1",), demo_repo=REPO, secret_name="ANTHROPIC_API_KEY", claude_max_turns=12)
    argv = d.exec_argv("agent-1", s, "x")
    assert pairs(argv, "--env") == ["ANTHROPIC_API_KEY"] and argv[argv.index("--max-turns") + 1] == "12"


def test_resume_is_added_only_when_steering():
    argv = d.exec_argv("agent-1", SETTINGS, "use v2", resume="8c1f6a52-3b7e")
    assert argv[argv.index("--resume") + 1] == "8c1f6a52-3b7e"
    assert argv.index("--resume") < argv.index("--") and argv[-1] == d.worker_prompt("use v2")


@pytest.mark.parametrize("instruction", [
    "plain", "two words", "--dangerously-skip-permissions", "-p", "$(rm -rf ~)", "a; b && c | d", 'quote " and \' mix',
    "line one\nline two", "unicode → ✓", "", "x" * 20000, "`backticks`", "--resume other-session",
])
def test_the_instruction_is_always_one_argv_element_after_the_double_dash(instruction):
    argv = d.exec_argv("agent-1", SETTINGS, instruction, resume="sid")
    assert argv[-2:] == ["--", d.worker_prompt(instruction)]
    assert argv.count("--") == 1 and len(argv) == len(d.exec_argv("agent-1", SETTINGS, "x", resume="sid"))


def test_no_shell_is_involved_anywhere():
    for argv in (d.create_argv("agent-1", SETTINGS, 1, 1), d.exec_argv("agent-1", SETTINGS, "x"),
                 d.in_container("agent-1", "pkill", "-INT", "-f", d.CLAUDE_PATTERN), d.top_argv("agent-1")):
        assert "sh" not in argv and "bash" not in argv and "-c" not in argv and argv[0] == "docker"


# --- parsing --------------------------------------------------------------------------------------------------------

PS = """\
    1 /sbin/docker-init -- sleep infinity
    7 sleep infinity
   42 claude -p --output-format stream-json --verbose -- Fix the test
   55 /bin/bash -c pytest -q
   56 python3 -m pytest -q
   99 ps -eo pid=,args=
"""


def test_parse_ps_handles_headers_and_odd_spacing():
    rows = d.parse_ps("  PID COMMAND\n    1 /sbin/init\n 12   sleep   infinity  \n\nnot a row\n")
    assert rows == [(1, "/sbin/init"), (12, "sleep   infinity")]


def test_stragglers_exclude_pid_1_the_keepalive_and_our_own_helpers():
    assert d.stragglers(PS) == [42, 55, 56]  # not 1 (init), not 7 (sleep infinity), not 99 (our ps)
    assert d.stragglers("    1 sleep infinity\n    8 sleep infinity\n") == []
    assert d.stragglers("") == []
    assert d.stragglers("  300 pkill -INT -f claude -p\n  301 pgrep -f claude -p\n  302 kill -KILL 5\n") == []
    assert d.stragglers("    9 sleep 30\n") == [9], "only the exact keepalive is spared, not any sleep"


def test_has_claude():
    assert d.has_claude("PID COMMAND\n42 claude -p --output-format stream-json")
    assert d.has_claude("42 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p x")
    assert not d.has_claude("PID COMMAND\n7 sleep infinity\n")
    assert not d.has_claude("")


# --- the in-container interrupt (simulated container) -------------------------------------------------------------

class FakeBox:
    """A container's process table behind the Runner interface; records every docker command."""

    def __init__(self, procs, ignores_int=False, exits_after_polls=0):
        self.procs = dict(procs)            # pid → args
        self.ignores_int = ignores_int
        self.exits_after_polls = exits_after_polls
        self.int_sent = False
        self.polls = 0
        self.calls = []

    def has_claude(self):
        return any(a.startswith("claude -p") for a in self.procs.values())

    async def run(self, argv, timeout=30.0):
        self.calls.append(argv)
        if argv[:2] == ["docker", "inspect"]:
            return Ran(0, "true\n")
        assert argv[:2] == ["docker", "exec"] and argv[2] == "eris-agent-1", argv
        cmd = argv[3:]
        if cmd[:3] == ["pkill", "-INT", "-f"]:
            if not self.has_claude():
                return Ran(1)
            self.int_sent = True
            return Ran(0)
        if cmd[:3] == ["pgrep", "-f", d.CLAUDE_PATTERN]:
            self.polls += 1
            if self.int_sent and not self.ignores_int and self.polls > self.exits_after_polls:
                self.procs = {p: a for p, a in self.procs.items() if not a.startswith("claude -p")}
            return Ran(0 if self.has_claude() else 1)
        if cmd[:3] == ["pkill", "-KILL", "-f"]:
            self.procs = {p: a for p, a in self.procs.items() if not a.startswith("claude -p")}
            return Ran(0)
        if cmd[:2] == ["ps", "-eo"]:
            return Ran(0, "\n".join(f"{p} {a}" for p, a in self.procs.items()) + f"\n999 {' '.join(cmd)}\n")
        if cmd[:2] == ["kill", "-KILL"]:
            for pid in map(int, cmd[2:]):
                self.procs.pop(pid, None)
            return Ran(0)
        raise AssertionError(f"unexpected command {argv}")

    def killed_pids(self):
        return [int(p) for c in self.calls if c[3:5] == ["kill", "-KILL"] for p in c[5:]]

    def signals(self):
        return [c[3:6] for c in self.calls if c[3] in ("pkill",)]


class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    async def sleep(self, s):
        self.t += s


def container(box):
    clock = Clock()
    return Container("agent-1", SETTINGS, box, sleep=clock.sleep, clock=clock.now, uid=1000, gid=1000), clock


BASE = {1: "/sbin/docker-init -- sleep infinity", 7: "sleep infinity"}


def test_a_run_that_stops_on_sigint_is_never_sigkilled():
    box = FakeBox({**BASE, 42: "claude -p --output-format stream-json -- x"}, exits_after_polls=2)
    c, clock = container(box)
    assert asyncio.run(c.interrupt()) == "stopped"
    assert box.signals() == [["pkill", "-INT", "-f"]]
    assert not box.has_claude() and clock.t < 5


def test_a_run_that_ignores_sigint_is_sigkilled_after_5_seconds_and_not_before():
    box = FakeBox({**BASE, 42: "claude -p -- x"}, ignores_int=True)
    c, clock = container(box)
    assert asyncio.run(c.interrupt()) == "killed"
    assert [s[:2] for s in box.signals()] == [["pkill", "-INT"], ["pkill", "-KILL"]]
    assert 5.0 <= clock.t < 5.5, f"waited {clock.t}s"
    assert not box.has_claude()


def test_leftover_children_are_killed_but_never_pid_1_or_the_keepalive():
    box = FakeBox({**BASE, 42: "claude -p -- x", 55: "/bin/bash -c pytest -q", 56: "python3 -m pytest -q", 57: "sleep 30"})
    c, _ = container(box)
    asyncio.run(c.interrupt())
    assert set(box.killed_pids()) >= {55, 56, 57}
    assert 1 not in box.killed_pids() and 7 not in box.killed_pids() and 999 not in box.killed_pids()
    assert box.procs == BASE, "only PID 1 and the keepalive remain"


def test_children_are_swept_even_when_no_claude_run_is_found():
    box = FakeBox({**BASE, 56: "python3 -m pytest -q"})
    c, _ = container(box)
    assert asyncio.run(c.interrupt()) == "idle"
    assert box.killed_pids() == [56] and box.procs == BASE


def test_an_idle_container_gets_no_kill_at_all():
    box = FakeBox(dict(BASE))
    c, _ = container(box)
    assert asyncio.run(c.interrupt()) == "idle"
    assert box.killed_pids() == [] and [s[:2] for s in box.signals()] == [["pkill", "-INT"]]


def test_the_sweep_repeats_for_processes_that_appear_while_killing_but_is_bounded():
    class Spawner(FakeBox):
        spawned = 0

        async def run(self, argv, timeout=30.0):
            ran = await super().run(argv, timeout)
            if argv[3:5] == ["kill", "-KILL"] and self.spawned < 100:
                self.spawned += 1
                self.procs[1000 + self.spawned] = "python3 respawned.py"  # a process that keeps coming back
            return ran

    box = Spawner(dict(BASE))
    box.procs[56] = "python3 -m pytest -q"
    c, _ = container(box)
    asyncio.run(c.interrupt())
    assert 1 <= box.spawned <= 3, "bounded: it must not loop forever"


def test_interrupt_never_signals_the_host_side_docker_exec_client():
    box = FakeBox({**BASE, 42: "claude -p -- x"}, exits_after_polls=1)
    c, _ = container(box)
    asyncio.run(c.interrupt())
    for argv in box.calls:
        assert argv[:3] == ["docker", "exec", "eris-agent-1"] or argv[:2] == ["docker", "inspect"], argv
        assert argv[3] not in ("sh", "bash") and "kill" not in argv[0]


# --- ensure ---------------------------------------------------------------------------------------------------------

class Script:
    """A runner that answers from a list of (prefix, Ran)."""

    def __init__(self, *answers):
        self.answers, self.calls = list(answers), []

    async def run(self, argv, timeout=30.0):
        self.calls.append(argv)
        for prefix, ran in self.answers:
            if argv[: len(prefix)] == prefix:
                return ran
        raise AssertionError(argv)


@pytest.fixture
def repo(tmp_path):
    (tmp_path / ".worktrees/agent-1/.git").mkdir(parents=True)
    return Settings(real_workers=("agent-1",), demo_repo=tmp_path, secret_name="CLAUDE_CODE_OAUTH_TOKEN")


def test_ensure_is_a_noop_for_a_running_container(repo):
    r = Script((["docker", "inspect"], Ran(0, f"true {d.workspace_path('agent-1', repo)}\n")))
    asyncio.run(Container("agent-1", repo, r).ensure())
    assert [c[1] for c in r.calls] == ["inspect"]


def test_ensure_starts_a_stopped_container_and_creates_a_missing_one(repo):
    r = Script((["docker", "inspect"], Ran(0, f"false {d.workspace_path('agent-1', repo)}\n")), (["docker", "start"], Ran(0)))
    asyncio.run(Container("agent-1", repo, r).ensure())
    assert [c[1] for c in r.calls] == ["inspect", "start"]
    r = Script((["docker", "inspect"], Ran(1, "", "No such object")), (["docker", "run"], Ran(0, "abc123\n")))
    asyncio.run(Container("agent-1", repo, r, uid=1000, gid=1000).ensure())
    assert r.calls[1] == d.create_argv("agent-1", repo, 1000, 1000)


def test_ensure_rejects_existing_container_with_a_different_workspace(repo):
    for running in ('true', 'false'):
        r = Script((["docker", "inspect"], Ran(0, f"{running} {repo.demo_repo}\n")))
        with pytest.raises(WorkerError, match="wrong workspace"):
            asyncio.run(Container("agent-1", repo, r).ensure())
        assert [call[1] for call in r.calls] == ['inspect']


def test_ensure_reports_a_missing_demo_repo_and_docker_failures_without_leaking(repo, tmp_path):
    missing = Settings(real_workers=("agent-1",), demo_repo=tmp_path / "nope", secret_name="CLAUDE_CODE_OAUTH_TOKEN")
    with pytest.raises(WorkerError, match="make-demo-repo.sh"):
        asyncio.run(Container("agent-1", missing, Script()).ensure())
    r = Script((["docker", "inspect"], Ran(1)), (["docker", "run"], Ran(125, "", "Unable to find image 'x' locally")))
    with pytest.raises(WorkerError, match="could not create eris-agent-1: Unable to find image"):
        asyncio.run(Container("agent-1", repo, r).ensure())


def test_the_real_runner_reports_a_missing_docker_binary_clearly(monkeypatch):
    async def boom(*a, **k):
        raise FileNotFoundError

    monkeypatch.setattr(asyncio, "create_subprocess_exec", boom)
    with pytest.raises(WorkerError, match="docker is not installed"):
        asyncio.run(d.Runner().run(["docker", "ps"]))


@pytest.mark.parametrize('engine', ['claude-code', 'codex'])
@pytest.mark.parametrize('resume', [None, 'saved-session'])
def test_both_workers_receive_approval_instructions_on_start_and_resume(engine, resume):
    settings = Settings(engines={'agent-1': engine})
    prompt = d.exec_argv('agent-1', settings, 'Do the task', resume)[-1]
    assert 'APPROVAL: <action>' in prompt and 'stop without performing it' in prompt
    assert all(action in prompt for action in ('git push', 'deleting files outside the repo', 'installing dependencies'))
    assert prompt.endswith('\nDo the task')
