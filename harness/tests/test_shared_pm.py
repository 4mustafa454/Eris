import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

PM_DIR = Path(__file__).resolve().parents[2] / "shared" / "pm"

# AGENTS.md §5.3
EXPECTED_TOOLS = [
    "get_status", "show_grid", "focus_agent", "send_task", "pause_agent", "resume_agent",
    "stop_all", "explain_agent", "create_task", "decide_approval", "search_history",
]


@pytest.fixture(scope="module")
def tools():
    return json.loads((PM_DIR / "tools.json").read_text())


def test_tool_names_match_contract_exactly(tools):
    assert [t["name"] for t in tools] == EXPECTED_TOOLS


def test_each_tool_is_well_formed(tools):
    for t in tools:
        assert set(t) == {"name", "description", "parameters"}
        assert t["description"].strip()
        schema = t["parameters"]
        Draft202012Validator.check_schema(schema)
        assert schema["type"] == "object"
        assert schema["additionalProperties"] is False
        for prop in schema.get("required", []):
            assert prop in schema["properties"]


def test_agent_number_is_min_1_no_max(tools):
    seen = 0
    for t in tools:
        props = t["parameters"]["properties"]
        for key in ("n", "agent"):
            if key in props:
                seen += 1
                assert props[key]["type"] == "integer"
                assert props[key]["minimum"] == 1
                assert "maximum" not in props[key] and "exclusiveMaximum" not in props[key]
    assert seen == 6  # n: focus, send_task, pause, resume, explain; agent: create_task


def _validator(tools, name):
    return Draft202012Validator(next(t for t in tools if t["name"] == name)["parameters"])


def test_sample_arguments(tools):
    _validator(tools, "focus_agent").validate({"n": 12})  # no upper bound in the schema
    _validator(tools, "send_task").validate({"n": 1, "instruction": "use the v2 endpoint"})
    _validator(tools, "create_task").validate({"title": "t", "instruction": "i"})
    _validator(tools, "decide_approval").validate({"id": "ap-1", "decision": "approved"})
    for name, bad in [
        ("focus_agent", {"n": 0}),
        ("focus_agent", {"n": "2"}),
        ("send_task", {"n": 1}),
        ("send_task", {"n": 1, "instruction": ""}),
        ("decide_approval", {"id": "x", "decision": "maybe"}),
        ("get_status", {"extra": 1}),
    ]:
        with pytest.raises(ValidationError):
            _validator(tools, name).validate(bad)
