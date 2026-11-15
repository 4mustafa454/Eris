"""Claude Code `--output-format stream-json` (one JSON object per line) → short event lines + run outcome.

Pure: no I/O, no DB. `StreamParser.feed(line)` never raises: bad JSON, non-objects and unknown event types are
ignored, so a new claude version can only make the log quieter, never break a run.

Event lines are one line, at most MAX_LINE characters, phone-readable ("run pytest → 2 failed", "edit shop/signup.py").
Known secret values are replaced with [redacted] in everything this module returns.
"""
import json
import re
from dataclasses import dataclass, field

MAX_LINE = 80
MAX_REASON = 200
REDACTED = "[redacted]"

# pytest as the command being run (not an argument: "pip install pytest" and "cat pytest.ini" do not count)
_PYTEST = re.compile(r"(?:^|[;&|(])\s*(?:(?:uv|poetry|pipenv)\s+run\s+)?(?:python3?\s+-m\s+)?pytest(?:\s|$)")
_GIT_COMMIT = re.compile(r"(?:^|[;&|(])\s*git\s+commit\b")
_COUNT = {k: re.compile(rf"(\d+) {k}") for k in ("failed", "passed", "error")}
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


@dataclass
class Result:
    """How a run ended. kind: done | blocked | max_turns | error."""
    kind: str
    text: str = ""            # the final message (done/blocked), or what went wrong
    reason: str | None = None  # blocked: the question; max_turns/error: why
    summary: str | None = None  # done: a one-sentence summary for AgentState.summary


@dataclass
class Update:
    """What one stream line changed."""
    lines: list[str] = field(default_factory=list)  # event lines to append, in order
    summary: str | None = None                       # new AgentState.summary, if the assistant said something
    session_id: str | None = None                    # claude's session id, for --resume
    result: Result | None = None                     # set on the final `result` event
    alive: bool = False                              # a valid JSON object arrived (the worker is producing output)


def _clean(text: str) -> str:
    """One line: control characters out, whitespace collapsed."""
    return " ".join(_CONTROL.sub(" ", text).split())


def _cut(text: str, limit: int) -> str:
    """Cut to `limit` characters with an ellipsis, at a word boundary when that keeps at least half the text."""
    if len(text) <= limit:
        return text
    head = text[: limit - 1]
    if not text[limit - 1].isspace() and " " in head:
        whole_words = head.rsplit(" ", 1)[0]
        if len(whole_words) >= limit // 2:
            head = whole_words
    return head.rstrip(" ,;:") + "…"


def first_sentence(text: str, limit: int = MAX_LINE) -> str:
    text = _clean(text)
    m = re.match(r"(.+?[.!?])(?:\s|$)", text)
    return _cut(m.group(1) if m else text, limit)


def _relative(path: str) -> str:
    return path.removeprefix("/workspace/")


def _pytest_outcome(output: str) -> str:
    """The pytest summary as a few words: '2 failed', '1 error', '4 passed', 'no tests ran'. Last summary wins."""
    counts = {}
    for key, rx in _COUNT.items():
        found = rx.findall(output)
        if found:
            counts[key] = int(found[-1])
    if counts.get("failed"):
        return f"{counts['failed']} failed"
    if counts.get("error"):
        return f"{counts['error']} error"
    if counts.get("passed"):
        return f"{counts['passed']} passed"
    return "no tests ran" if "no tests ran" in output else "error"


def _tool_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict))
    return ""


def _blocked_reason(text: str) -> str | None:
    """The last line of the reply that starts with BLOCKED:, per demo-repo/AGENTS.md. None if there is none."""
    found = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("BLOCKED:"):
            found = _clean(line[len("BLOCKED:"):])
    if found is None:
        return None
    return _cut(found, MAX_REASON) or "blocked (no question given)"


