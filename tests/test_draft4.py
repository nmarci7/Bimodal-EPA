"""The formal core of draft 4, and the decisions taken after it, each as a small model:
the LLM rule on fixed rows, what may replace an LLM default, pass-through by default (A6) with declared
absorptions, internal-fault, forwarding and sink rows, a dropping guard that waits for its input to
settle, suspension across observation points, and the scope rule."""
import copy

import pytest

from epa.engine.coordinator import Engine
from epa.model.load import ModelError, load_model


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    return str(tmp_path_factory.mktemp("work"))


def verdicts(doc, work, evidence=None):
    rep = Engine(load_model(doc), work).analyse(evidence or {}, rank=False)
    return {c["cell"]: (c["verdict"], c["statuses"]) for c in rep["cells"]}, rep


def uc(*ports):
    return [{"id": "u", "entries": [{"port": p, "token": {}} for p in ports]}]


LLM = {
    "name": "llm", "modes": ["omission", "commission", "late", "value"],
    "components": [{"id": "p", "kind": "llm", "in": ["req"], "out": ["out"], "rows": []}],
    "edges": [{"id": "e_in", "from": "sys.req", "to": "p.req"}, {"id": "e_out", "from": "p.out", "to": "sys.bank"}],
    "use_cases": uc("req"),
    "observation_points": [{"id": "o", "edge": "e_out", "tolerate": {"commission": 1, "late": 1}}],
}


def llm_with(rows):
    d = copy.deepcopy(LLM)
    d["components"][0]["rows"] = rows
    return d


def test_llm_row_cannot_be_fixed_never():
    with pytest.raises(ModelError) as e:
        load_model(llm_with([{"id": "p1", "when": {"*": "any"}, "then": {"out": {"commission": "const 9"}},
                              "activation": "never"}]))
    assert "LLM rule" in str(e.value)


def test_a_narrower_row_goes_beside_the_default(work):
    v, rep = verdicts(llm_with([{"id": "p2", "when": {"req": {"late": 3}}, "then": {"out": {"late": "+2"}}}]), work)
    assert v["late@o"][0] == "unchecked"
    assert "default.p.out.late" in rep["model"]["rows"]


def test_an_any_message_row_replaces_the_default_and_its_calibration_is_recorded():
    m = load_model(llm_with([{"id": "p3", "when": {"*": "any"}, "then": {"out": {"late": "const 6"}}}]))
    assert "default.p.out.late" not in m.rows
    cal = [d for d in m.decisions if d["kind"] == "calibrate-default"]
    assert cal and cal[0]["row"] == "p3" and cal[0]["to"] == 6


EXECUTOR = {
    "name": "executor", "modes": ["omission", "commission", "late", "value"],
    "components": [
        {"id": "planner", "kind": "llm", "in": ["user"], "out": ["c"],
         "drop_defaults": [{"port": "c", "mode": m, "reason": "test"} for m in ("omission", "commission", "late")]},
        {"id": "tool", "kind": "tool", "in": ["call"], "out": ["res"]}],
    "edges": [{"id": "e_user", "from": "sys.user", "to": "planner.user"},
              {"id": "e_call", "from": "planner.c", "to": "tool.call"},
              {"id": "e_res", "from": "tool.res", "to": "sys.reply"}],
    "use_cases": uc("user"),
    "observation_points": [{"id": "o", "edge": "e_res", "tolerate": {"value": 1}}],
}


def test_pass_through_is_the_default(work):
    v, _ = verdicts(EXECUTOR, work)
    assert v["value@o"] == ("unchecked", ["S", "A"])      # the planner's wrong call reaches the reply


def test_an_absorption_needs_a_reason_and_is_reported(work):
    d = copy.deepcopy(EXECUTOR)
    d["components"][1]["absorbs"] = [{"port": "call", "modes": ["value"]}]
    with pytest.raises(ModelError):
        load_model(d)
    d["components"][1]["absorbs"][0]["reason"] = "the tool validates its arguments against a schema"
    v, rep = verdicts(d, work)
    assert v["value@o"][0] == "guarantee"
    assert rep["absorbed"][0]["reason"].startswith("the tool validates")


def test_the_pass_key_is_gone():
    d = copy.deepcopy(EXECUTOR)
    d["components"][1]["pass"] = "all"
    with pytest.raises(ModelError) as e:
        load_model(d)
    assert "absorbs" in str(e.value)


