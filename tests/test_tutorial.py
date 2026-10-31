"""The tour (web/tutorial.js) promises a verdict for the followed cell (a wrong value at the log point)
after each of its runs. This builds the same model the tour's "Do it for me" builds, a new model with
the five standard failure modes, and checks every promised verdict with the engine."""
import pytest

from epa.engine.coordinator import Engine
from epa.model import edit as E
from epa.model.load import load_model, validate


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    return str(tmp_path_factory.mktemp("work"))


def verdict(doc, ev, work):
    assert validate(doc) == []
    rep = Engine(load_model(doc), work).analyse(ev, rank=False)
    cells = {c["cell"]: (c["verdict"], ",".join(c["statuses"])) for c in rep["cells"]}
    return cells["value@o_order"], {v for k, v in cells.items() if k != "value@o_order"}


def test_the_tour_story(work):
    d = E.blank("my-first-model")
    E.put_component(d, {"id": "parser", "kind": "deterministic", "label": "turns the request into an order"})
    E.connect(d, "sys.request", "parser.request")
    E.connect(d, "parser.order", "sys.order")
    E.put_observation_point(d, {"edge": "e_parser_order", "label": "order log"})
    ev = {"certificates": [], "witnesses": [], "decisions": []}
    value_row = "default.parser.order.value"

    # chapter 1: nothing is known
    assert verdict(d, ev, work) == (("unchecked", "N,S,A"), {("unchecked", "N,S,A")})
    # chapter 2: a test report says always; withdrawn; the fix certified never
    ev["certificates"].append({"id": "c_test", "component": "parser", "rows": {value_row: "always"}})
    assert verdict(d, ev, work)[0] == ("exposed", "A")
    ev["decisions"].append({"kind": "withdraw-cert", "certificate": "c_test", "by": "test team", "reason": "the bug is fixed"})
    ev["certificates"].append({"id": "c_fix", "component": "parser", "rows": {f"default.parser.order.{f}": "never"
                                                                              for f in ("value", "coarse", "subtle")}})
    assert verdict(d, ev, work)[0] == ("guarantee", "N")
    # chapter 3: an LLM in front; a clean log line
    E.remove_edge(d, "e_request_parser")
    E.put_component(d, {"id": "writer", "kind": "llm", "label": "writes the order draft"})
    E.connect(d, "sys.request", "writer.request")
    E.connect(d, "writer.draft", "parser.request")
    assert verdict(d, ev, work) == (("unchecked", "S,A"), {("unchecked", "S,A")})
    ev["witnesses"].append({"id": "w_clean", "use_case": "uc1", "at": {"o_order": {"used": True, "modes": {"value": [0, 0]}}}})
    assert verdict(d, ev, work)[0] == ("hope", "S")
    # chapter 5: a guard, certified
    E.put_guard(d, {"id": "schema", "edge": "e_writer_parser", "label": "schema check",
                    "targets": [{"mode": "value", "threshold": 1, "decidable": True}]})
    ev["certificates"].append({"id": "c_schema", "component": "schema", "targets": {"value": "never"}})
    assert verdict(d, ev, work)[0] == ("guarantee", "N")
