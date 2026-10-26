"""Differential test: the engine against the independent reference semantics (tests/reference).

For EPA_DIFF_SEEDS random cases (default 60) the engine's verdict and statuses are compared per
cell with what tests/reference/semantics.py computes by brute force. Two assertions per cell:

  SOUND   the engine's statuses include the reference's (it may be less precise, never claim more),
          so it never says guarantee / hope / exposed where the reference says otherwise unless its
          statuses are a superset;
  EXACT   verdict and statuses are equal. A mismatch is *explained* (reported as xfail, and
          counted) when the reference itself changes once the witnesses are cut down to the
          cell's own point and field, i.e. a witness constrains the cell through fields outside
          it, which the engine's per-cell projection is allowed to lose. Any other mismatch fails.

Environment:
  EPA_ENGINE_ROOT      the checkout whose `epa` package is tested (default: this worktree)
  EPA_DIFF_SEEDS       number of seeds (default 60)
  EPA_DIFF_FEATURES    full (default: the target format) | old (what the engine before draft 4 can load)
  EPA_DIFF_REPORT      optional path: the per-cell comparison is written there as JSON

The second half of the file checks the reference itself on hand-computed examples.
"""
import copy
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from reference import generate as G          # noqa: E402
from reference import semantics as S         # noqa: E402

ENGINE_ROOT = os.path.abspath(os.environ.get("EPA_ENGINE_ROOT", ROOT))
N_SEEDS = int(os.environ.get("EPA_DIFF_SEEDS", "60"))
FEATURES = {"old": G.OLD_ENGINE, "full": G.FULL}[os.environ.get("EPA_DIFF_FEATURES", "full")]


def _import_engine():
    """Import `epa` from ENGINE_ROOT, even if another checkout's `epa` was imported first."""
    mod = sys.modules.get("epa")
    if mod is not None and not os.path.abspath(mod.__file__).startswith(ENGINE_ROOT + os.sep):
        for name in [n for n in sys.modules if n == "epa" or n.startswith("epa.")]:
            del sys.modules[name]
    if ENGINE_ROOT in sys.path:
        sys.path.remove(ENGINE_ROOT)
    sys.path.insert(0, ENGINE_ROOT)
    from epa.engine.coordinator import Engine
    from epa.model.load import load_model
    import epa
    assert os.path.abspath(epa.__file__).startswith(ENGINE_ROOT + os.sep), epa.__file__
    return Engine, load_model


# ---------------------------------------------------------------------------------------------
# the comparison
# ---------------------------------------------------------------------------------------------

def _project(evidence, cell):
    """The evidence with every witness cut down to the cell's own point and field."""
    oid, _cid, kind, fld, _k = cell
    ev = copy.deepcopy(evidence)
    wits = []
    for w in ev.get("witnesses", []):
        logged = w["at"].get(oid)
        if logged is None:
            continue
        keep = {k: v for k, v in logged.items() if k == "used"}
        if kind == "mode" and fld in (logged.get("modes") or {}):
            keep["modes"] = {fld: logged["modes"][fld]}
        elif kind in ("taint", "conf", "auth") and kind in logged:
            keep[kind] = logged[kind]
        if keep:
            wits.append({**w, "at": {oid: keep}})
    ev["witnesses"] = wits
    return ev


def _short(r):
    return None if r is None else {"verdict": r["verdict"], "statuses": list(r["statuses"])}


def is_sound(ref, eng):
    if eng is None:
        return False
    rs, es = set(ref["statuses"]), set(eng["statuses"])
    if not es >= rs:
        return False
    if eng["verdict"] in ("guarantee", "hope", "exposed") and eng["verdict"] != ref["verdict"] and not es >= rs:
        return False
    return True


def is_exact(ref, eng):
    return eng is not None and eng["verdict"] == ref["verdict"] and list(eng["statuses"]) == list(ref["statuses"])


_CACHE = {}


