"""app/config.py: real-worker selection, validation, .env loading, and that secrets never leak."""
import re
from pathlib import Path

import pytest

from app import config
from app.config import ConfigError, load_env_file, load_settings, secret_values

KNOWN = {"agent-1": "claude-code", "agent-2": "claude-code", "agent-3": "codex"}
TOKEN = "sk-ant-oat01-SECRET-VALUE-123"


def settings(env, known=KNOWN):
    return load_settings(env, known_agents=known)


def test_defaults_are_all_mock_and_need_no_secret():
    s = settings({})
    assert s.real_workers == () and not s.is_real("agent-1")
    assert s.worker_image == "eris-claude-code:2.1.316" and s.claude_max_turns == 30
    assert s.demo_repo == config.HARNESS_DIR.parent / "demo-repo"
    assert s.secret_name is None


def test_real_workers_are_listed_by_id_and_need_a_secret():
    s = settings({"REAL_WORKERS": "agent-1, agent-2", "CLAUDE_CODE_OAUTH_TOKEN": TOKEN})
    assert s.real_workers == ("agent-1", "agent-2")
    assert s.is_real("agent-1") and not s.is_real("agent-3")
    assert s.secret_name == "CLAUDE_CODE_OAUTH_TOKEN"
    assert settings({"REAL_WORKERS": "agent-1", "ANTHROPIC_API_KEY": "k"}).secret_name == "ANTHROPIC_API_KEY"
    with pytest.raises(ConfigError, match="REAL_WORKERS needs CLAUDE_CODE_OAUTH_TOKEN"):
        settings({"REAL_WORKERS": "agent-1"})
    with pytest.raises(ConfigError, match="REAL_WORKERS needs"):
        settings({"REAL_WORKERS": "agent-1", "CLAUDE_CODE_OAUTH_TOKEN": "YOUR_TOKEN_HERE"})


def test_unknown_duplicate_and_non_claude_agents_are_rejected_naming_the_variable():
    base = {"CLAUDE_CODE_OAUTH_TOKEN": TOKEN}
    for value, message in [
        ("agent-9", "unknown agent 'agent-9'"),
        ("agent-1,agent-1", "agent-1 is listed twice"),
        ("agent-3", "agent-3 is a codex agent"),
    ]:
        with pytest.raises(ConfigError, match=re.escape(message)) as e:
            settings({**base, "REAL_WORKERS": value})
        assert "REAL_WORKERS" in str(e.value)


def test_max_turns_image_and_repo_overrides():
    s = settings({"CLAUDE_MAX_TURNS": "12", "WORKER_IMAGE": "my/img:1", "DEMO_REPO": "../elsewhere"})
    assert (s.claude_max_turns, s.worker_image) == (12, "my/img:1")
    assert s.demo_repo == (config.HARNESS_DIR / "../elsewhere").resolve()
    for bad in ["0", "201", "x", "1.5", "-3"]:
        with pytest.raises(ConfigError, match="CLAUDE_MAX_TURNS"):
            settings({"CLAUDE_MAX_TURNS": bad})
    with pytest.raises(ConfigError, match="WORKER_IMAGE"):
        settings({"WORKER_IMAGE": "has space"})


def test_every_problem_is_reported_at_once():
    with pytest.raises(ConfigError) as e:
        settings({"REAL_WORKERS": "agent-1,agent-9", "CLAUDE_MAX_TURNS": "x"})
    text = str(e.value)
    assert "REAL_WORKERS: unknown agent" in text and "CLAUDE_MAX_TURNS" in text and "REAL_WORKERS needs" in text


def test_secrets_never_appear_in_errors_or_reprs():
    env = {"REAL_WORKERS": "agent-9", "CLAUDE_CODE_OAUTH_TOKEN": TOKEN, "ANTHROPIC_API_KEY": TOKEN + "-2"}
    with pytest.raises(ConfigError) as e:
        settings(env)
    assert TOKEN not in str(e.value)
    ok = settings({"REAL_WORKERS": "agent-1", "CLAUDE_CODE_OAUTH_TOKEN": TOKEN})
    assert TOKEN not in repr(ok) and TOKEN not in str(ok)


def test_secret_values_lists_set_secrets_for_redaction():
    assert secret_values({}) == []
    assert secret_values({"CLAUDE_CODE_OAUTH_TOKEN": TOKEN, "ANTHROPIC_API_KEY": ""}) == [TOKEN]
    assert secret_values({"CLAUDE_CODE_OAUTH_TOKEN": "YOUR_TOKEN"}) == []


def test_load_env_file_reads_values_but_never_overrides_the_environment(tmp_path):
    p = tmp_path / ".env"
    p.write_text(
        "# comment\n\nREAL_WORKERS=agent-1\nexport WORKER_IMAGE='quoted:1'\nCLAUDE_MAX_TURNS=\"7\"\n"
        "EMPTY=\nnot a line\nCLAUDE_CODE_OAUTH_TOKEN=from-file\n"
    )
    env = {"CLAUDE_CODE_OAUTH_TOKEN": "from-environment"}
    load_env_file(p, env)
    assert env["REAL_WORKERS"] == "agent-1"
    assert env["WORKER_IMAGE"] == "quoted:1" and env["CLAUDE_MAX_TURNS"] == "7"
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "from-environment"
    assert "EMPTY" not in env
    load_env_file(tmp_path / "missing.env", env)  # a missing file is fine


# --- .env.example ------------------------------------------------------------------------------------------------

EXAMPLE = Path(config.HARNESS_DIR / ".env.example").read_text()
ASSIGNMENTS = [line for line in EXAMPLE.splitlines() if re.match(r"^[A-Z][A-Z0-9_]*=", line)]
NAMES = [line.split("=")[0] for line in ASSIGNMENTS]


def test_env_example_has_names_only_no_duplicates():
    assert all(re.fullmatch(r"[A-Z][A-Z0-9_]*=", line) for line in ASSIGNMENTS)
    assert len(NAMES) == len(set(NAMES))


def test_env_example_lists_exactly_the_variables_config_reads():
    assert sorted(NAMES) == sorted(config.ENV_NAMES)
