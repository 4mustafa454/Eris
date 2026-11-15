"""app/config.py: real-worker selection, validation, .env loading, and that secrets never leak."""
import re
from pathlib import Path

import pytest

from app import config
from app.config import ConfigError, load_env_file, load_settings, secret_values

KNOWN = {"agent-1": "claude-code", "agent-2": "claude-code", "agent-3": "codex"}
TOKEN = "sk-ant-oat01-SECRET-VALUE-123"


def test_environment_file_is_isolated_and_can_be_overridden(tmp_path, monkeypatch):
    import os

    isolated = Path(os.environ["ERIS_ENV_FILE"])
    assert isolated.is_relative_to(tmp_path) and isolated.read_text() == ""
    custom = tmp_path / "custom.env"
    custom.write_text("ERIS_TEST_VALUE=custom\n")
    monkeypatch.setenv("ERIS_ENV_FILE", str(custom))
    env = {"ERIS_ENV_FILE": str(custom)}
    load_env_file(env=env)
    assert env["ERIS_TEST_VALUE"] == "custom"


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


def test_stream_log_is_optional_and_relative_to_harness():
    assert settings({}).stream_log is None
    assert settings({"ERIS_STREAM_LOG": "data/stream.log"}).stream_log == (config.HARNESS_DIR / "data/stream.log").resolve()
    assert settings({"ERIS_STREAM_LOG": "  "}).stream_log is None


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


# --- .env problems that would otherwise be silent ---------------------------------------------------------------

LEAK = "SECRET-TAIL-OF-A-WRAPPED-TOKEN-xyz"


def test_a_value_that_wrapped_onto_a_new_line_is_reported_by_line_number_without_its_content(tmp_path):
    p = tmp_path / ".env"
    p.write_text(f"# comment\nREAL_WORKERS=agent-1\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-first-half\n {LEAK}\n\nWORKER_IMAGE=x\n")
    warnings = config.env_file_warnings(p, {})
    assert len(warnings) == 1 and "line 4" in warnings[0] and "wrapped" in warnings[0]
    assert LEAK not in warnings[0] and "sk-ant" not in warnings[0], "the file holds secrets: never echo its content"


def test_other_ignored_lines_are_reported_too_and_clean_files_are_not(tmp_path):
    p = tmp_path / ".env"
    p.write_text("1BAD=x\nok=fine\nexport REAL_WORKERS=agent-1\nA-B=3\n")
    w = config.env_file_warnings(p, {})
    assert [x.split(" has ")[0] for x in w] == [".env line 1", ".env line 4"]
    p.write_text("# nothing wrong\nREAL_WORKERS=agent-1\n\nCLAUDE_MAX_TURNS=5\n")
    assert config.env_file_warnings(p, {}) == []
    assert config.env_file_warnings(tmp_path / "missing.env", {}) == []


def test_the_check_command_summarises_without_printing_any_secret(tmp_path, monkeypatch, capsys):
    p = tmp_path / "e.env"
    p.write_text(f"REAL_WORKERS=agent-1\nCLAUDE_CODE_OAUTH_TOKEN={TOKEN}\nDEMO_REPO={tmp_path}\n")
    monkeypatch.setenv("ERIS_ENV_FILE", str(p))
    assert config.main() == 0
    out = capsys.readouterr().out
    assert "real workers: agent-1" in out and f"CLAUDE_CODE_OAUTH_TOKEN: set ({len(TOKEN)} characters)" in out
    assert "NOT a git repo" in out and out.strip().endswith("OK")
    assert TOKEN not in out and "sk-ant" not in out


def test_the_check_command_fails_clearly_on_a_bad_file(tmp_path, monkeypatch, capsys):
    p = tmp_path / "e.env"
    p.write_text(f"REAL_WORKERS=-1\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-first-half\n {LEAK}\n")
    monkeypatch.setenv("ERIS_ENV_FILE", str(p))
    assert config.main() == 1
    out = capsys.readouterr().out
    assert "warning:" in out and "line 3" in out and "REAL_WORKERS: unknown agent '-1'" in out
    assert LEAK not in out and "first-half" not in out


def test_the_app_prints_env_warnings_at_startup(db_file, tmp_path, monkeypatch, capsys):
    from fastapi.testclient import TestClient
    from app.main import app
    p = tmp_path / "e.env"
    p.write_text(f"WORKER_IMAGE=x\n {LEAK}\n")
    monkeypatch.setenv("ERIS_ENV_FILE", str(p))
    with TestClient(app):
        pass
    err = capsys.readouterr().err
    assert "[eris] e.env line 2 is not KEY=VALUE" in err and LEAK not in err


def test_mixed_engines_and_codex_only():
    s = settings({"REAL_WORKERS": "agent-1,agent-3", "CLAUDE_CODE_OAUTH_TOKEN": TOKEN})
    assert s.engine_for("agent-1") == "claude-code" and s.engine_for("agent-3") == "codex"
    assert settings({"REAL_WORKERS": "agent-3"}).secret_name is None
    with pytest.raises(ConfigError, match="unsupported engine"):
        settings({"REAL_WORKERS": "agent-4"}, {"agent-4": "unknown"})
