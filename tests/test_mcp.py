"""The MCP server (epa/mcp/server.py), the shared workspace (epa/workspace.py) and the model edits it
uses (epa/model/edit.py).

* the edits, on their own and through Workbench (checked, refused, forced);
* a real MCP session over stdio with the official client (mcp.ClientSession): the tools are listed,
  the wallet case is opened at S2 and analysed, and the verdict is the one the engine gives directly;
* the same server spoken to in raw JSON-RPC (no SDK on the client side), to check the protocol itself;
* the workspace endpoints of the HTTP API, which the reasoner uses to open what the assistant built.
"""
import json
import os
import subprocess
import sys

import anyio
import pytest
from fastapi.testclient import TestClient

from epa import workspace as W
from epa.mcp.server import Workbench
from epa.model import edit as E
from epa.model.load import load_model, validate

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable


def server_cmd(tmp):
    return [PY, "-m", "epa", "mcp", "--workspace", str(tmp / "workspace.json"), "--work", str(tmp / "work")]


# ---------------------------------------------------------------- the edits
def test_edits_build_a_model_the_engine_loads():
    d = E.blank("tiny")
    E.put_component(d, {"id": "agent", "kind": "llm", "label": "planner"})
    E.put_component(d, {"id": "tool", "kind": "tool"})
    assert "use case uc1" in E.connect(d, "sys.ask", "agent.ask")
    E.connect(d, "agent.call", "tool.call")
    E.connect(d, "tool.result", "sys.out")
    E.put_guard(d, {"edge": "e_agent_tool", "label": "schema check", "targets": [{"mode": "value", "threshold": 1, "decidable": True}]})
    E.put_observation_point(d, {"edge": "e_tool_out", "label": "tool log"})
    E.put_row(d, "tool", {"id": "t_slow", "when": {"call": "any"}, "then": {"result": {"late": "const 3"}}})
    assert validate(d) == []
    m = load_model(d)
    assert "default.agent.call.value" in m.rows and "leak.g.value" in m.rows and "t_slow" in m.rows
    # renames follow the edges, and a removal takes the edges and what sits on them
    E.put_component(d, {"id": "tool", "new_id": "api"})
    assert {e["to"] for e in d["edges"]} >= {"api.call"}
    E.remove_component(d, "api")
    assert not d["guards"] and not d["observation_points"] and all("api." not in e["from"] + e["to"] for e in d["edges"])


def test_edits_refuse_what_can_never_be_right():
    d = E.blank()
    E.put_component(d, {"id": "a", "kind": "deterministic"})
    for bad in (lambda: E.put_component(d, {"id": "a2", "kind": "robot"}),
                lambda: E.put_component(d, {"id": "sys", "kind": "tool"}),
                lambda: E.connect(d, "sys.x", "sys.y"),
                lambda: E.connect(d, "a.out", "a.in"),
                lambda: E.put_row(d, "nope", {"id": "r"}),
                lambda: E.put_guard(d, {"edge": "e_missing"}),
                lambda: E.remove_row(d, "a", "r_missing")):
        with pytest.raises(E.EditError):
            bad()


def test_workbench_checks_every_edit(tmp_path):
    b = Workbench(str(tmp_path / "ws.json"), str(tmp_path / "work"))
    b.open_case("wallet", "S1")
    ok = b.put_row("agent", {"id": "p_test", "when": {"invoice": "any"}, "then": {"request": {"late": "const 4"}}})
    assert ok["saved"] and ok["well_formed"]
    bad = b.put_row("agent", {"id": "p_bad", "when": {"nope": "any"}, "then": {"request": {"late": "const 4"}}})
    assert not bad["saved"] and bad["new_problems"] == ["row p_bad: unknown input port agent.nope"]
    assert "p_bad" not in [r["id"] for r in b.list_rows("agent")["rows"]["agent"]]
    # a shape the loader cannot read at all is a problem too, not a crash
    worse = b.put_guard(edge="e_request", label="x", targets=[{"zzz": 1}])
    assert not worse["saved"] and worse["new_problems"][0].startswith("the model cannot be loaded")
    forced = b.put_row("agent", {"id": "p_bad", "when": {"nope": "any"}, "then": {"request": {"late": "const 4"}}}, force=True)
    assert forced["saved"] and not forced["well_formed"]
    assert W.load(b.path)["by"] == "mcp"


def test_workbench_evidence_and_analysis(tmp_path):
    b = Workbench(str(tmp_path / "ws.json"), str(tmp_path / "work"))
    b.open_case("wallet", "S1")
    c = b.add_certificate({"id": "c_x", "component": "agent", "rows": {"p_offmandate": "never"}})
    assert c["state"] == "rejected" and "LLM rule" in c["reason"]
    with pytest.raises(Exception, match="unknown observation point"):
        b.add_witness({"at": {"o_nope": {"modes": {"oom": 1}}}})
    w = b.ingest_log("duna-bank-2026-10-15.csv", path="data/statements/duna-bank-2026-10-15.csv")
    assert w["added"] >= 1 and w["recognisers"]
    s = b.run_analysis(rank=False)
    oom = next(x for x in s["cells"] if x["cell"] == "oom@o_statement")
    assert oom["conflicts"] == [["c_gm"]]
    assert b.get_verdict("oom@o_statement")["suspended"] == ["c_gm"]
    md = b.export_report("markdown")["text"]
    assert md.startswith("# Verdicts for wallet-agent") and "c_gm" in md
    # an edit makes the last analysis stale
    b.put_claim("oom@o_statement", "guarantee", "wallet team")
    with pytest.raises(Exception, match="run_analysis"):
        b.get_verdict("oom@o_statement")


