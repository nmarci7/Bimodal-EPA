"""Worst-case defaults for every component (`worst_case_defaults: all`, FPTC style), the setting of a
new model: a component nobody modelled is never a guarantee; a certificate, a calibrating row or a
dropped default with a reason is what earns one. Models without the setting keep the defaults on LLM
components only (the demo cases are checked unchanged in test_cases.py)."""
import pytest

from epa.engine.coordinator import Engine
from epa.intake.cert_import import classify
from epa.model import edit as E
from epa.model.load import load_model, validate


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    return str(tmp_path_factory.mktemp("work"))


def verdicts(doc, work, evidence=None):
    rep = Engine(load_model(doc), work).analyse(evidence or {}, rank=False)
    return {c["cell"]: c["verdict"] for c in rep["cells"]}


def parser_model(setting="all"):
    """sys.req -> parser (deterministic, nothing modelled) -> sys.res, logged at o_res."""
    d = E.blank("parser")
    d["worst_case_defaults"] = setting
    E.put_component(d, {"id": "parser", "kind": "deterministic"})
    E.connect(d, "sys.req", "parser.req")
    E.connect(d, "parser.out", "sys.res")
    E.put_observation_point(d, {"edge": "e_parser_res", "label": "response log"})
    assert validate(d) == []
    return d


def test_a_new_model_starts_with_the_fptc_modes_and_defaults_for_every_component():
    d = E.blank()
    assert d["modes"] == ["omission", {"commission": []}, "early", "late", {"value": ["coarse", "subtle"]}]
    assert d["worst_case_defaults"] == "all"
    m = load_model(parser_model())
    assert m.top_modes == ["omission", "commission", "early", "late", "value"]
    assert m.fields == ["omission", "commission", "early", "late", "value", "coarse", "subtle"]
    defaults = {r for r in m.rows if r.startswith("default.")}
    assert defaults == {f"default.parser.out.{t}" for t in m.top_modes}
    assert all(m.rows[r].open and not m.rows[r].llm for r in defaults)


def test_the_setting_is_checked_and_llm_keeps_the_old_behaviour():
    assert validate(dict(parser_model(), worst_case_defaults="some")) == [
        "worst_case_defaults must be one of llm, all, not 'some'"]
    assert not [r for r in load_model(parser_model("llm")).rows if r.startswith("default.")]
    d = parser_model()
    assert E.set_settings(d, worst_case_defaults="llm") == "changed worst-case defaults for LLM components"
    assert d["worst_case_defaults"] == "llm"


def test_an_unmodelled_component_is_not_rewarded(work):
    v = verdicts(parser_model("all"), work)
    assert set(v) == {f"{t}@o_res" for t in ("omission", "commission", "early", "late", "value")}
    assert set(v.values()) == {"unchecked"}
    v = verdicts(parser_model("llm"), work)                     # the old reward for modelling nothing
    assert set(v.values()) == {"guarantee"}


def test_a_certificate_earns_the_guarantee(work):
    d = parser_model()
    cert = {"id": "c_late", "component": "parser", "rows": {"out.late": "never"}}
    assert classify(cert, load_model(d))[0] == "in force"       # not an LLM row: never is allowed
    v = verdicts(d, work, {"certificates": [cert]})
    assert v["late@o_res"] == "guarantee"
    assert v["value@o_res"] == "unchecked"


def test_a_dropped_or_calibrated_default_is_a_recorded_decision(work):
    d = parser_model()
    E.drop_default(d, "parser", "out", "early", "the parser answers only after the whole request arrived")
    E.put_row(d, "parser", {"id": "p_slow", "when": {"*": "any"}, "then": {"out": {"late": "const 3"}}})
    m = load_model(d)
    decided = {(x["kind"], x["mode"]) for x in m.decisions if "mode" in x}
    assert {("drop-default", "early"), ("calibrate-default", "late")} <= decided
    assert "default.parser.out.early" not in m.rows and "default.parser.out.late" not in m.rows
    assert verdicts(d, work)["early@o_res"] == "guarantee"


def test_llm_defaults_keep_the_llm_rule():
    d = parser_model()
    E.put_component(d, {"id": "agent", "kind": "llm"})
    E.connect(d, "sys.ask", "agent.ask")
    E.connect(d, "agent.reply", "sys.reply")
    m = load_model(d)
    agent = {r for r in m.rows if r.startswith("default.agent.reply.")}
    assert len(agent) == 5 and all(m.rows[r].llm for r in agent)
    cert = {"id": "c_agent", "component": "agent", "rows": {"reply.value": "never"}}
    state, reason, _ = classify(cert, m)
    assert state == "rejected" and "LLM rule" in reason
