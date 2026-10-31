"""Performance benchmarks for the Bimodal Agentic System Reasoner engine.

    python bench/bench.py --root . --out results.json [--only B1,B4] [--max-seconds 600]

B1 open rows in one cone (an LLM and k guards in a chain), B2 use cases, B3a an LLM calling k tools
that answer it, B3b an LLM handing k tool calls to a deterministic executor, B4 the demo cases
stage by stage, cold and warm, B5 k components ready at once, so more firing orders.

Every data point runs on a fresh work folder, so TLC runs cold; B4 also re-runs warm. The models
are written so that the same document loads in the engine before and after the draft-4 fixes:
no `pass`, no `absorbs`, no forwarding rows.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time


def chain(k, use_cases=1):
    """An LLM emits k sub-kinds of commission; k guards in a chain catch one each (2k open rows)."""
    subs = [f"s{i}" for i in range(k)]
    return {
        "name": f"chain-{k}", "modes": ["omission", {"commission": subs}],
        "lattices": {"confidentiality": [f"c{i}" for i in range(max(2, use_cases))]},
        "components": [{"id": "p", "kind": "llm", "in": ["req"], "out": ["order"],
                        "rows": [{"id": f"p_{s}", "when": {"*": "any"}, "then": {"order": {s: "const 9"}}} for s in subs],
                        "drop_defaults": [{"port": "order", "mode": m, "reason": "bench"} for m in ("omission", "commission")]}],
        "guards": [{"id": f"g{i}", "edge": "e_out", "targets": [{"mode": s, "threshold": 1, "decidable": True}]}
                   for i, s in enumerate(subs)],
        "edges": [{"id": "e_in", "from": "sys.req", "to": "p.req"}, {"id": "e_out", "from": "p.order", "to": "sys.bank"}],
        "use_cases": [{"id": f"u{j}", "entries": [{"port": "req", "token": {"conf": f"c{j}"}}]} for j in range(use_cases)],
        "observation_points": [{"id": "o", "edge": "e_out", "tolerate": {"commission": 1}}],
    }


def tool_loop(t):
    """An LLM planner calls t tools and reads their results back (the usual agent loop); a schema
    guard on every call; observed at the reply and at the first tool's call log."""
    ins = ["user"] + [f"r{i}" for i in range(t)]
    outs = [f"c{i}" for i in range(t)] + ["reply"]
    comps = [{"id": "planner", "kind": "llm", "in": ins, "out": outs}]
    edges = [{"id": "e_user", "from": "sys.user", "to": "planner.user"},
             {"id": "e_reply", "from": "planner.reply", "to": "sys.reply"}]
    guards = []
    for i in range(t):
        comps.append({"id": f"tool{i}", "kind": "tool", "in": ["call"], "out": ["res"]})
        edges += [{"id": f"e_c{i}", "from": f"planner.c{i}", "to": f"tool{i}.call"},
                  {"id": f"e_r{i}", "from": f"tool{i}.res", "to": f"planner.r{i}"}]
        guards.append({"id": f"g{i}", "edge": f"e_c{i}", "targets": [{"mode": "value", "threshold": 1, "decidable": True}]})
    return {"name": f"tool-loop-{t}", "modes": ["omission", "commission", "late", "value"],
            "components": comps, "guards": guards, "edges": edges,
            "use_cases": [{"id": "ask", "entries": [{"port": "user", "token": {"taint": True}}]}],
            "observation_points": [{"id": "o_reply", "edge": "e_reply", "tolerate": {"commission": 1, "value": 1}},
                                   {"id": "o_call0", "edge": "e_c0", "tolerate": {"value": 1}}]}


def executor(t):
    """An LLM planner hands t tool calls to a deterministic executor, which runs them and merges the
    results into the reply (fan-out and fan-in through deterministic code). No pass-through or
    absorption is declared: the defaults of the engine decide what the tools and the executor do
    with an arriving failure."""
    p_outs = [f"c{i}" for i in range(t)]
    comps = [{"id": "planner", "kind": "llm", "in": ["user"], "out": p_outs,
              "drop_defaults": [{"port": p, "mode": m, "reason": "bench"} for p in p_outs
                                for m in ("omission", "commission", "late")]},
             {"id": "exec", "kind": "deterministic", "in": [f"q{i}" for i in range(t)] + [f"a{i}" for i in range(t)],
              "out": [f"x{i}" for i in range(t)] + ["reply"],
              "flow": {**{f"q{i}": [f"x{i}"] for i in range(t)}, **{f"a{i}": ["reply"] for i in range(t)}}}]
    edges = [{"id": "e_user", "from": "sys.user", "to": "planner.user"},
             {"id": "e_reply", "from": "exec.reply", "to": "sys.reply"}]
    guards = []
    for i in range(t):
        comps.append({"id": f"tool{i}", "kind": "tool", "in": ["call"], "out": ["res"]})
        edges += [{"id": f"e_p{i}", "from": f"planner.c{i}", "to": f"exec.q{i}"},
                  {"id": f"e_x{i}", "from": f"exec.x{i}", "to": f"tool{i}.call"},
                  {"id": f"e_a{i}", "from": f"tool{i}.res", "to": f"exec.a{i}"}]
        guards.append({"id": f"g{i}", "edge": f"e_x{i}", "targets": [{"mode": "value", "threshold": 1, "decidable": True}]})
    return {"name": f"executor-{t}", "modes": ["omission", "commission", "late", "value"],
            "components": comps, "guards": guards, "edges": edges,
            "use_cases": [{"id": "ask", "entries": [{"port": "user", "token": {}}]}],
            "observation_points": [{"id": "o_reply", "edge": "e_reply", "tolerate": {"value": 1}}]}


