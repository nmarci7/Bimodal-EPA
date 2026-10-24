"""The three demo cases, stage by stage: the verdicts the paper and the case READMEs report.
If a model or a mock log changes, these expectations say what moved."""
import os

import pytest

from epa.engine.coordinator import Engine
from epa.engine.scenario import stage_inputs
from epa.model.load import load_model

ROOT = os.path.dirname(os.path.dirname(__file__))

EXPECTED = {
    ("wallet", "S0"): {"oom@o_statement": ("unchecked", 6), "dup@o_statement": ("unchecked", 18),
                       "auth@o_statement": ("guarantee", 1), "conf@o_presentation": ("unchecked", 3)},
    ("wallet", "S1"): {"oom@o_statement": ("guarantee", 2), "dup@o_statement": ("guarantee", 6),
                       "conf@o_presentation": ("guarantee", 1)},
    ("wallet", "S2"): {"oom@o_statement": ("hope", 3), "dup@o_statement": ("guarantee", 6)},
    ("wallet", "S3"): {"oom@o_statement": ("hope", 3)},
    ("wallet", "S4"): {"oom@o_statement": ("guarantee", 2), "dup@o_statement": ("guarantee", 6)},
    ("smart-home", "S0"): {"conf@o_egress": ("exposed", 1), "unsafe@o_actuator": ("unchecked", 72),
                           "auth@o_actuator": ("unchecked", 3), "value@o_report": ("unchecked", 4)},
    ("smart-home", "S1"): {"unsafe@o_actuator": ("guarantee", 24), "commission@o_actuator": ("guarantee", 48),
                           "omission@o_actuator": ("guarantee", 4), "value@o_actuator": ("unchecked", 4)},
    ("smart-home", "S2"): {"value@o_report": ("hope", 1), "conf@o_skill": ("hope", 1)},
    ("smart-home", "S3"): {"conf@o_egress": ("guarantee", 1), "value@o_report": ("guarantee", 1),
                           "conf@o_skill": ("guarantee", 1)},
    ("mcp-coding-agent", "S0"): {"auth@o_process": ("exposed", 1), "auth@o_mcp": ("exposed", 1),
                                 "conf@o_pr": ("unchecked", 3)},
    ("mcp-coding-agent", "S1"): {"taint@o_process": ("guarantee", 1), "malicious@o_release": ("guarantee", 6),
                                 "auth@o_process": ("exposed", 1)},
    ("mcp-coding-agent", "S2"): {"conf@o_pr": ("hope", 1)},
    ("mcp-coding-agent", "S3"): {"conf@o_pr": ("guarantee", 1)},
}


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    return str(tmp_path_factory.mktemp("work"))


@pytest.mark.parametrize("case, stage", sorted(EXPECTED))
def test_stage(case, stage, work):
    doc, ev, _ = stage_inputs(os.path.join(ROOT, "cases", case), stage)
    rep = Engine(load_model(doc), work).analyse(ev, rank=False)
    got = {c["cell"]: (c["verdict"], c["candidates"]["remaining"]) for c in rep["cells"]}
    for cell, exp in EXPECTED[(case, stage)].items():
        assert got[cell] == exp, (cell, got[cell], exp)


def test_wallet_incident_suspends_the_mandate_certificate(work):
    doc, ev, _ = stage_inputs(os.path.join(ROOT, "cases", "wallet"), "S2")
    rep = Engine(load_model(doc), work).analyse(ev, rank=False)
    oom = next(c for c in rep["cells"] if c["cell"] == "oom@o_statement")
    assert oom["conflicts"] == [["c_gm"]] and oom["suspended"] == ["c_gm"]
    reg = {c["id"]: c["state"] for c in rep["register"]["certificates"]}
    assert reg["c_vendor_eval"] == "rejected"


def test_wallet_llm_swap_puts_certificates_on_reverify(work):
    doc, ev, _ = stage_inputs(os.path.join(ROOT, "cases", "wallet"), "S5")
    rep = Engine(load_model(doc), work).analyse(ev, rank=False)
    assert {r["certificate"] for r in rep["reverify"]} >= {"c_gd", "c_gm_v3"}


def test_smart_home_ranking_puts_the_interlock_first_and_the_judge_at_zero(work):
    doc, ev, _ = stage_inputs(os.path.join(ROOT, "cases", "smart-home"), "S0")
    rep = Engine(load_model(doc), work).analyse(ev)
    first = rep["ranking"][0]
    assert "gi" in first["action"] and first["key"] == 8
    judge = next(a for a in rep["ranking"] if a["action"] == ["gj"])
    assert judge["key"] == 0 and "learned" in judge["note"]


def test_conflict_is_found_on_a_cold_cache(tmp_path):
    """With only the runs the certificates allow in the cache, a witness the certificates rule out
    must still lead to a conflict set, not to 'the model lacks a path'."""
    doc, ev, _ = stage_inputs(os.path.join(ROOT, "cases", "wallet"), "S2")
    rep = Engine(load_model(doc), str(tmp_path)).analyse(ev, only_cells=["commission@o_statement"], rank=False)
    c = rep["cells"][0]
    assert not c["lacks_path"]
    assert c["verdict"] == "unchecked" and c["suspended"] == ["c_gm"]
