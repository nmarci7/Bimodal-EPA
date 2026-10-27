"""Command line.

  python -m epa serve [--port 8765]                 the analyst UI and the API
  python -m epa check MODEL                         validate, list cells, cones and unmatched failures
  python -m epa run MODEL [--certs F ...] [--logs F ... --recognisers F ... --deployments F]
                          [--format text|md|json|cra]
  python -m epa case CASE [--stage S]               run a demo case (all stages, or one)
  python -m epa tla MODEL CELL                      print the TLA+ module generated for a cell's cone
  python -m epa bootstrap --traces F [--tools F] [--answers F]   draft a model from traces
  python -m epa mcp [--workspace F] [--work DIR]   the reasoner as an MCP server (stdio), on the shared workspace
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _engine(model, quiet=False):
    from .engine.coordinator import Engine
    work = os.environ.get("EPA_WORK", os.path.join(ROOT, ".epa-work"))
    on = (lambda e: None) if quiet else (lambda e: print(f"  {e['t']:7.2f}s  {e['step']:<9} {e['msg']}", file=sys.stderr))
    return Engine(model, work, on_event=on)


def _print(rep, fmt):
    from .report import explain, markdown
    if fmt == "json":
        print(json.dumps(rep, indent=1, default=str))
    elif fmt == "md":
        print(markdown.report(rep))
    elif fmt == "cra":
        print(json.dumps(markdown.cra_export(rep), indent=1))
    else:
        for c in rep["cells"]:
            st = ",".join(c["statuses"])
            rem = c["candidates"].get("remaining")
            if rem is None and c["candidates"].get("at_least"):
                rem = f">{c['candidates']['at_least']}"
            frac = "" if rem is None else f"{rem}/{c['candidates']['space']}"
            st_txt = ("{" + st + "}") if st else ""
            print(f"{c['cell']:<28} {c['verdict']:<14} {st_txt:<10} {frac:>12}  {explain.reason_line(c)}")
        if rep.get("ranking"):
            print("\ncertify next:")
            for a in rep["ranking"][:8]:
                print(f"  {' + '.join(a['action']):<14} key {a['key']:<3} {', '.join(x['cell'] for x in a['moved']) or a['note']}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="epa", description="bimodal error propagation analysis, engine v2")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--host", default="127.0.0.1")
    s = sub.add_parser("check")
    s.add_argument("model")
    s = sub.add_parser("run")
    s.add_argument("model")
    s.add_argument("--certs", nargs="*", default=[])
    s.add_argument("--logs", nargs="*", default=[])
    s.add_argument("--recognisers", nargs="*", default=[])
    s.add_argument("--deployments")
    s.add_argument("--format", default="text", choices=["text", "md", "json", "cra"])
    s.add_argument("--no-rank", action="store_true")
    s = sub.add_parser("case")
    s.add_argument("case")
    s.add_argument("--stage")
    s.add_argument("--format", default="text", choices=["text", "md", "json", "cra"])
    s = sub.add_parser("tla")
    s.add_argument("model")
    s.add_argument("cell")
    s = sub.add_parser("bootstrap")
    s.add_argument("--traces", required=True)
    s.add_argument("--tools")
    s.add_argument("--answers")
    s.add_argument("--server", default="mcp", help="the component the traces show for the MCP server")
    s.add_argument("--name", default="bootstrapped")
    s = sub.add_parser("mcp", help="the reasoner as an MCP server (stdio) on the shared workspace")
    s.add_argument("--workspace", help="the shared workspace file (default: <work>/workspace.json)")
    s.add_argument("--work", help="the work folder: run cache and TLC files (default: EPA_WORK or .epa-work)")
    a = ap.parse_args(argv)

    if a.cmd == "mcp":
        from .mcp.server import Workbench, build_server
        build_server(Workbench(a.workspace, a.work)).run("stdio")
        return

    if a.cmd == "serve":
        import uvicorn
        print(f"EPA engine v2: open http://{a.host}:{a.port}", file=sys.stderr)
        uvicorn.run("epa.api.app:app", host=a.host, port=a.port, log_level="warning")
        return
    from .model.load import load_model
    if a.cmd == "check":
        from .model import cone as C
        from .model import wellformed
        from .epistemic.reason import candidate_space
        m = load_model(a.model)
        print(f"{m.name}: {len(m.components)} components, {len(m.edges)} edges, {len(m.rows)} rows")
        for c in C.cells(m):
            k = C.cone_of_cell(m, c)
            print(f"  {c.id:<28} rows {len(k.rows):>2}  candidates {candidate_space(m, k.rows):>6}  {', '.join(k.rows)}")
        for u in wellformed.absorbed(m):
            print(f"  absorbs: {', '.join(u['modes'])} at {u['component']}.{u['port']} ({u['kind']}: {u['reason']})")
        return
    if a.cmd == "run":
        from .intake import cert_import, log_import
        m = load_model(a.model)
        certs = [c for f in a.certs for c in cert_import.load(f)]
        recs = [log_import.load_recogniser(r) for r in a.recognisers]
        deps = log_import.load_deployments(a.deployments) if a.deployments else None
        wits = []
        for f in a.logs:
            for _, ws, _ in log_import.recognise_all(open(f).read(), f, recs, m, deps, os.path.dirname(f)):
                wits += ws
        rep = _engine(m).analyse({"certificates": certs, "witnesses": wits}, rank=not a.no_rank)
        _print(rep, a.format)
        return
    if a.cmd == "case":
        from .engine.scenario import load_case, stage_inputs
        d = a.case if os.path.isdir(a.case) else os.path.join(ROOT, "cases", a.case)
        meta = load_case(d)
        stages = [a.stage] if a.stage else [s["id"] for s in meta.get("stages", [])] or [None]
        for sid in stages:
            doc, ev, st = stage_inputs(d, sid)
            if a.format == "text":
                print(f"\n=== {meta['title']}" + (f" - {sid}: {st.get('label', '')}" if st else ""))
            rep = _engine(load_model(doc), quiet=True).analyse(ev)
            _print(rep, a.format)
        return
    if a.cmd == "tla":
        from .model import cone as C
        from .translate import to_tla
        m = load_model(a.model)
        k = next(k for k in C.cones(m, C.cells(m)) if a.cell in k.cell_rows)
        print(to_tla.module_for(m, k)[0])
        return
    if a.cmd == "bootstrap":
        from .intake import bootstrap, mcp_import
        skel = bootstrap.skeleton_from_traces(bootstrap.read_spans(open(a.traces).read()))
        if a.tools:
            skel = bootstrap.skeleton_from_mcp(mcp_import.read_tools_list(a.tools), skel, server=a.server)
        if not a.answers:
            for q in bootstrap.questionnaire(skel):
                print(f"- {q['key']}: {q['ask']}")
            return
        doc = bootstrap.apply_answers(skel, yaml.safe_load(open(a.answers)), a.name)
        print(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True))


if __name__ == "__main__":
    main()