def test_a_sink_row_absorbs_when_it_fires(work):
    d = copy.deepcopy(EXECUTOR)
    d["components"][1]["rows"] = [{"id": "s_val", "when": {"call": {"value": 1}}}]
    v, _ = verdicts(d, work)
    assert v["value@o"] == ("unchecked", ["N", "S", "A"])


def test_an_internal_fault_needs_no_message(work):
    v, _ = verdicts({
        "modes": ["omission", "commission"],
        "components": [{"id": "x", "kind": "deterministic", "in": ["req"], "out": ["out", "alarm"],
                        "flow": {"req": ["out"]},
                        "rows": [{"id": "r_int", "when": {}, "then": {"alarm": {"commission": "const 5"}}}]}],
        "edges": [{"id": "e_in", "from": "sys.req", "to": "x.req"}, {"id": "e_out", "from": "x.out", "to": "sys.out"},
                  {"id": "e_alarm", "from": "x.alarm", "to": "sys.alarm"}],
        "use_cases": uc("req"),
        "observation_points": [{"id": "o", "edge": "e_alarm", "tolerate": {"commission": 1}}]}, work)
    assert v["commission@o"] == ("unchecked", ["N", "A"])  # the alarm edge is used only when the fault fires


def test_a_forwarded_message_is_not_dropped(work):
    """j forwards only when a and b both arrive; a guard catches the value failure rv adds and caps it,
    but the message is a forwarded one, so k still receives it and its own row decides."""
    v, _ = verdicts({
        "modes": ["omission", "commission", "value"],
        "components": [
            {"id": "j", "kind": "deterministic", "in": ["a", "b"], "out": ["out"], "flow": {"a": [], "b": []},
             "rows": [{"id": "fwd", "when": {"a": "any", "b": "any"}, "then": {"out": "as it is"}},
                      {"id": "rv", "when": {"a": "any"}, "then": {"out": {"value": "const 9"}}, "activation": "always"}]},
            {"id": "k", "kind": "deterministic", "in": ["in"], "out": ["o2"],
             "rows": [{"id": "rk", "when": {"in": "any"}, "then": {"o2": {"commission": "const 9"}}}]}],
        "guards": [{"id": "g", "edge": "e_jk", "targets": [{"mode": "value", "threshold": 1, "decidable": True}]}],
        "edges": [{"id": "e_a", "from": "sys.a", "to": "j.a"}, {"id": "e_b", "from": "sys.b", "to": "j.b"},
                  {"id": "e_jk", "from": "j.out", "to": "k.in"}, {"id": "e_o2", "from": "k.o2", "to": "sys.out"}],
        "use_cases": uc("a", "b"),
        "observation_points": [{"id": "o2", "edge": "e_o2", "tolerate": {"commission": 1}}]}, work,
        {"certificates": [{"id": "c_g", "component": "g", "targets": {"value": "never"}}]})
    assert v["commission@o2"] == ("unchecked", ["N", "S", "A"])


def test_a_dropping_guard_waits_for_its_input_to_settle(work):
    """x creates a message with s2 at once and adds s1 two passes later; g catches s1 and drops the
    message, which only failure rows created. Read too early, g would have forwarded s2."""
    v, _ = verdicts({
        "modes": ["omission", {"commission": ["s1", "s2"]}],
        "components": [
            {"id": "a", "kind": "deterministic", "in": ["r"], "out": ["o"],
             "rows": [{"id": "ra1", "when": {"r": "any"}, "then": {"o": {"s1": "const 9"}}, "activation": "always"}]},
            {"id": "b", "kind": "deterministic", "in": ["i"], "out": ["o"]},
            {"id": "x", "kind": "deterministic", "in": ["i1", "i2"], "out": ["side"], "flow": {"i1": [], "i2": []},
             "rows": [{"id": "r_a", "when": {"i1": "any"}, "then": {"side": {"s2": "const 9"}}, "activation": "always"},
                      {"id": "r_b", "when": {"i2": {"s1": 1}}, "then": {"side": {"s1": "keep"}}, "activation": "always"}]}],
        "guards": [{"id": "g", "edge": "e_side", "targets": [{"mode": "s1", "threshold": 1, "decidable": True}]}],
        "edges": [{"id": "e_r", "from": "sys.req", "to": "a.r"}, {"id": "e_ab", "from": "a.o", "to": "b.i"},
                  {"id": "e_bx", "from": "b.o", "to": "x.i2"}, {"id": "e_x1", "from": "sys.req", "to": "x.i1"},
                  {"id": "e_side", "from": "x.side", "to": "sys.out"}],
        "use_cases": uc("req"),
        "observation_points": [{"id": "o", "edge": "e_side", "tolerate": {"s2": 1}}]}, work,
        {"certificates": [{"id": "c_g", "component": "g", "targets": {"s1": "never"}}]})
    assert v["s2@o"] == ("not exercised", [])


