"""The FIFO firing semantics, each rule as a small model: consumption, heads taken together, no memory,
the stopping rule, internal faults, the normal bit, order dependence in the advice, the reduction of
firing orders, taint levels, consistent / complete / correct, and a run told step by step."""
import copy
import os

import pytest

from epa.alethic import runs as R
from epa.engine.coordinator import Engine
from epa.intake.cert_import import classify
from epa.model import cone as C
from epa.model.load import ModelError, load_model

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    return str(tmp_path_factory.mktemp("work"))


def uc(*ports):
    return [{"id": "u", "entries": [{"port": p, "token": {}} for p in ports]}]


def analyse(doc, work, evidence=None):
    m = load_model(doc)
    eng = Engine(m, work)
    rep = eng.analyse(evidence or {}, rank=False)
    return {c["cell"]: c for c in rep["cells"]}, eng, m


def outcomes(eng, m, cell_id):
    """The distinct values of (used, reaches) over the runs of the cell's cone."""
    cone = next(k for k in C.cones(m, C.cells(m)) if cell_id in k.cell_rows)
    cell = C.Cell.parse(cell_id)
    return {(R.used(m, cell, r), R.reaches(m, cell, r)) for r in eng.cache.runs(cone.key(m)).values()}


# A command goes through src, which marks it, to a; a sensor reading enters a directly. The reading holds
# the command back only if both stand at a's heads in one firing.
RACE = {
    "modes": ["omission", {"commission": ["bad"]}],
    "components": [
        {"id": "src", "kind": "deterministic", "in": ["i"], "out": ["o"],
         "rows": [{"id": "r_bad", "when": {"i": "any"}, "then": {"o": {"bad": "present"}}, "frequency": "always"}]},
        {"id": "a", "kind": "deterministic", "in": ["cmd", "sensor"], "out": ["out"],
         "flow": {"cmd": ["out"], "sensor": []},
         "rows": [{"id": "hold", "frequency": "always", "when": {"cmd": {"bad": "present"}, "sensor": "any"}}]}],
    "edges": [{"id": "e_i", "from": "sys.cmd", "to": "src.i"}, {"id": "e_cmd", "from": "src.o", "to": "a.cmd"},
              {"id": "e_s", "from": "sys.sensor", "to": "a.sensor"}, {"id": "e_out", "from": "a.out", "to": "sys.out"}],
    "use_cases": uc("cmd", "sensor"),
    "observation_points": [{"id": "o", "edge": "e_out", "tolerate": {"bad": 1}}],
}


def test_a_race_is_sometimes_and_the_advice_says_synchronise(work):
    cells, eng, m = analyse(RACE, work)
    c = cells["bad@o"]
    assert (c["verdict"], c["statuses"]) == ("hope", ["S"])
    assert c["order_dependent"] == {"component": "a", "ports": ["cmd", "sensor"], "use_cases": ["u"]}
    assert c["advice"] == ("sometimes, because the outcome depends on the order in which a processes cmd and "
                           "sensor: synchronise them")
    assert outcomes(eng, m, "bad@o") == {(True, True), (True, False)}


def test_a_verdict_without_a_race_keeps_its_advice(work):
    d = copy.deepcopy(RACE)
    d["components"][1]["rows"] = []
    cells, _, _ = analyse(d, work)
    assert cells["bad@o"]["verdict"] == "exposed" and cells["bad@o"]["order_dependent"] is None
    assert cells["bad@o"]["advice"].startswith("redesign")


def test_a_row_naming_two_ports_needs_both_heads_in_one_firing(work):
    """With the reading first in the queue of a port that fires alone, the combination cannot happen: a
    reading already consumed holds nothing back, because a component has no memory."""
    d = copy.deepcopy(RACE)
    d["components"].insert(1, {"id": "b", "kind": "deterministic", "in": ["i"], "out": ["o"]})
    d["edges"][1] = {"id": "e_cmd", "from": "src.o", "to": "b.i"}
    d["edges"].append({"id": "e_b", "from": "b.o", "to": "a.cmd"})
    cells, eng, m = analyse(d, work)
    assert outcomes(eng, m, "bad@o") == {(True, True), (True, False)}    # still a race, one hop longer


