"""Shared PM brain loader: system prompt template + tool schemas (see shared/pm/).

Template format is documented at the top of shared/pm/system_prompt.md. The Node supervisor
reimplements the same plain `{{name}}` replacement; keep the two in sync.
"""
import json
import re
from pathlib import Path

PM_DIR = Path(__file__).resolve().parents[2] / "shared" / "pm"

_LEADING_COMMENT = re.compile(r"^\s*<!--.*?-->\s*", re.DOTALL)


def load_tools() -> list[dict]:
    return json.loads((PM_DIR / "tools.json").read_text())


def load_template() -> str:
    """The prompt template with its leading documentation comment stripped."""
    return _LEADING_COMMENT.sub("", (PM_DIR / "system_prompt.md").read_text(), count=1)


def _agent_label(agent: dict) -> str:
    return agent["name"]


def format_last_time(context: dict) -> str:
    items = context.get("recent_summaries") or []
    if not items:
        return "No previous conversations."
    return "\n".join(
        f"- [{s['channel']}, {s.get('ended_at') or 'unknown time'}] {s['summary']}" for s in items
    )


def format_current_state(context: dict) -> str:
    agents = context.get("agents") or []
    names = {a["id"]: _agent_label(a) for a in agents}
    lines = []
    for a in agents:
        line = f"- {a['name']} ({a['state']}, {a['engine']}): {a.get('task') or 'no task'}."
        if a.get("summary"):
            line += f" {a['summary']}."
        if a.get("stuck_reason"):
            line += f" BLOCKED: {a['stuck_reason']}"
        lines.append(line)
    for t in context.get("open_tasks") or []:
        if t.get("status") == "queued":
            lines.append(f"- Queued task: {t['title']}")
    for ap in context.get("pending_approvals") or []:
        who = names.get(ap["agent_id"], ap["agent_id"])
        detail = f" ({ap['detail']})" if ap.get("detail") else ""
        lines.append(f"- Approval {ap['id']}: {who} wants to {ap['action']}{detail}")
    return "\n".join(lines) if lines else "No agents."


def render_prompt(context: dict) -> str:
    """Fill the template from a GET /context response. Plain {{name}} replacement."""
    values = {
        "what_happened_last_time": format_last_time(context),
        "current_state": format_current_state(context),
    }
    text = load_template()
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return text
