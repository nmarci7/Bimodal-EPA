"""The tutorial (web/tutorial-steps.js) says what verdict each step leads to; this replays its steps under
node and checks every one with the engine: the models are well-formed and the verdict of the followed
cell is the promised one (unchecked, exposed, guarantee, unchecked, hope, unchecked, guarantee)."""
import json
import os
import shutil
import subprocess

import pytest

from epa.engine.coordinator import Engine
from epa.model.load import load_model, validate

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

REPLAY = """
import('./tutorial-steps.js').then((m) => {
  let cur = { doc: null, ev: null };
  const steps = [];
  for (const st of m.STEPS) { const n = st.apply(JSON.parse(JSON.stringify(cur))); cur = { doc: n.doc, ev: n.ev }; steps.push(cur); }
  console.log(JSON.stringify({ cell: m.CELL, expected: m.EXPECTED, steps }));
});
"""


@pytest.fixture(scope="module")
def replay():
    if not NODE:
        pytest.skip("node is not installed")
    out = subprocess.run([NODE, "--input-type=module", "-e", REPLAY], cwd=os.path.join(ROOT, "web"),
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def test_every_step_gives_the_verdict_the_tutorial_promises(replay, tmp_path):
    assert len(replay["steps"]) == len(replay["expected"]) == 7
    for i, (step, (verdict, statuses)) in enumerate(zip(replay["steps"], replay["expected"]), start=1):
        assert validate(step["doc"]) == [], f"step {i}"
        rep = Engine(load_model(step["doc"]), str(tmp_path)).analyse(step["ev"], rank=False)
        cell = next(c for c in rep["cells"] if c["cell"] == replay["cell"])
        assert (cell["verdict"], ",".join(cell["statuses"])) == (verdict, statuses), f"step {i}"


def test_the_fixed_parser_makes_the_test_report_stale(replay, tmp_path):
    step = replay["steps"][2]
    rep = Engine(load_model(step["doc"]), str(tmp_path)).analyse(step["ev"], rank=False)
    states = {c["id"]: c["state"] for c in rep["register"]["certificates"]}
    assert states == {"c_test": "stale", "c_fix": "in force"}