def test_heads_of_all_ports_are_taken_together_or_apart():
    """E then F, or E and F together: the combination row applies only in the second."""
    d = {"modes": ["omission", {"commission": ["e", "f", "both"]}],
         "components": [
             {"id": "x", "kind": "deterministic", "in": ["i"], "out": ["o"]},
             {"id": "a", "kind": "deterministic", "in": ["p", "q"], "out": ["out"], "flow": {"p": [], "q": []},
              "rows": [{"id": "r_e", "when": {"p": "any"}, "then": {"out": {"e": "present"}}, "frequency": "always"},
                       {"id": "r_f", "when": {"q": "any"}, "then": {"out": {"f": "present"}}, "frequency": "always"},
                       {"id": "r_ef", "when": {"p": "any", "q": "any"}, "then": {"out": {"both": "present"}},
                        "frequency": "always"}]}],
         "edges": [{"id": "e1", "from": "sys.a", "to": "x.i"}, {"id": "e2", "from": "x.o", "to": "a.p"},
                   {"id": "e3", "from": "sys.b", "to": "a.q"}, {"id": "e4", "from": "a.out", "to": "sys.out"}],
         "use_cases": uc("a", "b"),
         "observation_points": [{"id": "o", "edge": "e4", "tolerate": {"e": 1, "f": 1, "both": 1}}]}
    import tempfile
    cells, eng, m = analyse(d, tempfile.mkdtemp())
    assert cells["both@o"]["statuses"] == ["S"] and cells["both@o"]["order_dependent"]["component"] == "a"
    assert cells["e@o"]["verdict"] == "exposed" and cells["f@o"]["verdict"] == "exposed"


def test_a_cycle_of_forwarders_ends_by_the_stopping_rule(work):
    d = {"modes": ["omission", "late"],
         "components": [
             {"id": "a", "kind": "deterministic", "in": ["i", "back"], "out": ["o"]},
             {"id": "b", "kind": "deterministic", "in": ["i"], "out": ["o", "out"],
              "rows": [{"id": "r_late", "when": {"i": "any"}, "then": {"o": {"late": "present"}}}]}],
         "edges": [{"id": "e_in", "from": "sys.in", "to": "a.i"}, {"id": "e_ab", "from": "a.o", "to": "b.i"},
                   {"id": "e_ba", "from": "b.o", "to": "a.back"}, {"id": "e_out", "from": "b.out", "to": "sys.out"}],
         "use_cases": uc("in"),
         "observation_points": [{"id": "o", "edge": "e_out", "tolerate": {"late": 1}}]}
    cells, eng, m = analyse(d, work)
    assert cells["late@o"]["verdict"] == "unchecked"     # with the row on, the late copy comes round once more
    assert cells["late@o"]["statuses"] == ["N", "S", "A"] or cells["late@o"]["statuses"] == ["N", "A"]
    assert eng.tlc_calls[0]["depth"] < 15


def test_an_internal_fault_applies_once_with_nothing_arriving(work):
    d = {"modes": ["omission", "commission"],
         "components": [{"id": "x", "kind": "deterministic", "in": ["req"], "out": ["out", "alarm"],
                         "flow": {"req": ["out"]},
                         "rows": [{"id": "r_int", "when": {}, "then": {"alarm": {"commission": "present"}}}]}],
         "edges": [{"id": "e_in", "from": "sys.req", "to": "x.req"}, {"id": "e_out", "from": "x.out", "to": "sys.out"},
                   {"id": "e_alarm", "from": "x.alarm", "to": "sys.alarm"}],
         "use_cases": uc("req"),
         "observation_points": [{"id": "o", "edge": "e_alarm", "tolerate": {"commission": 1}}]}
    cells, eng, m = analyse(d, work)
    assert cells["commission@o"]["statuses"] == ["N", "A"]
    runs = list(eng.cache.runs(next(iter(C.cones(m, C.cells(m)))).key(m)).values())
    assert {tuple(sorted(r.fired)) for r in runs} == {(), ("r_int",)}


def test_a_token_value_an_edge_carried_is_not_delivered_again(work):
    """Two entries of one value on two edges into a port: the port's queue holds both; the output edge
    of the component carries the value once."""
    d = {"modes": ["omission", "late"],
         "components": [{"id": "x", "kind": "deterministic", "in": ["i"], "out": ["o"]},
                        {"id": "y", "kind": "deterministic", "in": ["i"], "out": ["o"],
                         "rows": [{"id": "r1", "when": {"i": "any"}, "then": {"o": {"late": "present"}},
                                   "frequency": "always"}]}],
         "edges": [{"id": "e1", "from": "sys.a", "to": "x.i"}, {"id": "e2", "from": "sys.b", "to": "x.i"},
                   {"id": "e3", "from": "x.o", "to": "y.i"}, {"id": "e4", "from": "y.o", "to": "sys.out"}],
         "use_cases": uc("a", "b"),
         "observation_points": [{"id": "o", "edge": "e4", "tolerate": {"late": 1}}]}
    cells, eng, m = analyse(d, work)
    assert cells["late@o"]["verdict"] == "exposed"
    assert eng.tlc_calls[0]["distinct"] <= 4       # x twice, y once: at most four states in a line


