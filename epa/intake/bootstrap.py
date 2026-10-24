"""When there is no system model: draft one from what the company already has.

  traces (OpenTelemetry GenAI spans)  -> components, call order, use cases, LLM model versions
  MCP tools/list responses            -> tool components, schemas, hints
  the analyst's answers (YAML)        -> failure modes, guards, the system boundary, observation points

Nothing here invents a failure row: LLM components get the worst-case defaults when the model is
loaded, and everything the analyst must decide is asked, not guessed. Every element records where it
came from (`source`), and the document is marked as a draft until the analyst accepts it.

Span conventions read (OpenTelemetry GenAI semantic conventions, plus one optional attribute):
  gen_ai.operation.name   invoke_agent | chat | execute_tool
  gen_ai.agent.name       the agent (root span)
  gen_ai.request.model    the LLM's model identifier (becomes the component version)
  gen_ai.tool.name        the tool called
  epa.component           any other span that is a component (a service, a store, an API)
  app.use_case            the use case the root span belongs to (configurable)
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict

from . import mcp_import


def read_spans(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def skeleton_from_traces(spans, use_case_attr="app.use_case"):
    by_trace = defaultdict(list)
    for s in spans:
        by_trace[s["trace_id"]].append(s)
    comps, edges, ucs, entry_of = {}, Counter(), Counter(), {}
    for tid, ss in by_trace.items():
        root = next((s for s in ss if not s.get("parent_span_id")), ss[0])
        ra = root.get("attributes", {})
        agent = ra.get("gen_ai.agent.name", "agent")
        uc = ra.get(use_case_attr, "default")
        ucs[uc] += 1
        comp_of = {}
        for s in sorted(ss, key=lambda s: s["start"]):
            a = s.get("attributes", {})
            op = a.get("gen_ai.operation.name")
            name = None
            if op == "chat":
                name = agent
                comps.setdefault(agent, {"id": agent, "kind": "llm", "version": a.get("gen_ai.request.model"),
                                         "source": "traces: chat spans"})
            elif op == "execute_tool":
                name = a["gen_ai.tool.name"].replace("-", "_").replace(".", "_")
                comps.setdefault(name, {"id": name, "kind": "tool", "source": "traces: execute_tool spans"})
            elif "epa.component" in a:
                name = a["epa.component"]
                comps.setdefault(name, {"id": name, "kind": a.get("epa.kind", "deterministic"),
                                        "version": a.get("service.version"), "source": "traces: epa.component"})
            if name:
                comp_of[s["span_id"]] = name
        # a span called by a component span is fed by it (parent -> child); spans directly under the
        # root follow one another in time (each step's output feeds the next)
        top = []
        for s in sorted(ss, key=lambda s: s["start"]):
            name = comp_of.get(s["span_id"])
            if not name:
                continue
            parent = comp_of.get(s.get("parent_span_id"))
            if parent and parent != name:
                edges[(parent, name)] += 1
            elif not parent and (not top or top[-1] != name):
                top.append(name)
        if top:
            entry_of.setdefault(uc, top[0])
        chain = [f"sys.{uc}_in"] + top
        for x, y in zip(chain, chain[1:]):
            edges[(x, y)] += 1
    n = len(by_trace)
    return {"components": comps,
            "edges": [{"from": x, "to": y, "seen": k, "source": f"traces: seen in {k} of {n}"}
                      for (x, y), k in edges.items()],
            "use_cases": [{"id": u, "entry": f"{u}_in", "source": f"traces: {k} of {n} root spans"}
                          for u, k in ucs.items()],
            "traces": n}


def skeleton_from_mcp(tools, skel, server="mcp", server_trust=False):
    """If the traces already show the MCP server as one component (`server`), its tools become that
    component's operations (with their schema hashes as its version); otherwise each tool becomes a
    tool component of its own. If no traced component has that name, one named after MCP is taken."""
    if server not in skel["components"]:
        server = next((c for c in skel["components"] if "mcp" in c.lower()), server)
    patch = mcp_import.tools_to_patch(tools, server=server, server_trust=server_trust)
    if server in skel["components"]:
        c = skel["components"][server]
        c["tools"] = [{"name": t["name"], "hash": mcp_import.tool_hash(t),
                       "hints": sorted(k for k, v in (t.get("annotations") or {}).items() if v is True)}
                      for t in tools]
        c["version"] = c.get("version") or "tools:" + mcp_import.tool_hash({"description": "", "inputSchema": [
            mcp_import.tool_hash(t) for t in tools]})
        c["source"] = (c.get("source", "") + " + mcp tools/list").strip(" +")
        c["trusted"] = bool(server_trust)
    else:
        for c in patch["components"]:
            cur = skel["components"].setdefault(c["id"], {"id": c["id"], "kind": "tool", "source": ""})
            cur["source"] = (cur.get("source", "") + " + mcp tools/list").strip(" +")
            cur["schema_fields"] = c["schema_fields"]
            cur["version"] = cur.get("version") or c["version"]
            cur["trusted"] = c["trusted"]
    skel["suggestions"] = patch["suggestions"]
    return skel


def questionnaire(skel):
    q = [{"key": "modes", "ask": "Which failure modes should be analysed? (e.g. omission, commission with sub-kinds, late, value)"},
         {"key": "data_flow_confirmed", "ask": "Does each call's output feed the next call, in the order the traces show?"}]
    traced = {e["from"] for e in skel["edges"]} | {e["to"] for e in skel["edges"]}
    for c in skel["components"].values():
        if c["kind"] == "tool" and c["id"] in traced:
            q.append({"key": f"guards.{c['id']}", "ask": f"Is {c['id']} a guard? If so: what it catches (mode and threshold, taint, confidentiality, authority), whether that is decidable from the edge, and its version."})
            q.append({"key": "outside", "ask": f"Is {c['id']} outside the system (a sink such as a bank, a public repository, a device)?"})
    q.append({"key": "observation_points", "ask": "Where do logs exist (which edge), what do they record, and what is tolerated there?"})
    q.append({"key": "use_case_tokens", "ask": "Which inputs are untrusted (tainted), how confidential, and on whose authority do they arrive?"})
    return q


def apply_answers(skel, ans, name):
    """The skeleton and the answers -> a model document (draft)."""
    if not ans.get("data_flow_confirmed"):
        raise ValueError("the data flow is not confirmed: edges read off the call order are only a guess")
    comps = {k: dict(v) for k, v in skel["components"].items()}
    edges = [dict(e) for e in skel["edges"]]
    outside = set(ans.get("outside", []))
    guards = ans.get("guards") or {}
    renames = ans.get("rename") or {}
    out_guards = []
    for g, spec in guards.items():
        ins = [e for e in edges if e["to"] == g]
        outs = [e for e in edges if e["from"] == g]
        if len(ins) != 1 or len(outs) != 1:
            raise ValueError(f"guard {g}: expected one edge in and one out, found {len(ins)} and {len(outs)}")
        merged = {"from": ins[0]["from"], "to": outs[0]["to"],
                  "source": f"{ins[0]['source']}; guard {g} placed on it (answers)"}
        edges = [e for e in edges if e is not ins[0] and e is not outs[0]] + [merged]
        comps.pop(g, None)
        out_guards.append({"id": spec.get("id", g), "label": spec.get("label", g), "on": merged,
                           "version": spec.get("version"), "targets": spec["targets"],
                           "learned": bool(spec.get("learned", False)),
                           "closed_output": bool(spec.get("closed_output", False)),
                           "source": f"{g}: traces + answers"})
    for c in outside:
        comps.pop(c, None)

    def ref(x, side):
        if x.startswith("sys."):
            return x
        if x in outside:
            return f"sys.{x}"
        return f"{renames.get(x, x)}.{side}"

    doc_edges, seen_ids = [], set()
    for e in edges:
        a = e["from"].split(".")[-1]
        b = e["to"].split(".")[-1]
        eid = f"e_{renames.get(a, a)}_{renames.get(b, b)}"
        while eid in seen_ids:
            eid += "_"
        seen_ids.add(eid)
        e["id"] = eid
        doc_edges.append({"id": eid, "from": ref(e["from"], "out"), "to": ref(e["to"], "in"), "source": e["source"]})
    for g in out_guards:
        on = g.pop("on")
        g["edge"] = on["id"]
    obs = []
    for o in ans.get("observation_points", []):
        tgt = ref(o["into"], "in")
        e = next(e for e in doc_edges if e["to"] == tgt)
        obs.append({"id": o["id"], "edge": e["id"], "label": o.get("label", o["id"]), "log": o.get("log", ""),
                    **{k: o[k] for k in ("tolerate", "taint", "clearance", "requires") if k in o},
                    "source": "answers"})
    components = []
    for cid, c in comps.items():
        nid = renames.get(cid, cid)
        extra = (ans.get("components") or {}).get(cid, {})
        components.append({"id": nid, "kind": extra.get("kind", c["kind"]), "label": extra.get("label", ""),
                           "version": c.get("version"), "in": ["in"], "out": ["out"],
                           **{k: v for k, v in extra.items() if k not in ("kind", "label")},
                           "source": c.get("source", "")})
    tokens = ans.get("use_case_tokens") or {}
    use_cases = [{"id": u["id"], "entries": [{"port": u["entry"], "token": tokens.get(u["id"], {})}],
                  "source": u["source"]} for u in skel["use_cases"]]
    doc = {"name": name, "status": "draft (accept after review)", "modes": ans.get("modes"),
           "components": components, "guards": out_guards, "edges": doc_edges, "use_cases": use_cases,
           "observation_points": obs}
    if ans.get("lattices"):
        doc["lattices"] = ans["lattices"]
    return doc