class StreamParser:
    def __init__(self, secrets: list[str] | tuple[str, ...] = ()):
        self._secrets = [s for s in secrets if s]
        self._pending: dict[str, dict] = {}  # tool_use id → {name, input, deferred}
        self.session_id: str | None = None
        self.result: Result | None = None

    # -- public ---------------------------------------------------------------------------------------------------

    def feed(self, raw: str | bytes) -> Update:
        try:
            text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
            text = text.strip()
            if not text.startswith("{"):
                return Update()
            event = json.loads(text)
            if not isinstance(event, dict):
                return Update()
            update = self._handle(event)
        except Exception:  # a parser must never take the run down
            return Update()
        update.alive = True
        update.lines = [ln for ln in (self.redact(_cut(_clean(ln), MAX_LINE)) for ln in update.lines) if ln]
        if update.summary:
            update.summary = self.redact(update.summary)
        if update.result:
            r = update.result
            r.text, r.reason, r.summary = self.redact(r.text), self.redact(r.reason), self.redact(r.summary)
        return update

    def finish(self, exit_code: int | None) -> Result:
        """The run's outcome at end of stream: the `result` event if one arrived, else an error."""
        if self.result is not None:
            return self.result
        why = f"the worker exited without a result (exit code {exit_code})" if exit_code is not None else \
            "the worker stopped without a result"
        return Result("error", self.redact(why), self.redact(why))

    # -- internals ------------------------------------------------------------------------------------------------

    def redact(self, text):
        if not text:
            return text
        for s in self._secrets:
            text = text.replace(s, REDACTED)
        return text

    def _handle(self, event: dict) -> Update:
        out = Update()
        sid = event.get("session_id")
        if isinstance(sid, str) and sid:
            out.session_id = self.session_id = sid
        kind = event.get("type")
        if kind == "assistant":
            self._assistant(event, out)
        elif kind == "user":
            self._tool_results(event, out)
        elif kind == "result":
            self._final(event, out)
        return out  # "system" and anything unknown: only the session id above

    def _assistant(self, event: dict, out: Update) -> None:
        content = (event.get("message") or {}).get("content")
        if not isinstance(content, list):
            return
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                if block.get("text", "").strip():
                    out.summary = first_sentence(block["text"])
            elif block.get("type") == "tool_use":
                self._tool_use(block, out)

    def _tool_use(self, block: dict, out: Update) -> None:
        if not block.get("name"):
            return
        name = str(block["name"])
        inp = block.get("input") if isinstance(block.get("input"), dict) else {}
        deferred = name == "Bash" and bool(_PYTEST.search(str(inp.get("command", ""))))
        if isinstance(block.get("id"), str):
            self._pending[block["id"]] = {"name": name, "input": inp, "deferred": deferred}
        if deferred:
            return  # shown when the result arrives, with its outcome: "run pytest → 2 failed"
        line = self._describe(name, inp)
        if line:
            out.lines.append(line)

    def _tool_results(self, event: dict, out: Update) -> None:
        content = (event.get("message") or {}).get("content")
        if not isinstance(content, list):
            return
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            use = self._pending.pop(block.get("tool_use_id"), None)
            if use is None:
                continue
            if use["deferred"]:
                out.lines.append(f"run pytest → {_pytest_outcome(_tool_text(block.get('content')))}")
            elif block.get("is_error") and use["name"] != "TodoWrite":
                out.lines.append(f"{self._short_name(use['name'])} → error")

    @staticmethod
    def _short_name(name: str) -> str:
        return name.split("__")[-1].lower()

    def _describe(self, name: str, inp: dict) -> str | None:
        path = _relative(str(inp.get("file_path") or inp.get("path") or ""))
        if name == "Bash":
            cmd = _clean(str(inp.get("command", "")))
            return "git commit" if _GIT_COMMIT.search(cmd) else f"run {cmd}"
        if name in ("Edit", "MultiEdit", "NotebookEdit"):
            return f"edit {path}".strip()
        if name == "Write":
            return f"write {path}".strip()
        if name == "Read":
            return f"read {path}".strip()
        if name == "Grep":
            return f"grep {inp.get('pattern', '')}".strip()
        if name == "Glob":
            return f"find {inp.get('pattern', '')}".strip()
        if name == "LS":
            return f"ls {path}".strip()
        if name == "TodoWrite":
            return None
        return self._short_name(name)

    def _final(self, event: dict, out: Update) -> None:
        text = event.get("result") if isinstance(event.get("result"), str) else ""
        subtype = str(event.get("subtype") or "")
        if subtype == "error_max_turns" or event.get("terminal_reason") == "max_turns":
            result = Result("max_turns", text, "ran out of turns")
        elif event.get("is_error") or subtype.startswith("error"):
            why = _cut(_clean(text) or subtype or "the run failed", MAX_REASON)
            result = Result("error", text or why, why)
        elif (question := _blocked_reason(text)) is not None:
            result = Result("blocked", text, question)
        else:
            result = Result("done", text, None, first_sentence(text) if text.strip() else None)
        out.result = self.result = result
