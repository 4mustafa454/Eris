"""Pure per-task signals for worker stuck detection."""


class StuckDetector:
    def __init__(self, now: float):
        self.last_activity = now
        self._common = frozenset()
        self._consecutive = 0

    def activity(self, now: float) -> None:
        self.last_activity = now

    def silent(self, now: float) -> bool:
        return now - self.last_activity >= 90

    def test_run(self, failures: frozenset[str] | None) -> bool:
        if not failures:
            self._common = frozenset()
            self._consecutive = 0
            return False
        common = self._common & failures
        if common:
            self._common = common
            self._consecutive += 1
        else:
            self._common = failures
            self._consecutive = 1
        return self._consecutive >= 3