def test_a_caught_message_that_only_a_failure_row_made_is_dropped():
    """x has no flow: its row makes the message. The certified guard catches it and drops it, so the
    point stays unused; on a normal message the guard removes the mode and the message goes on."""
    d = {"modes": ["omission", {"commission": ["bad"]}],
         "components": [{"id": "x", "kind": "deterministic", "in": ["i"], "out": ["o"], "flow": {"i": []},
                         "rows": [{"id": "r", "when": {"i": "any"}, "then": {"o": {"bad": "present"}}, "frequency": "always"}]}],
         "guards": [{"id": "g", "edge": "e_o", "targets": [{"mode": "bad", "decidable": True}]}],
         "edges": [{"id": "e_i", "from": "sys.i", "to": "x.i"}, {"id": "e_o", "from": "x.o", "to": "sys.o"}],
         "use_cases": uc("i"),
         "observation_points": [{"id": "o", "edge": "e_o", "tolerate": {"bad": 1}}]}
    import tempfile
    cert = {"id": "c", "component": "g", "targets": {"bad": "never"}}
    cells, _, _ = analyse(d, tempfile.mkdtemp(), {"certificates": [cert]})
    assert cells["bad@o"]["verdict"] == "not exercised"
    d2 = copy.deepcopy(d)
    d2["components"][0]["flow"] = {"i": ["o"]}
    cells, _, _ = analyse(d2, tempfile.mkdtemp(), {"certificates": [cert]})
    assert cells["bad@o"]["verdict"] == "guarantee"


@pytest.mark.parametrize("cell", ["heat_open@o_safety", "door_armed@o_safety", "unsafe@o_actuator", "late@o_report"])
def test_the_reduction_keeps_every_outcome(cell, tmp_path, monkeypatch):
    """Firing every ready component in every state and the reduced exploration end in the same outcomes.
    The hub is the case with real races."""
    m = load_model(os.path.join(ROOT, "cases", "smart-home", "model.yaml"))
    cone = next(k for k in C.cones(m, C.cells(m)) if cell in k.cell_rows)
    pins = {r: "A" for r in cone.rows[3:]}          # the full product is what the reduction is for; a slice is enough here

    def outcomes_with(flag):
        from epa.alethic import tlc_runner
        from epa.translate import to_tla
        monkeypatch.setenv("EPA_POR", flag)
        heads = {}
        dump, stats = tlc_runner.run(*to_tla.module_for(m, cone, want=[pins], schedule="fifo"), str(tmp_path / flag))
        runs = R.runs_from_dump(dump, cone.edges, heads)
        return {(r.uc, r.fire, r.fired, repr(sorted(r.labels.items()))) for r in runs.values()}, heads, stats["distinct"]
    full, full_heads, n_full = outcomes_with("0")
    reduced, reduced_heads, n_reduced = outcomes_with("1")
    assert full == reduced
    assert full_heads == reduced_heads
    assert n_reduced <= n_full