def compare(seed, workroot):
    """Per-cell records for one seed: reference, engine, SOUND, EXACT, explained."""
    if seed in _CACHE:
        return _CACHE[seed]
    Engine, load_model = _import_engine()
    doc, evidence = G.random_case(seed, FEATURES)
    ref = S.reference(doc, evidence)
    rec = {"seed": seed, "doc": doc, "evidence": evidence, "error": None, "cells": []}
    try:
        rep = Engine(load_model(copy.deepcopy(doc)), os.path.join(workroot, f"seed{seed}")).analyse(
            copy.deepcopy(evidence), rank=False)
        eng = {c["cell"]: _short(c) for c in rep["cells"]}
    except Exception as e:                                      # noqa: BLE001 - reported per seed
        rec["error"] = f"{type(e).__name__}: {e}"
        eng = {}
    cells = S.Model(doc).cells()
    for cell in cells:
        cid = cell[1]
        r, e = _short(ref[cid]), eng.get(cid)
        exact = is_exact(r, e)
        explained = None
        if not exact:
            proj = _short(S.reference(doc, _project(evidence, cell))[cid])
            explained = proj != r
            rec_proj = proj
        else:
            rec_proj = None
        rec["cells"].append({"cell": cid, "ref": r, "eng": e, "sound": is_sound(r, e), "exact": exact,
                             "explained": explained, "ref_projected": rec_proj})
    for cid in sorted(set(eng) - {c[1] for c in cells}):         # cells only the engine has
        rec["cells"].append({"cell": cid, "ref": None, "eng": eng[cid], "sound": False, "exact": False,
                             "explained": False, "ref_projected": None})
    _CACHE[seed] = rec
    return rec


@pytest.fixture(scope="module")
def workroot(tmp_path_factory):
    return str(tmp_path_factory.mktemp("differential"))


def _describe(rec, bad):
    lines = [f"seed {rec['seed']}" + (f" engine error: {rec['error']}" if rec["error"] else "")]
    for c in bad:
        lines.append(f"  {c['cell']}: engine {c['eng']} reference {c['ref']}"
                     + (f" (reference on projected witnesses {c['ref_projected']})" if c.get("ref_projected") else ""))
    return "\n".join(lines)


@pytest.mark.parametrize("seed", range(N_SEEDS))
def test_sound(seed, workroot):
    rec = compare(seed, workroot)
    bad = [c for c in rec["cells"] if not c["sound"]]
    assert rec["error"] is None and not bad, _describe(rec, bad)


@pytest.mark.parametrize("seed", range(N_SEEDS))
def test_exact(seed, workroot):
    rec = compare(seed, workroot)
    bad = [c for c in rec["cells"] if not c["exact"]]
    unexplained = [c for c in bad if not c["explained"]]
    assert rec["error"] is None and not unexplained, _describe(rec, unexplained)
    if bad:
        pytest.xfail(f"{len(bad)} cell(s) differ only through witness fields outside the cell: "
                     + _describe(rec, bad))


def test_differential_summary(workroot, capsys):
    """Counts over every seed (printed with -s; written to EPA_DIFF_REPORT if set). Never fails."""
    recs = [compare(seed, workroot) for seed in range(N_SEEDS)]
    cells = [c for r in recs for c in r["cells"]]
    summary = {
        "engine_root": ENGINE_ROOT, "features": os.environ.get("EPA_DIFF_FEATURES", "full"),
        "seeds": len(recs), "cells": len(cells), "engine_errors": sum(1 for r in recs if r["error"]),
        "sound_mismatches": sum(1 for c in cells if not c["sound"]),
        "exact_mismatches": sum(1 for c in cells if not c["exact"]),
        "exact_explained": sum(1 for c in cells if not c["exact"] and c["explained"]),
        "exact_unexplained": sum(1 for c in cells if not c["exact"] and not c["explained"]),
        "seeds_unsound": sorted(r["seed"] for r in recs if r["error"] or any(not c["sound"] for c in r["cells"])),
        "seeds_inexact": sorted(r["seed"] for r in recs if any(not c["exact"] for c in r["cells"])),
    }
    with capsys.disabled():
        print("\ndifferential summary:", json.dumps(summary, indent=1))
    path = os.environ.get("EPA_DIFF_REPORT")
    if path:
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"summary": summary, "seeds": recs}, f, indent=1, default=str)


