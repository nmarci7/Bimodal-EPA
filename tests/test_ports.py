"""A model drawn port by port in the workbench: several ports per component, a fan-out from one
output port, a guard with a decidable target, observation points that judge every mode and one that
judges confidentiality against its receiver's clearance; YAML certificates; the 'any input' rule."""
import time

import pytest
from fastapi.testclient import TestClient

from epa.api.app import app
from epa.model.load import ModelError, load_model, validate


def doc():
    return {
        "name": "ports",
        "modes": ["omission", {"commission": []}, "late", "value"],
        "lattices": {"confidentiality": ["public", "internal", "confidential"], "authority": ["none", "user", "admin"]},
        "components": [
            {"id": "planner", "kind": "llm", "in": ["input", "from_tool", "from_store"], "out": ["to_tool", "to_det"], "rows": []},
            {"id": "tool", "kind": "tool", "in": ["from_planner", "from_store"], "out": ["to_planner", "to_store"], "pass": "all", "rows": []},
            {"id": "store", "kind": "store", "in": ["from_tool"], "out": ["to_tool"], "rows": []},
            {"id": "det", "kind": "deterministic", "in": ["from_planner"], "out": ["to_det2"], "pass": "all", "clearance": "internal", "rows": []},
            {"id": "det2", "kind": "deterministic", "in": ["from_det"], "out": ["output"], "pass": "all", "rows": []},
        ],
        "guards": [{"id": "g", "label": "schema check", "edge": "e_pd", "targets": [{"mode": "commission", "threshold": 1, "decidable": True}]}],
        "edges": [
            {"id": "e_in", "from": "sys.input", "to": "planner.input"},
            {"id": "e_pt", "from": "planner.to_tool", "to": "tool.from_planner"},
            {"id": "e_tp", "from": "tool.to_planner", "to": "planner.from_tool"},
            {"id": "e_ts", "from": "tool.to_store", "to": "store.from_tool"},
            {"id": "e_st", "from": "store.to_tool", "to": "tool.from_store"},
            {"id": "e_sp", "from": "store.to_tool", "to": "planner.from_store"},      # fan-out of one port
            {"id": "e_pd", "from": "planner.to_det", "to": "det.from_planner"},
            {"id": "e_dd", "from": "det.to_det2", "to": "det2.from_det"},
            {"id": "e_out", "from": "det2.output", "to": "sys.output"},
        ],
        "use_cases": [{"id": "uc1", "entries": [{"port": "input", "token": {"conf": "confidential"}}]}],
        "observation_points": [
            {"id": "o_output", "edge": "e_out", "tolerate": {"omission": 1, "commission": 1, "late": 1, "value": 1}},
            {"id": "o_det", "edge": "e_pd", "clearance": "receiver"},
        ],
    }


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def run(client, d, certs=()):
    aid = client.post("/api/analyses", json={"doc": d, "evidence": {"certificates": list(certs), "witnesses": []}}).json()["id"]
    for _ in range(600):
        a = client.get(f"/api/analyses/{aid}").json()
        if a["status"] != "running":
            break
        time.sleep(0.3)
    assert a["status"] == "done", a.get("error")
    return {c["cell"]: c for c in a["report"]["cells"]}


def test_receiver_clearance_and_fanout_load():
    m = load_model(doc())
    assert m.obs["o_det"].clearance == m.conf_levels.index("internal")
    assert {e.id for e in m.edges_from("store", "to_tool")} == {"e_st", "e_sp"}


def test_receiver_must_be_a_component():
    d = doc()
    d["observation_points"][0]["clearance"] = "receiver"
    assert any("receiver is outside the model" in p for p in validate(d))


def test_any_input_takes_only_any_message():
    d = doc()
    d["components"][3]["rows"] = [{"id": "r1", "when": {"*": {"late": 3}}, "then": {"to_det2": {"late": "keep"}}}]
    assert any("'any input' takes only 'any message'" in p for p in validate(d))
    with pytest.raises(ModelError):
        load_model(d)


def test_yaml_certificate(client):
    text = "id: c_g\ncomponent: g\ntargets: {commission: never}\nissuer: test\n"
    r = client.post("/api/evidence/certificates", json={"doc": doc(), "text": text}).json()
    assert r["certificates"][0]["state"] == "in force"


def test_verdicts_of_the_drawn_model(client):
    cells = run(client, doc())
    assert cells["commission@o_output"]["verdict"] == "unchecked"
    assert cells["conf@o_det"]["verdict"] == "exposed"            # confidential data reaches a component cleared for internal
    cert = {"id": "c_g", "component": "g", "targets": {"commission": "never"}, "issuer": "test"}
    cells = run(client, doc(), [cert])
    assert cells["commission@o_output"]["verdict"] == "guarantee"
    assert cells["omission@o_output"]["verdict"] == "unchecked"   # the planner's default omission: S or A