def test_the_reduction_keeps_an_internal_fault_that_races_with_a_message(tmp_path, monkeypatch):
    """x may fault before, with, or after the message: the fault's firing is ready from the start."""
    from epa.alethic import tlc_runner
    from epa.translate import to_tla
    d = {"modes": ["omission", {"commission": ["bad", "both"]}],
         "components": [
             {"id": "s", "kind": "deterministic", "in": ["i"], "out": ["o"]},
             {"id": "x", "kind": "deterministic", "in": ["i"], "out": ["o"],
              "rows": [{"id": "r_int", "when": {}, "then": {"o": {"bad": "present"}}}]},
             {"id": "y", "kind": "deterministic", "in": ["p", "q"], "out": ["o"],
              "rows": [{"id": "r_y", "when": {"p": {"bad": "present"}, "q": "any"}, "then": {"o": {"both": "present"}}}]}],
         "edges": [{"id": "e1", "from": "sys.i", "to": "s.i"}, {"id": "e2", "from": "s.o", "to": "x.i"},
                   {"id": "e3", "from": "x.o", "to": "y.p"}, {"id": "e4", "from": "sys.j", "to": "y.q"},
                   {"id": "e5", "from": "y.o", "to": "sys.o"}],
         "use_cases": uc("i", "j"),
         "observation_points": [{"id": "o", "edge": "e5", "tolerate": {"bad": 1, "both": 1}}]}
    m = load_model(d)
    m.schedule = "fifo"
    cone = C.cones(m, C.cells(m))[0]

    def outcomes_with(flag):
        monkeypatch.setenv("EPA_POR", flag)
        dump, _ = tlc_runner.run(*to_tla.module_for(m, cone, schedule="fifo"), str(tmp_path / flag))
        runs = R.runs_from_dump(dump, cone.edges)
        return {(r.fire, r.fired, repr(sorted(r.labels.items()))) for r in runs.values()}
    assert outcomes_with("0") == outcomes_with("1")


def test_taint_is_a_level_a_guard_lowers_it_and_a_point_tolerates_it():
    d = {"modes": ["omission"],
         "components": [{"id": "p", "kind": "llm", "in": ["i"], "out": ["o"],
                         "drop_defaults": [{"port": "o", "mode": "omission", "reason": "test"}]}],
         "guards": [{"id": "g", "edge": "e_o", "closed_output": True, "targets": [{"taint": "open", "decidable": True}]}],
         "edges": [{"id": "e_i", "from": "sys.i", "to": "p.i"}, {"id": "e_o", "from": "p.o", "to": "sys.o"}],
         "use_cases": [{"id": "public", "entries": [{"port": "i", "token": {"taint": "open"}}]},
                       {"id": "owner", "entries": [{"port": "i", "token": {"taint": "identified"}}]}],
         "observation_points": [{"id": "o", "edge": "e_o", "tolerate_taint": "identified"}]}
    import tempfile
    cells, _, _ = analyse(d, tempfile.mkdtemp())
    c = cells["taint@o"]
    assert c["per_uc"]["owner"] == ["n"] or c["per_uc"]["owner"] == ["N"]
    assert c["statuses"] == ["N", "S"]                      # the guard leaks or lowers open to identified
    cert = {"id": "c", "component": "g", "targets": {"taint": "never"}}
    cells, _, _ = analyse(d, tempfile.mkdtemp(), {"certificates": [cert]})
    assert cells["taint@o"]["verdict"] == "guarantee"


def test_the_old_spellings_still_load():
    d = {"modes": ["omission"],
         "components": [{"id": "x", "kind": "tool", "trusted": False, "in": ["i"], "out": ["o"],
                         "rows": [{"id": "r", "when": {"i": "any"}, "then": {"o": {"omission": "const 3"}}, "activation": "always"}]},
                        {"id": "y", "kind": "llm", "trusted": True, "in": ["i"], "out": ["o"]}],
         "edges": [{"id": "e_i", "from": "sys.i", "to": "x.i"}, {"id": "e_o", "from": "x.o", "to": "y.i"},
                   {"id": "e_y", "from": "y.o", "to": "sys.o"}],
         "use_cases": [{"id": "u", "entries": [{"port": "i", "token": {"taint": True}}]}],
         "observation_points": [{"id": "o", "edge": "e_y", "taint": "reject"}]}
    m = load_model(d)
    assert m.components["x"].taint == 1 and m.components["y"].taint == 0
    assert m.rows["r"].fixed == "A" and m.use_cases[0].entries[0][1]["t"] == 3
    assert m.obs["o"].tolerate_taint == 0
    d["components"][0]["rows"][0]["frequency"] = "never"
    with pytest.raises(ModelError) as e:
        load_model(d)
    assert "disagree" in str(e.value)


def test_a_default_row_emits_the_mode_present():
    m = load_model({"modes": ["omission"], "components": [{"id": "p", "kind": "llm", "in": ["i"], "out": ["o"]}],
                    "edges": [{"id": "e", "from": "sys.i", "to": "p.i"}, {"id": "f", "from": "p.o", "to": "sys.o"}],
                    "use_cases": uc("i")})
    assert m.rows["default.p.o.omission"].then == {"o": {"omission": ("const", 1)}}


# ---- consistent, complete, correct: the payment example, with a directory T that only forwards