def ready(k):
    """k workers ready at once, each with its own starting token, all feeding one join: the rows are
    fixed, so only the firing orders grow with k. One guard on the way out, one open row."""
    ports = [f"p{i}" for i in range(k)]
    comps = [{"id": "join", "kind": "deterministic", "in": ports, "out": ["out"], "flow": {p: ["out"] for p in ports}}]
    edges = [{"id": "e_out", "from": "join.out", "to": "sys.bank"}]
    entries = []
    for i in range(k):
        comps.append({"id": f"w{i}", "kind": "deterministic", "in": ["in"], "out": ["out"], "flow": {"in": ["out"]}})
        edges += [{"id": f"e_s{i}", "from": f"sys.s{i}", "to": f"w{i}.in"},
                  {"id": f"e_w{i}", "from": f"w{i}.out", "to": f"join.p{i}"}]
        entries.append({"port": f"s{i}", "token": {"sub": {f"s{i}": 1}}})
    return {"name": f"ready-{k}", "modes": ["omission", {"commission": [f"s{i}" for i in range(k)]}],
            "components": comps, "edges": edges,
            "guards": [{"id": "g", "edge": "e_out", "targets": [{"mode": "s0", "decidable": True}]}],
            "use_cases": [{"id": "u", "entries": entries}],
            "observation_points": [{"id": "o", "edge": "e_out", "tolerate": {"commission": 1}}]}


def analyse(doc, rank=False, evidence=None, cells=None, work=None):
    from epa.engine.coordinator import Engine
    from epa.model.load import load_model
    m = load_model(doc)
    folder = work or tempfile.mkdtemp(prefix="epa-bench-")
    eng = Engine(m, folder)
    t0 = time.time()
    rep = eng.analyse(evidence or {}, only_cells=cells, rank=rank)
    total = time.time() - t0
    if not work:
        shutil.rmtree(folder, ignore_errors=True)
    tlc = rep["tlc_calls"]
    return {"total_s": round(total, 3),
            "tlc_s": round(sum(c.get("seconds") or 0 for c in tlc), 3),
            "tlc_calls": len(tlc),
            "vectors": sum(max(0, c.get("vectors") or 0) for c in tlc),
            "distinct_states": sum(c.get("distinct") or 0 for c in tlc),
            "cells": len(rep["cells"]),
            "largest_cone_rows": max([len(k["rows"]) for k in rep["cones"]] or [0]),
            "verdicts": {c["cell"]: c["verdict"] for c in rep["cells"]}}


def bench_cases(root):
    from epa.engine.coordinator import Engine
    from epa.engine.scenario import load_case, stage_inputs
    from epa.model.load import load_model
    out = []
    for case in ("wallet", "smart-home", "mcp-coding-agent"):
        cdir = os.path.join(root, "cases", case)
        stages = [s["id"] for s in load_case(cdir).get("stages", [])]
        work = tempfile.mkdtemp(prefix=f"epa-bench-{case}-")
        for warm in (False, True):
            for st in stages:
                doc, ev, _ = stage_inputs(cdir, st)
                m = load_model(doc)
                t0 = time.time()
                rep = Engine(m, work).analyse(ev, rank=True)
                out.append({"case": case, "stage": st, "warm": warm, "total_s": round(time.time() - t0, 3),
                            "tlc_s": round(sum(c.get("seconds") or 0 for c in rep["tlc_calls"] if not c.get("cached")), 3),
                            "tlc_calls": sum(1 for c in rep["tlc_calls"] if not c.get("cached")),
                            "distinct_states": sum(c.get("distinct") or 0 for c in rep["tlc_calls"] if not c.get("cached")),
                            "cells": len(rep["cells"]),
                            "largest_cone_rows": max([len(k["rows"]) for k in rep["cones"]] or [0]),
                            "verdicts": {c["cell"]: c["verdict"] for c in rep["cells"]}})
                print(f"  B4 {case} {st} {'warm' if warm else 'cold'}: {out[-1]['total_s']} s", flush=True)
        shutil.rmtree(work, ignore_errors=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="B1,B2,B3a,B3b,B4")
    ap.add_argument("--max-seconds", type=float, default=600, help="stop a series once a point takes longer")
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    sys.path.insert(0, root)
    os.chdir(root)
    only = set(args.only.split(","))
    res = {"root": root, "started": time.strftime("%Y-%m-%d %H:%M:%S")}

    def series(name, xs, make, **kw):
        pts = []
        for x in xs:
            r = analyse(make(x), **kw)
            r["x"] = x
            pts.append(r)
            print(f"  {name} x={x}: total {r['total_s']} s, TLC {r['tlc_s']} s, cone {r['largest_cone_rows']} rows, "
                  f"{r['vectors']} firing choices", flush=True)
            if r["total_s"] > args.max_seconds:
                break
        return pts

    if "B1" in only:
        res["B1_chain_rows"] = series("B1", range(1, 9), chain, cells=["commission@o"])
    if "B2" in only:
        res["B2_use_cases"] = series("B2", [1, 2, 4, 8], lambda u: chain(5, use_cases=u), cells=["commission@o"])
    if "B3a" in only:
        res["B3a_tool_loop"] = series("B3a", [1, 2, 4, 8, 12, 16], tool_loop, rank=True)
    if "B3b" in only:
        res["B3b_executor"] = series("B3b", range(1, 9), executor, rank=False)
    if "B4" in only:
        res["B4_cases"] = bench_cases(root)
    if "B5" in only:
        res["B5_ready"] = series("B5", range(2, 11), ready, cells=["commission@o"])
    res["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(args.out, "w") as f:
        json.dump(res, f, indent=1)
    print("wrote", args.out)


if __name__ == "__main__":
    main()
