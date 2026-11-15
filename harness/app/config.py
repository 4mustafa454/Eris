"""Harness settings from the environment (and harness/.env). Secrets are never returned, printed or put in errors.

REAL_WORKERS      comma-separated agent ids that run as real workers in Docker (default: none, all mock)
WORKER_IMAGE      docker image for the Claude Code worker (default eris-claude-code:2.1.316)
CLAUDE_MAX_TURNS  --max-turns for each claude run, 1 to 200 (default 30)
DEMO_REPO         the git repo mounted at /workspace (default ../demo-repo, relative to harness/)
ERIS_STREAM_LOG   optional file the raw claude stream-json is appended to (secrets redacted), for debugging a run
CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY   required for real Claude workers
"""
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

HARNESS_DIR = Path(__file__).resolve().parent.parent
DEFAULT_IMAGE = "eris-claude-code:2.1.316"
DEFAULT_MAX_TURNS = 30
SECRET_NAMES = ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
# Every variable this module reads, for harness/.env.example (a test keeps the two in step).
ENV_NAMES = ("REAL_WORKERS", "WORKER_IMAGE", "CODEX_WORKER_IMAGE", "CODEX_MODEL", "CODEX_REASONING", "NTFY_TOPIC", "ALERT_CHANNELS", "ALERT_MODE", "ALERT_TO", "ALERT_DRY_RUN", "CHERT_API_KEY", "CHERT_PROJECT_ID", "CHERT_LINE_ID", "CHERT_SIGNING_SECRET", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "AGENT_NAME", "FRAME_URL", "STT_PROVIDER", "TTS_PROVIDER", "LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "OPENAI_API_KEY", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "ERIS_DB_PATH", "ERIS_CORS_ORIGINS", "ERIS_ENV_FILE", "MOCK_TICK", "MOCK_TICK_SECONDS", "CLAUDE_MAX_TURNS", "DEMO_REPO", "ERIS_STREAM_LOG", *SECRET_NAMES)


class ConfigError(Exception):
    """One message listing every problem. Names variables, never values of secrets."""


@dataclass(frozen=True)
class Settings:
    real_workers: tuple[str, ...] = ()
    worker_image: str = DEFAULT_IMAGE
    claude_max_turns: int = DEFAULT_MAX_TURNS
    demo_repo: Path = HARNESS_DIR.parent / "demo-repo"
    secret_name: str | None = None  # which of SECRET_NAMES is set; the value stays in the environment
    stream_log: Path | None = None  # ERIS_STREAM_LOG: where the redacted raw stream is appended, if set

    codex_worker_image: str = "eris-codex:0.167.2"
    engines: dict[str, str] = field(default_factory=dict)
    codex_model: str = "gpt-6.1-terra"
    codex_reasoning: str = "medium"
    ntfy_topic: str | None = None
    alert_channels: tuple[str, ...] = ("ntfy",)
    alert_mode: str = "text"

    def engine_for(self, agent_id: str) -> str:
        return self.engines.get(agent_id, "claude-code")

    def is_real(self, agent_id: str) -> bool:
        return agent_id in self.real_workers


def load_env_file(path: Path | str | None = None, env=None) -> None:
    """Read KEY=VALUE lines from harness/.env into the environment. Variables already set win. No dependency."""
    env = os.environ if env is None else env
    p = Path(path) if path else Path(env.get("ERIS_ENV_FILE") or HARNESS_DIR / ".env")  # ERIS_ENV_FILE: tests point it away
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


def env_file_warnings(path: Path | str | None = None, env=None) -> list[str]:
    """Things in harness/.env that are silently ignored and would otherwise surface much later as a confusing failure.

    Reports line NUMBERS only, never contents: the file holds secrets.
    """
    env = os.environ if env is None else env
    p = Path(path) if path else Path(env.get("ERIS_ENV_FILE") or HARNESS_DIR / ".env")
    try:
        text = p.read_text()
    except OSError:
        return []
    out = []
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            out.append(f"{p.name} line {n} is not KEY=VALUE and is ignored (a value that wrapped onto a new line?)")
            continue
        name = line.partition("=")[0].strip().removeprefix("export ").strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            out.append(f"{p.name} line {n} has an invalid variable name and is ignored")
    return out


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
        elif known_agents[agent_id] not in ("claude-code", "codex"):
            problems.append(f"REAL_WORKERS: {agent_id} has unsupported engine {known_agents[agent_id]!r}")
        elif agent_id in real:
            problems.append(f"REAL_WORKERS: {agent_id} is listed twice")
        else:
            real.append(agent_id)

    image = _get(env, "WORKER_IMAGE") or DEFAULT_IMAGE
    if re.search(r"\s", image):
        problems.append("WORKER_IMAGE must not contain whitespace")

    codex_image = _get(env, "CODEX_WORKER_IMAGE") or "eris-codex:0.167.2"
    if re.search(r"\s", codex_image):
        problems.append("CODEX_WORKER_IMAGE must not contain whitespace")
    codex_model = _get(env, "CODEX_MODEL") or "gpt-6.1-terra"
    if not re.fullmatch(r"[A-Za-z0-9._-]+", codex_model):
        problems.append("CODEX_MODEL contains invalid characters")
    codex_reasoning = _get(env, "CODEX_REASONING") or "medium"
    if codex_reasoning not in ("none", "minimal", "low", "medium", "high", "xhigh", "max"):
        problems.append("CODEX_REASONING is not a supported reasoning level")

    ntfy_topic = _get(env, "NTFY_TOPIC")
    if ntfy_topic and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", ntfy_topic):
        problems.append("NTFY_TOPIC must contain only letters, digits, underscores or hyphens")
    channels = tuple(c.strip() for c in (_get(env, "ALERT_CHANNELS") or "ntfy").split(","))
    if any(c not in ("ntfy", "imessage", "facetime_call") for c in channels) or len(set(channels)) != len(channels):
        problems.append("ALERT_CHANNELS must list unique channels: ntfy, imessage, facetime_call")
    alert_mode = _get(env, "ALERT_MODE") or "text"
    if alert_mode not in ("text", "call", "text_then_call"):
        problems.append("ALERT_MODE must be text, call or text_then_call")

    turns = DEFAULT_MAX_TURNS
    raw_turns = _get(env, "CLAUDE_MAX_TURNS")
    if raw_turns is not None:
        if raw_turns.isdigit() and 1 <= int(raw_turns) <= 200:
            turns = int(raw_turns)
        else:
            problems.append("CLAUDE_MAX_TURNS must be a whole number from 1 to 200")

    raw_repo = _get(env, "DEMO_REPO")
    demo_repo = (HARNESS_DIR / raw_repo).resolve() if raw_repo else HARNESS_DIR.parent / "demo-repo"

    raw_log = _get(env, "ERIS_STREAM_LOG")
    stream_log = (HARNESS_DIR / raw_log).resolve() if raw_log else None

    secret_name = next((n for n in SECRET_NAMES if _get(env, n)), None)
    if any(known_agents[a] == "claude-code" for a in real) and secret_name is None:
        problems.append("REAL_WORKERS needs CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) in harness/.env")

    if problems:
        raise ConfigError("Invalid harness configuration:\n- " + "\n- ".join(problems))
    return Settings(tuple(real), image, turns, demo_repo, secret_name, stream_log, codex_image,
                    {a: known_agents[a] for a in real}, codex_model, codex_reasoning, ntfy_topic, channels, alert_mode)


def main() -> int:
    """`python -m app.config`: check harness/.env and the settings without starting anything. Never prints secrets."""
    load_env_file()
    for warning in env_file_warnings():
        print(f"warning: {warning}")
    try:
        s = load_settings()
    except ConfigError as error:
        print(error)
        return 1
    print(f"real workers: {', '.join(s.real_workers) or 'none (all mock)'}")
    if s.secret_name:
        print(f"{s.secret_name}: set ({len(os.environ[s.secret_name].strip())} characters)")
    else:
        print("no API credential set (only needed for real workers)")
    print(f"image: {s.worker_image}   max turns: {s.claude_max_turns}")
    print(f"demo repo: {s.demo_repo} ({'a git repo' if (s.demo_repo / '.git').exists() else 'NOT a git repo: run scripts/make-demo-repo.sh'})")
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