PAY = {
    "modes": ["omission", {"commission": ["oom", "stale"]}],
    "severity": {"oom": 9},
    "components": [
        {"id": "P", "kind": "llm", "version": "v1", "in": ["i"], "out": ["o"],
         "rows": [{"id": "p1", "when": {"i": "any"}, "then": {"o": {"oom": "present"}}}],
         "drop_defaults": [{"port": "o", "mode": "omission", "reason": "test"},
                           {"port": "o", "mode": "commission", "reason": "test"}]},
        {"id": "T", "kind": "deterministic", "version": "t1", "in": ["i"], "out": ["o"]},
        {"id": "S", "kind": "deterministic", "version": "s1", "in": ["i"], "out": ["o"],
         "rows": [{"id": "s_stale", "when": {"i": "any"}, "then": {"o": {"oom": "present"}}}]}],
    "guards": [{"id": "M", "edge": "e_ms", "version": "m1", "targets": [{"mode": "oom", "decidable": True}]}],
    "edges": [{"id": "e_i", "from": "sys.i", "to": "P.i"}, {"id": "e_pt", "from": "P.o", "to": "T.i"},
              {"id": "e_ms", "from": "T.o", "to": "S.i"}, {"id": "e_out", "from": "S.o", "to": "sys.out"}],
    "use_cases": uc("i"),
    "observation_points": [{"id": "o", "edge": "e_out", "tolerate": {"oom": 1}}],
}


def test_only_components_with_a_row_in_the_cone_count(work):
    cells, _, _ = analyse(PAY, work)
    f = cells["oom@o"]["fidelity"]
    assert f["components"] == ["M", "P", "S"]               # T only forwards through its flow
    assert f["consistent"] and not f["correct"]
    assert f["unconfirmed"] == ["M", "S"]                   # an LLM needs no confirmed table
    assert f["uncovered"] == [{"component": "S", "heads": {"i": ["oom"]}}]
    assert not f["complete"]


def test_a_row_that_names_the_failure_makes_it_complete(work):
    d = copy.deepcopy(PAY)
    d["components"][2]["rows"].append({"id": "s_pass", "when": {"i": {"oom": "present"}}, "then": {"o": {"oom": "present"}}})
    cells, _, _ = analyse(d, work)
    assert cells["oom@o"]["fidelity"]["complete"]


def table(comp, version, **over):
    return {"id": f"c_{comp}", "component": comp, "table": "confirmed", "version": version, "issuer": "test team",
            "date": "2026-10-01", "method": "fault injection", **over}


def test_a_confirmed_table_is_a_certificate(work):
    ev = {"certificates": [table("M", "m1"), table("S", "s1")]}
    cells, _, m = analyse(PAY, work, ev)
    assert cells["oom@o"]["fidelity"]["correct"]
    assert classify(table("S", "s0"), m)[0] == "stale"
    assert classify(table("P", "v1"), m)[0] == "rejected"
    assert classify({**table("S", "s1"), "table": "maybe"}, m)[0] == "rejected"
    cells, _, _ = analyse(PAY, work, {"certificates": [table("M", "m1"), table("S", "s0")]})
    assert cells["oom@o"]["fidelity"]["unconfirmed"] == ["S"]


def test_a_witness_that_matches_no_run_makes_the_model_neither_consistent_nor_correct(work):
    w = {"id": "w", "use_case": "u", "at": {"o": {"used": False}}}
    cells, _, _ = analyse(PAY, work, {"witnesses": [w], "certificates": [table("M", "m1"), table("S", "s1")]})
    f = cells["oom@o"]["fidelity"]
    assert not f["consistent"] and not f["correct"]


def test_a_run_is_told_step_by_step(work):
    cells, eng, m = analyse(RACE, work)
    ex = cells["bad@o"]["example_run"]
    tr = eng.trace_of("bad@o", ex["uc"], frozenset(ex["fire"]), ex["variant"])
    from epa.report import explain
    story = explain.trace_story(m, tr, ["bad"])
    assert story[0]["step"] == "start"
    assert any(s["step"].endswith(": a") and any("bad 1" in e for e in s["edges"]) for s in story)


def test_the_rounds_translator_stays_selectable(tmp_path):
    m = load_model(os.path.join(ROOT, "tests", "models", "running_example.yaml"))
    rep = Engine(m, str(tmp_path), schedule="rounds").analyse({}, rank=False)
    assert rep["engine"]["schedule"] == "rounds"
    assert next(c for c in rep["cells"] if c["cell"] == "oom@o")["verdict"] == "unchecked"
