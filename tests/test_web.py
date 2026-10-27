"""The workbench's own logic that runs in the browser: web/tests/*.test.js under node, fed every row of
the shipped models with the kind the loader gives it. Skipped where node is not installed."""
import glob
import json
import os
import shutil
import subprocess

import pytest

from epa.model.load import load_model, read_document

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
NODE = shutil.which("node")


def models_fixture():
    out = []
    paths = sorted(glob.glob(os.path.join(ROOT, "cases", "*", "model*.yaml"))) + sorted(glob.glob(os.path.join(ROOT, "tests", "models", "*.yaml")))
    for path in paths:
        doc = read_document(open(path, encoding="utf-8").read())
        m = load_model(doc)
        comps = [{"id": c["id"], "kind": c.get("kind"), "in": c.get("in", []), "out": c.get("out", []), "rows": c.get("rows", []),
                  "kinds": {r["id"]: m.rows[r["id"]].kind for r in c.get("rows", [])}} for c in doc["components"]]
        out.append({"path": os.path.relpath(path, ROOT), "fields": m.fields, "components": comps})
    return out


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_web_row_logic(tmp_path):
    f = tmp_path / "models.json"
    f.write_text(json.dumps(models_fixture()))
    tests = sorted(glob.glob(os.path.join(ROOT, "web", "tests", "*.test.js")))
    assert tests
    r = subprocess.run([NODE, "--test", *tests], cwd=ROOT, env={**os.environ, "EPA_MODELS_JSON": str(f)}, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
