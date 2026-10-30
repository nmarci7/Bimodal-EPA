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
                       "auth@o_statement": ("guarantee", 1), "conf@o_presentation": ("unchecked", 3),
                       "taint@o_statement": ("exposed", 1)},
    ("wallet", "S1"): {"oom@o_statement": ("guarantee", 2), "dup@o_statement": ("guarantee", 6),
                       "conf@o_presentation": ("guarantee", 1)},
    ("wallet", "S2"): {"oom@o_statement": ("hope", 3), "dup@o_statement": ("guarantee", 6)},
    ("wallet", "S3"): {"oom@o_statement": ("hope", 3)},
    ("wallet", "S4"): {"oom@o_statement": ("guarantee", 2), "dup@o_statement": ("guarantee", 6)},
    ("smart-home", "S0"): {"conf@o_egress": ("exposed", 1), "unsafe@o_actuator": ("unchecked", 72),
                           "auth@o_actuator": ("unchecked", 3), "value@o_report": ("unchecked", 4),
                           "heat_open@o_safety": ("hope", 1), "door_armed@o_safety": ("hope", 1)},
    # c_hub_failover and c_gs2 are scoped to voice and calendar, but the offline use case also reaches the
    # planner through the hub's context and can fire their rows: by the scope rule they do not count there
    ("smart-home", "S1"): {"unsafe@o_actuator": ("guarantee", 24), "commission@o_actuator": ("guarantee", 48),
                           "omission@o_actuator": ("unchecked", 12), "value@o_actuator": ("unchecked", 4)},
    ("smart-home", "S2"): {"value@o_report": ("hope", 1), "conf@o_skill": ("hope", 1)},
    ("smart-home", "S3"): {"conf@o_egress": ("guarantee", 1), "value@o_report": ("guarantee", 1),
                           "conf@o_skill": ("unchecked", 3)},
    # a public issue has no one's authority; a maintainer's command has: per use case always and never
    ("mcp-coding-agent", "S0"): {"auth@o_process": ("hope", 18), "auth@o_mcp": ("hope", 1),
                                 "conf@o_pr": ("unchecked", 3)},
    ("mcp-coding-agent", "S1"): {"taint@o_process": ("guarantee", 2), "malicious@o_release": ("guarantee", 6),
                                 "auth@o_process": ("hope", 2)},
    ("mcp-coding-agent", "S2"): {"conf@o_pr": ("hope", 2)},
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


def test_the_hub_races_are_sometimes_and_the_advice_names_them(work):
    doc, ev, _ = stage_inputs(os.path.join(ROOT, "cases", "smart-home"), "S0")
    rep = Engine(load_model(doc), work).analyse(ev, rank=False)
    cells = {c["cell"]: c for c in rep["cells"]}
    heat, door = cells["heat_open@o_safety"], cells["door_armed@o_safety"]
    assert heat["statuses"] == ["S"] and heat["per_uc"]["heating"] == ["S"] and heat["per_uc"]["voice"] == ["N"]
    assert heat["order_dependent"] == {"component": "hub", "ports": ["plan", "window"], "use_cases": ["heating"]}
    assert door["order_dependent"] == {"component": "hub", "ports": ["alarm", "plan"], "use_cases": ["door"]}
    assert "order in which hub processes plan and window: synchronise them" in heat["advice"]


def test_a_race_of_the_hub_is_told_step_by_step(work):
    from epa.report import explain
    doc, ev, _ = stage_inputs(os.path.join(ROOT, "cases", "smart-home"), "S0")
    m = load_model(doc)
    eng = Engine(m, work)
    rep = eng.analyse(ev, rank=False)
    ex = next(c for c in rep["cells"] if c["cell"] == "heat_open@o_safety")["example_run"]
    tr = eng.trace_of("heat_open@o_safety", ex["uc"], frozenset(ex["fire"]), ex["variant"])
    story = explain.trace_story(m, tr, ["heat_open"])
    assert story[0]["step"] == "start"
    assert any(s["step"].endswith(": planner") for s in story)
    assert any(s["step"].endswith(": hub") and any("heat_open 1" in e for e in s["edges"]) for s in story)
    for s in story[1:]:                     # one firing per step: only the component named sends in it
        comp = s["step"].split(": ")[1]
        assert all(e.startswith(f"{comp} → ") for e in s["edges"]), s


def test_the_coding_agent_shows_what_authentication_buys(work):
    doc, ev, _ = stage_inputs(os.path.join(ROOT, "cases", "mcp-coding-agent"), "S0")
    rep = Engine(load_model(doc), work).analyse(ev, rank=False)
    cells = {c["cell"]: c for c in rep["cells"]}
    assert cells["taint@o_process"]["per_uc"]["command"] == ["N"]
    assert "A" in cells["taint@o_process"]["per_uc"]["issue"]
    assert cells["auth@o_process"]["per_uc"] == {"issue": ["A"], "command": ["N"], "release": ["x"]}


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
