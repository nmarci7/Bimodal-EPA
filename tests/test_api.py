"""The HTTP API the workbench uses: cases, stages, model check, evidence intake, bootstrap, an analysis."""
import os
import time

import pytest
from fastapi.testclient import TestClient

from epa.api.app import app

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_cases_and_stage(client):
    ids = [c["id"] for c in client.get("/api/cases").json()]
    assert ids == ["smart-home", "wallet", "mcp-coding-agent"]
    b = client.get("/api/cases/wallet/bundle").json()
    assert {s["id"] for s in b["stages"]} >= {"S0", "S1", "S2"}
    assert any(p.endswith("duna-bank-2026-10-15.csv") for p in b["logs"])
    st = client.get("/api/cases/wallet/stages/S2").json()
    assert {c["id"] for c in st["evidence"]["certificates"]} >= {"c_gd", "c_gm"}
    assert st["doc"]["layout"]["sys"]["payee"]["dir"] == "out"


def test_check_and_register(client):
    doc = client.get("/api/cases/wallet").json()["model"]
    ch = client.post("/api/model/check", json={"doc": doc}).json()
    assert ch["ok"] and any(c["cell"] == "oom@o_statement" for c in ch["cells"])
    cert = open(os.path.join(ROOT, "cases/wallet/certs/vendor-eval.json")).read()
    r = client.post("/api/evidence/certificates", json={"doc": doc, "text": cert}).json()
    assert r["certificates"][0]["state"] == "rejected"
    b = client.get("/api/cases/wallet/bundle").json()
    log = open(os.path.join(ROOT, "cases/wallet/data/statements/duna-bank-2026-10-15.csv")).read()
    w = client.post("/api/evidence/logs", json={"doc": doc, "filename": "duna-bank-2026-10-15.csv", "text": log,
                                                 "recognisers": list(b["recognisers"].values()),
                                                 "deployments": b["deployments"], "lookups": b["lookups"]}).json()
    assert any(x["at"]["o_statement"]["modes"].get("oom") == [1, 10] for x in w["witnesses"])
    reg = client.post("/api/evidence/register", json={"doc": doc, "evidence": {"witnesses": w["witnesses"]}}).json()
    assert all(x["state"] == "in force" for x in reg["witnesses"])


def test_bootstrap_finds_the_server(client):
    d = os.path.join(ROOT, "cases/mcp-coding-agent/intake")
    r = client.post("/api/bootstrap", json={"traces": open(os.path.join(d, "traces.jsonl")).read(),
                                             "tools": open(os.path.join(d, "tools_list.json")).read(),
                                             "answers": open(os.path.join(d, "answers.yaml")).read()}).json()
    assert not r["problems"]
    assert {c["id"] for c in r["doc"]["components"]} == {"planner", "runner"}


def test_analysis_streams_and_reports(client):
    st = client.get("/api/cases/wallet/stages/S2").json()
    aid = client.post("/api/analyses", json={"doc": st["doc"], "evidence": st["evidence"]}).json()["id"]
    for _ in range(600):
        a = client.get(f"/api/analyses/{aid}").json()
        if a["status"] != "running":
            break
        time.sleep(0.5)
    assert a["status"] == "done", a["error"]
    cells = {c["cell"]: c for c in a["report"]["cells"]}
    assert cells["oom@o_statement"]["verdict"] == "hope"
    assert cells["oom@o_statement"]["suspended"] == ["c_gm"]
    assert cells["commission@o_statement"]["verdict"] == "unchecked"
    steps = {e["step"] for e in a["events"]}
    assert {"model", "cells", "cone", "verdict", "done"} <= steps
    pos = client.get(f"/api/analyses/{aid}/cells/commission@o_statement/possibilities").json()
    assert pos["remaining_only"] and pos["candidates"]
    oom = client.get(f"/api/analyses/{aid}/cells/oom@o_statement/possibilities").json()
    assert oom["suspended"] == ["c_gm"]
    assert sorted(c["status"] for c in oom["candidates"] if not c["struck_by"]) == ["S", "S", "S"]
    md = client.get(f"/api/analyses/{aid}/report.md").text
    assert "oom" in md
