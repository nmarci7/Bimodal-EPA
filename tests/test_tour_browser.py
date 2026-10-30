"""The guided tour off the happy path, in a real browser: tests/browser/tour_paths.mjs plays it in headless
Chrome against a server of its own (Do it for me clicked through, steps skipped, windows left open, another
model opened, parts deleted, other evidence than the tour asks for). Skipped without Chrome or Node 22+.
EPA_TOUR_FULL=1 adds the slow scenario that skips to every single step from a fresh start."""
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROMES = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
SCENARIOS = ["spam from", "three clicks", "skip everything", "skip one", "skipped run", "window left", "leaving",
             "another kind", "deleting", "failure mode", "different cert", "pressing while", "back, then"]


def find_chrome():
    return next((p for p in (c if os.path.isabs(c) and os.path.exists(c) else shutil.which(c) for c in CHROMES) if p), None)


def find_node():
    node = shutil.which("node")
    if node and subprocess.run([node, "-e", "process.exit(typeof WebSocket === 'function' ? 0 : 1)"]).returncode == 0:
        return node
    return None


def test_the_tour_off_the_happy_path(tmp_path):
    chrome, node = find_chrome(), find_node()
    if not chrome or not node:
        pytest.skip("needs Chrome and Node 22+")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "EPA_WORK": str(tmp_path / "work"), "EPA_WORKSPACE": str(tmp_path / "workspace.json")}
    server = subprocess.Popen([sys.executable, "-m", "uvicorn", "epa.api.app:app", "--port", str(port), "--log-level", "warning"], cwd=ROOT, env=env)
    base = f"http://127.0.0.1:{port}/"
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "api/health", timeout=1)
                break
            except OSError:
                time.sleep(0.2)
        only = [] if os.environ.get("EPA_TOUR_FULL") else SCENARIOS
        run = subprocess.run([node, os.path.join(ROOT, "tests", "browser", "tour_paths.mjs"), base, chrome, str(tmp_path), *only],
                             capture_output=True, text=True, timeout=600)
        assert run.returncode == 0, run.stdout + run.stderr
    finally:
        server.terminate()
        server.wait(timeout=10)
