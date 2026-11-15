from app.workers.stuck import StuckDetector
from app.workers.stream import _pytest_failures


def test_silence_starts_from_latest_activity():
    d = StuckDetector(1)
    assert not d.silent(90.9) and d.silent(91)
    d.activity(50)
    assert not d.silent(139.9) and d.silent(140)


def test_repeated_failure_requires_same_test_in_three_consecutive_runs():
    d = StuckDetector(0)
    assert not d.test_run(frozenset({'a', 'b'}))
    assert not d.test_run(frozenset({'b', 'c'}))
    assert d.test_run(frozenset({'b'}))
    assert not d.test_run(frozenset())
    assert not d.test_run(frozenset({'b'}))
    assert not d.test_run(None)
    assert not d.test_run(frozenset({'b'}))


def test_pytest_node_ids_are_extracted_and_ambiguous_output_is_unknown():
    assert _pytest_failures('FAILED tests/test_x.py::test_a - AssertionError\n1 failed in 1s') == frozenset({'tests/test_x.py::test_a'})
    assert _pytest_failures('3 passed in 1s') == frozenset()
    assert _pytest_failures('1 failed in 1s') is None