# ---------------------------------------------------------------- a real MCP session over stdio
def test_mcp_session_over_stdio(tmp_path):
    from mcp import ClientSession, StdioServerParameters, stdio_client

    params = StdioServerParameters(command=PY, args=server_cmd(tmp_path)[1:], cwd=ROOT,
                                   env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})

    async def session():
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                init = await s.initialize()
                assert init.server_info.name == "bimodal-reasoner" and "Bimodal Agentic System Reasoner" in (init.instructions or "")
                names = {t.name for t in (await s.list_tools()).tools}
                assert {"open_case", "put_row", "add_witness", "run_analysis", "get_verdict", "explain_cell"} <= names
                res = await s.call_tool("open_case", {"case": "wallet", "stage": "S2"})
                assert not res.is_error and res.structured_content["stage"] == "S2"
                res = await s.call_tool("run_analysis", {"rank": False})
                assert not res.is_error
                cells = {c["cell"]: c for c in res.structured_content["cells"]}
                assert cells["oom@o_statement"]["verdict"] == "hope" and cells["oom@o_statement"]["conflicts"] == [["c_gm"]]
                assert cells["dup@o_statement"]["verdict"] == "guarantee"
                v = await s.call_tool("get_verdict", {"cell": "oom@o_statement"})
                assert v.structured_content["suspended"] == ["c_gm"]
                bad = await s.call_tool("open_case", {"case": "nope"})
                assert bad.is_error and "no case 'nope'" in bad.content[0].text
                res = await s.read_resource("epa://workspace/model.yaml")
                assert "name: wallet-agent" in res.contents[0].text
                return True

    assert anyio.run(session)
    ws = W.load(str(tmp_path / "workspace.json"))
    assert ws["by"] == "mcp" and ws["case"] == "wallet" and ws["report"]["model"]["name"] == "wallet-agent"


def test_mcp_protocol_without_the_sdk(tmp_path):
    """Newline-delimited JSON-RPC 2.0 on stdin/stdout, as the MCP stdio transport defines it."""
    p = subprocess.Popen(server_cmd(tmp_path), cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def send(msg):
        p.stdin.write(json.dumps(msg) + "\n")
        p.stdin.flush()

    def reply():
        line = p.stdout.readline()
        assert line, p.stderr.read()
        return json.loads(line)

    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "raw-test", "version": "0"}}})
        r = reply()
        assert r["id"] == 1 and r["result"]["serverInfo"]["name"] == "bimodal-reasoner" and "tools" in r["result"]["capabilities"]
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        r = reply()
        tools = {t["name"]: t for t in r["result"]["tools"]}
        assert len(tools) >= 40 and tools["put_row"]["inputSchema"]["required"] == ["component", "row"]
        send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_cases", "arguments": {}}})
        r = reply()
        assert [c["id"] for c in r["result"]["structuredContent"]["cases"]] == ["mcp-coding-agent", "smart-home", "wallet"]
        assert json.loads(r["result"]["content"][0]["text"])["cases"][2]["id"] == "wallet"
        send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "open_case", "arguments": {"case": "nope"}}})
        r = reply()
        assert r["result"]["isError"] and "no case 'nope'" in r["result"]["content"][0]["text"]
    finally:
        p.kill()
        p.wait()


# ---------------------------------------------------------------- the reasoner side of the workspace
def test_workspace_endpoints(tmp_path, monkeypatch):
    from epa.api import app as A
    monkeypatch.setattr(A, "WORKSPACE", str(tmp_path / "workspace.json"))
    c = TestClient(A.app)
    assert c.get("/api/workspace/meta").json()["exists"] is False
    assert c.get("/api/workspace").status_code == 404
    b = Workbench(str(tmp_path / "workspace.json"), str(tmp_path / "work"))
    b.new_model("from-the-assistant")
    b.put_component(id="planner", kind="llm")
    meta = c.get("/api/workspace/meta").json()
    assert meta["exists"] and meta["by"] == "mcp" and meta["name"] == "from-the-assistant"
    got = c.get("/api/workspace").json()
    assert got["doc"]["components"][0]["id"] == "planner"
    got["doc"]["name"] = "edited-in-the-browser"
    put = c.put("/api/workspace", json={"doc": got["doc"], "evidence": {"witnesses": [], "files": [{"name": "x"}]}})
    assert put.status_code == 200 and put.json()["by"] == "browser"
    assert b.status()["model"] == "edited-in-the-browser" and b.status()["by"] == "browser"