FANOUT = {
    "modes": ["omission", "commission"],
    "components": [
        {"id": "p", "kind": "llm", "in": ["req"], "out": ["order"],
         "rows": [{"id": "p1", "when": {"*": "any"}, "then": {"order": {"commission": "const 9"}}}],
         "drop_defaults": [{"port": "order", "mode": "omission", "reason": "test"}]},
        {"id": "x", "kind": "deterministic", "in": ["in"], "out": ["a", "b"]}],
    "guards": [{"id": "g", "edge": "e_px", "targets": [{"mode": "commission", "threshold": 1, "decidable": True}]}],
    "edges": [{"id": "e_in", "from": "sys.req", "to": "p.req"}, {"id": "e_px", "from": "p.order", "to": "x.in"},
              {"id": "e_a", "from": "x.a", "to": "sys.out1"}, {"id": "e_b", "from": "x.b", "to": "sys.out2"}],
    "use_cases": uc("req"),
    "observation_points": [{"id": "o1", "edge": "e_a", "tolerate": {"commission": 1}},
                           {"id": "o2", "edge": "e_b", "tolerate": {"commission": 1}}],
}


def test_a_refuted_certificate_is_suspended_everywhere(work):
    """The witness at o1 shows the guard leaked; the certificate is suspended at o2 too, and the
    witness narrows o2 as well (the run that reached o1 reached o2)."""
    ev = {"certificates": [{"id": "c_g", "component": "g", "targets": {"commission": "never"}}],
          "witnesses": [{"id": "w1", "use_case": "u", "at": {"o1": {"modes": {"commission": [1, 10]}}}}]}
    v, rep = verdicts(FANOUT, work, ev)
    assert v["commission@o1"] == ("unchecked", ["S", "A"])
    assert v["commission@o2"] == ("unchecked", ["S", "A"])
    assert rep["suspension"]["suspended"] == ["c_g"]
    assert all(c["suspended"] == ["c_g"] for c in rep["cells"])


def test_the_scope_rule(work):
    d = copy.deepcopy(FANOUT)
    d["use_cases"] = [{"id": "u", "entries": [{"port": "req", "token": {}}]},
                      {"id": "v", "entries": [{"port": "req", "token": {"taint": True}}]}]
    cert = {"id": "c_g", "component": "g", "targets": {"commission": "never"}}
    v, _ = verdicts(d, work, {"certificates": [dict(cert, scope=["u", "v"])]})
    assert v["commission@o1"][0] == "guarantee"
    v, _ = verdicts(d, work, {"certificates": [dict(cert, scope=["u"])]})
    assert v["commission@o1"][0] == "unchecked"         # v can fire the leak row too, and the scope omits it


def test_a_receiving_component_is_judged_by_its_own_levels():
    m = load_model({
        "modes": ["omission"], "lattices": {"confidentiality": ["public", "secret"]},
        "components": [{"id": "a", "kind": "deterministic", "in": ["i"], "out": ["o"]},
                       {"id": "b", "kind": "deterministic", "in": ["i"], "out": ["o"], "clearance": "public"}],
        "edges": [{"id": "e1", "from": "sys.in", "to": "a.i"}, {"id": "e2", "from": "a.o", "to": "b.i"},
                  {"id": "e3", "from": "b.o", "to": "sys.out"}],
        "use_cases": [{"id": "u", "entries": [{"port": "in", "token": {"conf": "secret"}}]}],
        "observation_points": [{"id": "o", "edge": "e2"}]})
    assert m.obs["o"].clearance == 0