# ---------------------------------------------------------------------------------------------
# the reference itself, on hand-computed examples
# ---------------------------------------------------------------------------------------------

RUNNING = os.path.join(HERE, "models", "running_example.yaml")
CERT_M1 = {"id": "c_m1", "component": "M", "targets": {"oom": "never"}, "version": "mandate-v2"}
W1 = {"id": "W1", "use_case": "pay", "at": {"o": {"modes": {"oom": [1, 10]}}}}
W2 = {"id": "W2", "use_case": "pay", "at": {"o": {"modes": {"oom": [0, 0]}}}}


def _doc(path):
    import yaml
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


@pytest.mark.parametrize("evidence, verdict, statuses, remaining, suspended", [
    ({}, "unchecked", ["N", "S", "A"], 6, []),
    ({"certificates": [CERT_M1]}, "guarantee", ["N"], 2, []),
    ({"witnesses": [W1]}, "unchecked", ["S", "A"], 4, []),
    ({"witnesses": [W2]}, "unchecked", ["N", "S"], 5, []),
    ({"witnesses": [W1, W2]}, "hope", ["S"], 3, []),
    ({"certificates": [CERT_M1], "witnesses": [W1]}, "unchecked", ["S", "A"], 4, ["c_m1"]),
])
def test_reference_running_example(evidence, verdict, statuses, remaining, suspended):
    got = S.reference(_doc(RUNNING), evidence)["oom@o"]
    assert (got["verdict"], got["statuses"], got["remaining"], got["suspended"]) == \
        (verdict, statuses, remaining, suspended)


def test_reference_running_example_runs():
    """Figure of the candidates: the statement is used in every run and reached only in run 11."""
    A = S.Analysis(_doc(RUNNING))
    assert A.bit_rows == ["leak.M.oom", "p1"]
    assert {vec: A.runs[("pay", vec)][0]["oom@o"] for vec in [(0, 0), (0, 1), (1, 0), (1, 1)]} == \
        {(0, 0): (True, False), (0, 1): (True, False), (1, 0): (True, False), (1, 1): (True, True)}
    assert sorted(A.status(c, "oom@o") for c in A.candidates) == sorted("NNSSSA")


INTERNAL = {
    "modes": ["omission", "late"],
    "components": [
        {"id": "X", "kind": "deterministic", "in": ["i"], "out": ["o"]},
        {"id": "D", "kind": "deterministic", "in": [], "out": ["o"],
         "rows": [{"id": "f", "when": {}, "then": {"o": {"late": "const 5"}}}]},
    ],
    "edges": [{"id": "e_in", "from": "sys.in", "to": "X.i"},
              {"id": "e_x", "from": "X.o", "to": "sys.xout"},
              {"id": "e_d", "from": "D.o", "to": "sys.out"}],
    "use_cases": [{"id": "u", "entries": [{"port": "in", "token": {}}]}],
    "observation_points": [{"id": "o", "edge": "e_d", "tolerate": {"late": 1}}],
}


def test_reference_internal_fault_reaches():
    """(a) D receives nothing, yet its internal fault puts late 5 on e_d whenever it is on: with
    f sometimes the point is used exactly in the runs that reach it, so S says always."""
    M = S.Model(INTERNAL)
    assert M.rows["f"].kind == "internal" and M.rows["f"].domain == ("N", "S", "A")
    lab = S.propagate(M, "u", {"f"})
    assert lab["e_d"].used and not lab["e_d"].normal and S.effective(M, lab["e_d"].tok, "late") == 5
    assert not S.propagate(M, "u", set())["e_d"].used
    got = S.reference(INTERNAL, {})["late@o"]
    assert (got["verdict"], got["statuses"]) == ("unchecked", ["N", "A"])
    always = {"id": "c", "component": "D", "rows": {"f": "always"}}
    assert S.reference(INTERNAL, {"certificates": [always]})["late@o"]["verdict"] == "exposed"
    never = {"id": "c", "component": "D", "rows": {"f": "never"}}
    assert S.reference(INTERNAL, {"certificates": [never]})["late@o"]["verdict"] == "not exercised"


