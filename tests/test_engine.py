"""Engine tests: the paper's running example (Table 3.1), cones, and a cross-check of the ASP
verdicts against a direct enumeration of candidates in Python."""
import os

import pytest

from epa.engine.coordinator import Engine
from epa.model import cone as C
from epa.model.load import ModelError, load_model

HERE = os.path.dirname(__file__)
ROOT = os.path.dirname(HERE)
CERT = {"id": "c_m1", "component": "M", "targets": {"oom": "never"}, "version": "mandate-v2"}
W1 = {"id": "W1", "use_case": "pay", "at": {"o": {"modes": {"oom": [1, 10]}}}, "versions": {}}
W2 = {"id": "W2", "use_case": "pay", "at": {"o": {"modes": {"oom": [0, 0]}}}, "versions": {}}


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    return str(tmp_path_factory.mktemp("work"))


@pytest.fixture(scope="module")
def running():
    return load_model(os.path.join(HERE, "models", "running_example.yaml"))


def cell(rep, cid):
    return next(c for c in rep["cells"] if c["cell"] == cid)


@pytest.mark.parametrize("evidence, verdict, statuses, remaining, suspended", [
    ({}, "unchecked", ["N", "S", "A"], 6, []),
    ({"certificates": [CERT]}, "guarantee", ["N"], 2, []),
    ({"witnesses": [W1]}, "unchecked", ["S", "A"], 4, []),
    ({"witnesses": [W2]}, "unchecked", ["N", "S"], 5, []),
    ({"witnesses": [W1, W2]}, "hope", ["S"], 3, []),
    ({"certificates": [CERT], "witnesses": [W1]}, "unchecked", ["S", "A"], 4, ["c_m1"]),
])
def test_table_3_1(running, work, evidence, verdict, statuses, remaining, suspended):
    rep = Engine(running, work).analyse(evidence, rank=False)
    c = cell(rep, "oom@o")
    assert c["verdict"] == verdict
    assert c["statuses"] == statuses
    assert c["candidates"]["remaining"] == remaining
    assert c["suspended"] == suspended


def test_certificate_prunes_before_running(running, tmp_path):
    eng = Engine(running, str(tmp_path))
    rep = eng.analyse({"certificates": [CERT]}, rank=False)
    first = rep["tlc_calls"][0]
    assert first["vectors"] == 2          # leak row pinned to never: half of the switch vectors
    assert cell(rep, "oom@o")["reasons"]["certificates"] == ["c_m1"]


def test_root_cause_and_ranking(running, work):
    rep = Engine(running, work).analyse({})
    assert cell(rep, "oom@o")["root_causes"] == [["leak.M.oom", "p1"]]
    assert rep["ranking"][0]["action"] == ["M"] and rep["ranking"][0]["key"] == 9


def test_llm_rule_rejects_certificate(running, work):
    bad = {"id": "c_bad", "component": "planner", "rows": {"p1": "never"}}
    rep = Engine(running, work).analyse({"certificates": [bad]}, rank=False)
    reg = rep["register"]["certificates"][0]
    assert reg["state"] == "rejected" and "LLM rule" in reg["reason"]


def test_wallet_cones_are_tight():
    m = load_model(os.path.join(ROOT, "cases", "wallet", "model.yaml"))
    got = {c.id: C.cone_of_cell(m, c).rows for c in C.cells(m)}
    assert got["oom@o_statement"] == ["leak.gm.oom", "p_offmandate"]
    assert got["dup@o_statement"] == ["b_slow", "default.agent.request.dup", "leak.gd.dup", "p_dup"]
    assert got["auth@o_statement"] == []


def test_ill_formed_learned_guard_with_decidable_target():
    doc = {"components": [{"id": "a", "kind": "llm", "in": ["i"], "out": ["o"]}],
           "guards": [{"id": "j", "edge": "e2", "learned": True,
                       "targets": [{"mode": "commission", "threshold": 1, "decidable": True}]}],
           "edges": [{"id": "e1", "from": "sys.in", "to": "a.i"}, {"id": "e2", "from": "a.o", "to": "sys.out"}],
           "use_cases": [{"id": "u", "entry": "in"}]}
    with pytest.raises(ModelError) as e:
        load_model(doc)
    assert "learned guard" in str(e.value)


@pytest.mark.parametrize("case", ["wallet", "smart-home", "mcp-coding-agent"])
def test_asp_agrees_with_enumeration(case, work):
    """For every cell with a small cone, the statuses clingo derives equal those obtained by
    enumerating candidates and their admitted runs in Python."""
    m = load_model(os.path.join(ROOT, "cases", case, "model.yaml"))
    eng = Engine(m, work)
    rep = eng.analyse({}, rank=False)
    for c in rep["cells"]:
        if c["candidates"]["space"] > 729:
            continue
        tab = eng.possibilities(c["cell"], {})
        seen = {x["status"] for x in tab["candidates"]}
        seen = {"N" if s == "x" else s for s in seen} if seen != {"x"} else set()
        assert sorted(seen, key="NSA".index) == c["statuses"], c["cell"]
