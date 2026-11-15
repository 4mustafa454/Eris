"""Harness settings from the environment (and harness/.env). Secrets are never returned, printed or put in errors.

REAL_WORKERS      comma-separated agent ids that run as real workers in Docker (default: none, all mock)
WORKER_IMAGE      docker image for the Claude Code worker (default eris-claude-code:2.1.316)
CLAUDE_MAX_TURNS  --max-turns for each claude run, 1 to 200 (default 30)
DEMO_REPO         the git repo mounted at /workspace (default ../demo-repo, relative to harness/)
CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY   required when REAL_WORKERS is not empty (AGENTS.md §7)
"""
import os
import re
from dataclasses import dataclass
from pathlib import Path

HARNESS_DIR = Path(__file__).resolve().parent.parent
DEFAULT_IMAGE = "eris-claude-code:2.1.316"
DEFAULT_MAX_TURNS = 30
SECRET_NAMES = ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
# Every variable this module reads, for harness/.env.example (a test keeps the two in step).
ENV_NAMES = ("REAL_WORKERS", "WORKER_IMAGE", "CLAUDE_MAX_TURNS", "DEMO_REPO", *SECRET_NAMES)


class ConfigError(Exception):
    """One message listing every problem. Names variables, never values of secrets."""


@dataclass(frozen=True)
class Settings:
    real_workers: tuple[str, ...] = ()
    worker_image: str = DEFAULT_IMAGE
    claude_max_turns: int = DEFAULT_MAX_TURNS
    demo_repo: Path = HARNESS_DIR.parent / "demo-repo"
    secret_name: str | None = None  # which of SECRET_NAMES is set; the value stays in the environment

    def is_real(self, agent_id: str) -> bool:
        return agent_id in self.real_workers


def load_env_file(path: Path | str | None = None, env=None) -> None:
    """Read KEY=VALUE lines from harness/.env into the environment. Variables already set win. No dependency."""
    env = os.environ if env is None else env
    p = Path(path) if path else HARNESS_DIR / ".env"
    try:
        text = p.read_text()
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and value != "" and key not in env:
            env[key] = value


def _get(env, name: str) -> str | None:
    value = env.get(name)
    if value is None or value.strip() == "" or value.strip().startswith("YOUR_"):
        return None
    return value.strip()


def secret_values(env=None) -> list[str]:
    """The secret strings currently set, for redacting logs and event lines. Internal use only."""
    env = os.environ if env is None else env
    return [v for n in SECRET_NAMES if (v := _get(env, n))]


def load_settings(env=None, known_agents: dict[str, str] | None = None) -> Settings:
    """Validate and return the settings. `known_agents` maps agent id → engine (default: the seeded ones).

    Raises ConfigError naming every bad variable.
    """
    env = os.environ if env is None else env
    if known_agents is None:
        from .workers import mock  # imported late: mock.py imports this package's db/agents modules

        known_agents = {s["id"]: s["engine"] for s in mock.SEED}
    problems: list[str] = []

    real: list[str] = []
    raw = _get(env, "REAL_WORKERS")
    for item in (raw.split(",") if raw else []):
        agent_id = item.strip()
        if not agent_id:
            continue
        if agent_id not in known_agents:
            problems.append(f"REAL_WORKERS: unknown agent {agent_id!r} (known: {', '.join(sorted(known_agents))})")
        elif known_agents[agent_id] != "claude-code":
            problems.append(f"REAL_WORKERS: {agent_id} is a {known_agents[agent_id]} agent; only claude-code agents can be real in M3")
        elif agent_id in real:
            problems.append(f"REAL_WORKERS: {agent_id} is listed twice")
        else:
            real.append(agent_id)

    image = _get(env, "WORKER_IMAGE") or DEFAULT_IMAGE
    if re.search(r"\s", image):
        problems.append("WORKER_IMAGE must not contain whitespace")

    turns = DEFAULT_MAX_TURNS
    raw_turns = _get(env, "CLAUDE_MAX_TURNS")
    if raw_turns is not None:
        if raw_turns.isdigit() and 1 <= int(raw_turns) <= 200:
            turns = int(raw_turns)
        else:
            problems.append("CLAUDE_MAX_TURNS must be a whole number from 1 to 200")

    raw_repo = _get(env, "DEMO_REPO")
    demo_repo = (HARNESS_DIR / raw_repo).resolve() if raw_repo else HARNESS_DIR.parent / "demo-repo"

    secret_name = next((n for n in SECRET_NAMES if _get(env, n)), None)
    if real and secret_name is None:
        problems.append("REAL_WORKERS needs CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) in harness/.env")

    if problems:
        raise ConfigError("Invalid harness configuration:\n- " + "\n- ".join(problems))
    return Settings(tuple(real), image, turns, demo_repo, secret_name)