def _fork(flow_y, emit_port):
    return {
        "modes": ["omission", {"commission": ["oom"]}],
        "components": [
            {"id": "D1", "kind": "deterministic", "in": ["i"], "out": ["x", "y"], "flow": {"i": flow_y},
             "rows": [{"id": "r", "when": {"i": "any"}, "then": {emit_port: {"oom": "const 7"}},
                       "activation": "always"}]},
            {"id": "D2", "kind": "deterministic", "in": ["a", "b"], "out": ["o"], "flow": {"a": [], "b": []},
             "rows": [{"id": "j", "when": {"a": "any", "b": "any"}, "then": {"o": "as it is"}}]},
        ],
        "guards": [{"id": "G", "edge": "e_o", "targets": [{"mode": "oom", "threshold": 1, "decidable": True}]}],
        "edges": [{"id": "e_in", "from": "sys.in", "to": "D1.i"},
                  {"id": "e_x", "from": "D1.x", "to": "D2.a"},
                  {"id": "e_y", "from": "D1.y", "to": "D2.b"},
                  {"id": "e_o", "from": "D2.o", "to": "sys.out"}],
        "use_cases": [{"id": "u", "entries": [{"port": "in", "token": {}}]}],
        "observation_points": [{"id": "o", "edge": "e_o", "tolerate": {"oom": 1}}],
    }


CERT_G = {"id": "c_g", "component": "G", "targets": {"oom": "never"}}


def test_reference_fork_join_not_dropped():
    """(b) Both branches carry the normal flow, so the join's message is normal: G catches oom 7 in
    it and forwards the message capped (guarantee), it does not drop it (not exercised)."""
    doc = _fork(["x", "y"], "x")
    M = S.Model(doc)
    assert M.rows["j"].kind == "forward" and M.rows["j"].fixed == "A"
    lab = S.propagate(M, "u", {"r", "j"})
    assert lab["e_o"].normal and S.effective(M, lab["e_o"].tok, "oom") == 7
    assert lab["e_o__G"].used and S.effective(M, lab["e_o__G"].tok, "oom") == 0
    got = S.reference(doc, {"certificates": [CERT_G]})["oom@o"]
    assert (got["verdict"], got["statuses"], got["remaining"]) == ("guarantee", ["N"], 1)
    assert S.reference(doc, {})["oom@o"]["statuses"] == ["N", "S", "A"]


def test_reference_fork_join_failure_branch_dropped():
    """(b') Contrast: the second branch exists only because the failure row r created it, so the
    join (AND of normal) is not normal and the caught message is dropped."""
    doc = _fork(["x"], "y")
    lab = S.propagate(S.Model(doc), "u", {"r", "j"})
    assert lab["e_o"].used and not lab["e_o"].normal and not lab["e_o__G"].used
    assert S.reference(doc, {"certificates": [CERT_G]})["oom@o"]["verdict"] == "not exercised"


