"""Evidence written by hand (the reasoner's New witness / New certificate, or an agent through the MCP
server): shaped and checked like evidence from files, and it moves the verdicts the same way."""
import os

import pytest
from fastapi.testclient import TestClient

from epa.api.app import app
from epa.engine.coordinator import Engine
from epa.engine.scenario import stage_inputs
from epa.intake import log_import
from epa.model.load import load_model

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WALLET = os.path.join(ROOT, "cases", "wallet")
DEPLOY = open(os.path.join(WALLET, "data", "deployments.json"), encoding="utf-8").read()


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


@pytest.fixture(scope="module")
def s1():
    return stage_inputs(WALLET, "S1")


def test_manual_witness_shape_and_versions(s1):
    doc, _, _ = s1
    m = load_model(doc)
    w = log_import.manual_witness({"id": "w_hand", "use_case": "pay", "date": "2026-10-15",
                                   "at": {"o_statement": {"modes": {"oom": [1, 10], "dup": 0}}}}, m, DEPLOY)
    assert w["at"] == {"o_statement": {"modes": {"oom": [1, 10], "dup": [0, 0]}}}
    assert w["recogniser"] == "manual" and w["source"] == "entered by hand" and w["versions"]["gm"] == "mandate-v2"
    assert log_import.classify_witness(w, m) == ("in force", "")
    # after the 20 October deployment the manifest says mandate-v3, which the model of S1 is not
    later = log_import.manual_witness({"at": {"o_statement": {"modes": {"oom": 0}}}, "date": "2026-10-27"}, m, DEPLOY)
    assert log_import.classify_witness(later, m)[0] == "stale"
    # without a manifest the witness is taken to be from the versions in the model
    assert log_import.manual_witness({"at": {"o_statement": {"modes": {"oom": 0}}}}, m)["versions"]["gm"] == "mandate-v2"


def test_manual_witness_levels_and_problems(s1):
    m = load_model(s1[0])
    w = log_import.manual_witness({"at": {"o_presentation": {"conf": "personal", "taint": False}}}, m)
    assert w["at"]["o_presentation"] == {"conf": [2, 2], "taint": False}
    with pytest.raises(log_import.WitnessError) as e:
        log_import.manual_witness({"use_case": "nope", "date": "15/10",
                                   "at": {"o_x": {}, "o_statement": {"modes": {"zzz": 1, "oom": 11}}}}, m)
    p = " | ".join(e.value.problems)
    for bit in ("unknown observation point 'o_x'", "unknown failure mode 'zzz'", "oom must lie in 0..10",
                "unknown use case 'nope'", "not YYYY-MM-DD"):
        assert bit in p


def test_witness_endpoint(client, s1):
    doc = s1[0]
    r = client.post("/api/evidence/witness", json={"doc": doc, "deployments": DEPLOY,
                                                   "witness": {"id": "w_a", "date": "2026-10-15", "use_case": "pay",
                                                               "at": {"o_statement": {"modes": {"oom": [1, 10]}}}}})
    assert r.status_code == 200 and r.json()["witness"]["state"] == "in force"
    bad = client.post("/api/evidence/witness", json={"doc": doc, "witness": {"at": {}}})
    assert bad.status_code == 422 and bad.json()["detail"]["problems"] == ["a witness logs at least one observation point"]


def test_a_hand_written_witness_of_the_incident_suspends_the_mandate_certificate(s1, tmp_path):
    """The 15 October statement line, written by hand instead of read from the CSV, against the S1
    certificates: the same minimal conflict, the same suspension."""
    doc, ev, _ = s1
    m = load_model(doc)
    w = log_import.manual_witness({"id": "w_hand_incident", "use_case": "pay", "date": "2026-10-15",
                                   "at": {"o_statement": {"modes": {"oom": [1, 10]}}}}, m, DEPLOY)
    cert = {"id": "c_hand", "component": "ga", "targets": {"over": "never"}, "version": "amount-v1", "manual": True}
    rep = Engine(m, str(tmp_path)).analyse({**ev, "witnesses": [w], "certificates": ev["certificates"] + [cert]}, rank=False)
    oom = next(c for c in rep["cells"] if c["cell"] == "oom@o_statement")
    assert oom["conflicts"] == [["c_gm"]] and oom["suspended"] == ["c_gm"]
    assert oom["verdict"] != "guarantee"
    reg = {c["id"]: c["state"] for c in rep["register"]["certificates"]}
    assert reg["c_hand"] == "in force"
