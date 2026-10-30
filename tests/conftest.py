"""The differential test compares the engine with a reference that implements the rounds semantics, so it
runs against the rounds translator; every other test runs against the default, fifo."""
import pytest


@pytest.fixture(autouse=True, scope="module")
def _rounds_for_the_differential_test(request):
    if request.module.__name__ != "test_differential":
        yield
        return
    patch = pytest.MonkeyPatch()
    patch.setenv("EPA_SCHEDULE", "rounds")
    yield
    patch.undo()