LATE_SECOND = {
    "modes": ["omission", {"commission": ["oom"]}, "late", "value"],
    "components": [
        {"id": "A", "kind": "deterministic", "in": ["i", "back"], "out": ["o", "loop"],
         "flow": {"i": ["loop"], "back": []},
         "rows": [{"id": "a1", "when": {"i": "any"}, "then": {"o": {"late": "const 3"}}, "activation": "always"},
                  {"id": "a2", "when": {"back": {"value": 1}}, "then": {"o": {"oom": "const 8"}},
                   "activation": "always"}]},
        {"id": "B", "kind": "deterministic", "in": ["i"], "out": ["o"],
         "rows": [{"id": "b1", "when": {"i": "any"}, "then": {"o": {"value": "const 4"}}, "activation": "always"}]},
    ],
    "guards": [{"id": "G", "edge": "e_out", "targets": [{"mode": "oom", "threshold": 1, "decidable": True}]}],
    "edges": [{"id": "e_in", "from": "sys.in", "to": "A.i"},
              {"id": "e_loop", "from": "A.loop", "to": "B.i"},
              {"id": "e_back", "from": "B.o", "to": "A.back"},
              {"id": "e_out", "from": "A.o", "to": "sys.out"}],
    "use_cases": [{"id": "u", "entries": [{"port": "in", "token": {}}]}],
    "observation_points": [{"id": "o", "edge": "e_out", "tolerate": {"late": 1, "oom": 1}}],
}


def test_reference_noncycle_guard_drops_after_settling():
    """(c) A's output exists only through failure rows: late 3 in the first pass, oom 8 once the
    loop through B has come round. G lies on no cycle and judges the settled input once, so it
    catches oom and drops the whole message, late 3 included; a guard that judged pass by pass
    would already have forwarded the late-3 message."""
    M = S.Model(LATE_SECOND)
    assert not M.on_cycle["G"] and M.on_cycle["A"] and M.on_cycle["B"]
    lab = S.propagate(M, "u", {"a1", "a2", "b1"})
    tok = lab["e_out"].tok
    assert lab["e_out"].used and not lab["e_out"].normal
    assert (S.effective(M, tok, "late"), S.effective(M, tok, "oom")) == (3, 8)
    assert not lab["e_out__G"].used
    ref = S.reference(LATE_SECOND, {"certificates": [CERT_G]})
    assert ref["late@o"]["verdict"] == ref["oom@o"]["verdict"] == "not exercised"
    leak = {"id": "c_g", "component": "G", "targets": {"oom": "always"}}
    ref = S.reference(LATE_SECOND, {"certificates": [leak]})
    assert ref["late@o"]["verdict"] == ref["oom@o"]["verdict"] == "exposed"


def test_reference_llm_rule():
    doc = _doc(RUNNING)
    bad = copy.deepcopy(doc)
    bad["components"][0]["rows"][0]["activation"] = "never"
    with pytest.raises(S.IllFormed):
        S.Model(bad)
    cert = {"id": "c", "component": "planner", "rows": {"p1": "never"}}
    assert S.classify_certificate(S.Model(doc), cert)[0] == "rejected"


def test_reference_llm_defaults_replaced_or_beside():
    doc = copy.deepcopy(_doc(RUNNING))
    planner = doc["components"][0]
    planner.pop("drop_defaults")
    planner["rows"] += [{"id": "p_late", "when": {"*": "any"}, "then": {"order": {"late": "const 3"}}},
                        {"id": "p_val", "when": {"request": {"late": 1}}, "then": {"order": {"value": "const 3"}}}]
    rows = S.Model(doc).rows
    assert "default.planner.order.late" not in rows         # replaced: same shape, exactly late
    assert "default.planner.order.value" in rows            # beside: the row reads a failure
    assert "default.planner.order.commission" in rows       # beside: p1 emits only the sub-kind oom
    assert rows["default.planner.order.omission"].domain == ("S", "A")


def test_reference_scope_rule():
    """A certificate scoped to a use case that does not cover every use case reaching the point
    does not apply there."""
    doc = copy.deepcopy(_doc(RUNNING))
    doc["use_cases"].append({"id": "refund", "entries": [{"port": "request", "token": {}}]})
    scoped = {**CERT_M1, "scope": ["pay"]}
    assert S.reference(doc, {"certificates": [scoped]})["oom@o"]["statuses"] == ["N", "S", "A"]
    both = {**CERT_M1, "scope": ["pay", "refund"]}
    assert S.reference(doc, {"certificates": [both]})["oom@o"]["verdict"] == "guarantee"
