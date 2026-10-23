"""MCP tool lists -> model components.

`read_tools_list` takes a saved `tools/list` response (or a live server's, when the MCP Python SDK is
installed and a launch command is given). `tools_to_patch` turns it into tool components with an
edge from the agent to each tool and one back (the ReAct cycle); an untrusted server's results enter
the agent tainted. Tool annotations become *suggestions* the analyst confirms (destructive or
open-world tools are candidates for observation points), because they come from the server.
`diff_tools` compares two lists: a changed description or schema after approval is a model change.
"""
from __future__ import annotations

import hashlib
import json


def read_tools_list(src):
    data = json.loads(src) if isinstance(src, str) and src.lstrip().startswith("{") else (
        json.load(open(src)) if isinstance(src, str) else src)
    if "result" in data:
        data = data["result"]
    return data.get("tools", [])


def tool_hash(t):
    payload = {"description": t.get("description", ""), "inputSchema": t.get("inputSchema", {})}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:12]


def tools_to_patch(tools, agent="agent", agent_port_call="call", agent_port_result="result",
                   server="mcp", server_trust=False):
    comps, edges, suggestions = [], [], []
    for t in tools:
        tid = t["name"].replace("-", "_").replace(".", "_")
        ann = t.get("annotations") or {}
        comps.append({"id": tid, "kind": "tool", "label": (t.get("description") or "")[:60],
                      "in": ["call"], "out": ["result"], "trusted": bool(server_trust),
                      "version": f"{server}:{tool_hash(t)}",
                      "source": f"mcp tools/list ({server})",
                      "schema_fields": sorted((t.get("inputSchema") or {}).get("properties", {}))})
        edges.append({"id": f"e_{agent}_{tid}", "from": f"{agent}.{agent_port_call}", "to": f"{tid}.call",
                      "label": "tool call", "source": "mcp tools/list"})
        edges.append({"id": f"e_{tid}_{agent}", "from": f"{tid}.result", "to": f"{agent}.{agent_port_result}",
                      "label": "tool result", "source": "mcp tools/list"})
        if ann.get("destructiveHint") or ann.get("openWorldHint"):
            suggestions.append({"tool": tid, "hint": sorted(k for k, v in ann.items() if v),
                                "suggest": "observation point on the call edge (destructive or open-world)"})
        if ann.get("readOnlyHint"):
            suggestions.append({"tool": tid, "hint": ["readOnlyHint"],
                                "suggest": "read-only: its result edge carries the server's data into the agent"})
    return {"components": comps, "edges": edges, "suggestions": suggestions}


def diff_tools(old, new):
    """Tools whose description or schema changed since approval (the rug pull), added or removed."""
    o = {t["name"]: tool_hash(t) for t in old}
    n = {t["name"]: tool_hash(t) for t in new}
    return {"changed": sorted(k for k in o.keys() & n.keys() if o[k] != n[k]),
            "added": sorted(n.keys() - o.keys()), "removed": sorted(o.keys() - n.keys())}
