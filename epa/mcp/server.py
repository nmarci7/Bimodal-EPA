"""The reasoner as an MCP server: an assistant (Claude Code, Claude Desktop, any MCP client) can open
a demo case, build or change a model, add evidence, run the analysis and read the verdicts.

    python -m epa mcp [--workspace FILE] [--work DIR]        stdio transport

Everything happens in the shared workspace (epa/workspace.py): the model and the evidence the tools
work on are saved there after every change, and the reasoner in the browser can open them
(File → Open the shared workspace) or save its own model there for the assistant.

`Workbench` holds the logic and returns plain dicts, so it can be tested without a client;
`build_server` registers it with the MCP SDK (mcp 2.x, MCPServer) as tools and resources.
"""
from __future__ import annotations

import copy
import glob
import json
import os
from typing import Any

import yaml

from .. import workspace as W
from ..engine.cache import RunCache
from ..engine.coordinator import Engine
from ..engine.scenario import load_case, stage_inputs
from ..intake import cert_import, log_import
from ..model import edit as E
from ..model.load import ModelError, load_model, read_document, validate
from ..report import explain, markdown

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CASES = os.path.join(ROOT, "cases")
DOCS = os.path.join(ROOT, "docs")

INSTRUCTIONS = """Bimodal Agentic System Reasoner: bimodal error propagation analysis of agentic systems.
A model has components (LLM, deterministic, tool, store, external, user) with input and output ports,
edges between ports, rows (what a component does with failures), guards on edges, observation points
on edges where a log exists, and use cases (where messages enter). The analysis runs every firing choice
of the rows that matter through TLA+/TLC and keeps, with clingo, the candidates the evidence allows;
each observation point and judged failure (a cell, written mode@point) gets a verdict: guarantee, hope,
exposed, unchecked, not exercised or conflict.

Typical use: workspace_status; open_case (a demo case and stage) or new_model / import_model; read with
get_model and check_model; change with put_component, connect, put_row, put_guard, put_observation_point,
put_use_case; add evidence with add_certificate, add_witness or ingest_log; run_analysis; then get_verdict,
explain_cell and certify-next in the run summary. Every edit is checked: if it would add problems to the
model it is not saved unless force=true. The model format is the resource epa://docs/model-format.
Everything is saved in the shared workspace, which the reasoner in the browser can open."""


class ToolError(Exception):
    """A tool call that cannot be done; the message says why and what to do instead."""


def check(doc):
    """The model check of the reasoner: validate, then load (cells, cones). -> {ok, problems, model?}"""
    try:
        problems = validate(copy.deepcopy(doc))
        if problems:
            return {"ok": False, "problems": problems, "model": None}
        return {"ok": True, "problems": [], "model": load_model(doc)}
    except ModelError as e:
        return {"ok": False, "problems": e.problems, "model": None}
    except Exception as e:  # noqa: BLE001  (some malformed shapes fail inside the loader, not in validate)
        return {"ok": False, "problems": [f"the model cannot be loaded: {type(e).__name__}: {e}"], "model": None}


def _strip(x):
    return {k: v for k, v in x.items() if k not in ("state", "reason", "resolved", "reverify")}


class Workbench:
    def __init__(self, path=None, work=None):
        self.work = work or os.environ.get("EPA_WORK") or os.path.join(ROOT, ".epa-work")
        self.path = path or W.default_path(self.work)
        os.makedirs(self.work, exist_ok=True)
        self.cache = RunCache(os.path.join(self.work, "runs.sqlite"))

    # ------------------------------------------------------------------ workspace
    def ws(self):
        return W.load(self.path)

    def save(self, ws):
        W.save(self.path, ws, "mcp")

    def _doc(self, ws):
        if not ws.get("doc"):
            raise ToolError("the workspace has no model yet: call open_case, new_model or import_model first")
        return ws["doc"]

    def _model(self, ws):
        ch = check(self._doc(ws))
        if not ch["ok"]:
            raise ToolError("the model has problems; fix them first (check_model lists them): " + "; ".join(ch["problems"][:8]))
        return ch["model"]

    def status(self):
        ws = self.ws()
        out = {"workspace": self.path, "updated": ws["updated"], "by": ws["by"], "case": ws["case"], "stage": ws["stage"]}
        if not ws["doc"]:
            return {**out, "model": None, "hint": "no model yet: open_case, new_model or import_model"}
        d = ws["doc"]
        ch = check(d)
        ev = ws["evidence"]
        out.update({"model": d.get("name"), "components": len(d.get("components", [])), "guards": len(d.get("guards", [])),
                    "observation_points": len(d.get("observation_points", [])), "rows": sum(len(c.get("rows", [])) for c in d.get("components", [])),
                    "well_formed": ch["ok"], "problems": ch["problems"][:20],
                    "certificates": len(ev["certificates"]), "witnesses": len(ev["witnesses"]), "decisions": len(ev["decisions"]),
                    "analysis": None if not ws["report"] else _verdict_counts(ws["report"])})
        return out

    def _edit(self, fn, force=False):
        """Apply one edit to a copy of the model; save it unless it adds problems (or force)."""
        ws = self.ws()
        doc = copy.deepcopy(self._doc(ws))
        before = set(check(doc)["problems"])
        E.ensure_lists(doc)
        try:
            note = fn(doc)
        except E.EditError as e:
            raise ToolError(str(e)) from None
        after = check(doc)
        new = [p for p in after["problems"] if p not in before]
        if new and not force:
            return {"saved": False, "did": note, "new_problems": new,
                    "hint": "nothing was saved: change the arguments, or call again with force=true to save it anyway"}
        ws["doc"] = doc
        ws["report"] = None                     # the last analysis no longer matches the model
        self.save(ws)
        return {"saved": True, "did": note, "well_formed": after["ok"], "problems": after["problems"][:20]}

    # ------------------------------------------------------------------ cases and models
    def list_cases(self):
        out = []
        for name in sorted(os.listdir(CASES)):
            p = os.path.join(CASES, name, "case.yaml")
            if os.path.exists(p):
                meta = load_case(os.path.join(CASES, name))
                out.append({"id": name, "title": meta.get("title"), "summary": " ".join((meta.get("summary") or "").split()),
                            "stages": [{"id": s["id"], "label": s.get("label", ""), "note": " ".join((s.get("note") or "").split())} for s in meta.get("stages", [])]})
        return out

    def open_case(self, case, stage=None):
        d = os.path.join(CASES, case)
        if os.sep in case or case.startswith(".") or not os.path.isdir(d):
            raise ToolError(f"no case {case!r}; cases: {', '.join(c['id'] for c in self.list_cases())}")
        meta = load_case(d)
        ids = [s["id"] for s in meta.get("stages", [])]
        if stage is not None and stage not in ids:
            raise ToolError(f"case {case} has no stage {stage!r}; stages: {', '.join(ids)}")
        doc, ev, st = stage_inputs(d, stage or (ids[0] if ids else None))
        recs = {}
        for pat in meta.get("recognisers", ["recognisers/*.yaml"]):
            for p in sorted(glob.glob(os.path.join(d, pat))):
                recs[os.path.relpath(p, d)] = open(p, encoding="utf-8").read()
        deps = open(os.path.join(d, meta["deployments"]), encoding="utf-8").read() if meta.get("deployments") else None
        lookups = {}
        for pat in meta.get("lookup_files", ["data/*.csv", "data/*.json"]):
            for p in sorted(glob.glob(os.path.join(d, pat))):
                if os.path.basename(p) != os.path.basename(meta.get("deployments", "")):
                    lookups[os.path.basename(p)] = open(p, encoding="utf-8").read()
        ws = W.blank()
        ws.update({"doc": doc, "case": case, "stage": st["id"] if st else None,
                   "evidence": {**W.empty_evidence(), "certificates": ev["certificates"], "witnesses": ev["witnesses"],
                                "decisions": ev["decisions"], "recognisers": recs, "deployments": deps, "lookups": lookups}})
        self.save(ws)
        logs = sorted(os.path.relpath(p, d) for p in glob.glob(os.path.join(d, "data", "**", "*"), recursive=True)
                      if os.path.isfile(p) and os.path.basename(p) not in lookups and os.path.relpath(p, d) != meta.get("deployments"))
        return {"opened": case, "stage": ws["stage"], "label": (st or {}).get("label"), "note": " ".join(((st or {}).get("note") or "").split()),
                "model": doc.get("name"), "certificates": len(ev["certificates"]), "witnesses": len(ev["witnesses"]),
                "decisions": len(ev["decisions"]), "log_files_of_the_case": logs,
                "next": "check_model, then run_analysis"}

    def new_model(self, name, description=""):
        ws = W.blank()
        ws["doc"] = E.blank(name, description)
        self.save(ws)
        return {"created": name, "next": "put_component, connect, put_row, put_guard, put_observation_point, put_use_case"}

    def import_model(self, text=None, path=None, keep_evidence=False):
        if bool(text) == bool(path):
            raise ToolError("give the model either as text (YAML or JSON) or as a path to a file")
        if path:
            if not os.path.isfile(path):
                raise ToolError(f"no file {path}")
            text = open(path, encoding="utf-8").read()
        try:
            doc = read_document(text)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"cannot read the document: {e}") from None
        if not isinstance(doc, dict):
            raise ToolError("a model is a mapping (see epa://docs/model-format)")
        ws = self.ws() if keep_evidence else W.blank()
        ws.update({"doc": doc, "report": None})
        if not keep_evidence:
            ws["case"] = ws["stage"] = None
        self.save(ws)
        ch = check(doc)
        return {"imported": doc.get("name"), "well_formed": ch["ok"], "problems": ch["problems"][:30]}

    def export_model(self, path=None):
        text = yaml.safe_dump(self._doc(self.ws()), sort_keys=False, allow_unicode=True, width=110)
        if path:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            return {"written": os.path.abspath(path), "bytes": len(text.encode())}
        return {"yaml": text}

    def get_model(self, format="summary"):
        ws = self.ws()
        doc = self._doc(ws)
        if format == "yaml":
            return {"yaml": yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=110)}
        if format == "json":
            return {"model": doc}
        if format != "summary":
            raise ToolError("format is summary, yaml or json")
        ins, outs = E.sys_ports(E.ensure_lists(copy.deepcopy(doc)))
        return {
            "name": doc.get("name"), "description": doc.get("description", ""), "modes": doc.get("modes"), "lattices": doc.get("lattices"),
            "components": [{"id": c["id"], "kind": c.get("kind"), "label": c.get("label", ""), "version": c.get("version"),
                            "in": c.get("in", []), "out": c.get("out", []), "rows": [r["id"] for r in c.get("rows", [])],
                            **({"absorbs": c["absorbs"]} if c.get("absorbs") else {}), **({"drop_defaults": c["drop_defaults"]} if c.get("drop_defaults") else {})}
                           for c in doc.get("components", [])],
            "system_inputs": sorted(ins), "system_outputs": sorted(outs),
            "edges": [{"id": e["id"], "from": e["from"], "to": e["to"], **({"label": e["label"]} if e.get("label") else {})} for e in doc.get("edges", [])],
            "guards": [{"id": g["id"], "label": g.get("label", ""), "edge": g.get("edge"), "targets": g.get("targets", []),
                        **({"learned": True} if g.get("learned") else {}), **({"version": g["version"]} if g.get("version") else {})} for g in doc.get("guards", [])],
            "observation_points": [{"id": o["id"], "edge": o.get("edge"), "label": o.get("label", ""), "tolerate": o.get("tolerate", {}),
                                    **{k: o[k] for k in ("taint", "clearance", "requires", "log") if o.get(k)}} for o in doc.get("observation_points", [])],
            "use_cases": doc.get("use_cases", []), "claims": doc.get("claims", []),
        }

    def check_model(self):
        ch = check(self._doc(self.ws()))
        if not ch["ok"]:
            return {"well_formed": False, "problems": ch["problems"]}
        from ..epistemic.reason import candidate_space
        from ..model import cone as C
        from ..model import wellformed
        m = ch["model"]
        cells = []
        for c in C.cells(m):
            k = C.cone_of_cell(m, c)
            cells.append({"cell": c.id, "open_rows": k.rows, "candidates": candidate_space(m, k.rows)})
        return {"well_formed": True, "problems": [], "cells": cells, "absorbed": wellformed.absorbed(m),
                "warnings": m.warnings}

    def list_rows(self, component=None):
        ws = self.ws()
        doc = self._doc(ws)
        comps = [E.component(doc, component)] if component else doc.get("components", [])
        out = {"rows": {c["id"]: c.get("rows", []) for c in comps}}
        ch = check(doc)
        if ch["ok"]:
            gen = [r.to_json() for r in ch["model"].rows.values() if r.kind != "row" and (not component or r.comp == component)]
            out["engine_rows"] = [{"id": r["id"], "component": r["comp"], "kind": r["kind"], "open": r["open"]} for r in gen]
        return out

    # ------------------------------------------------------------------ evidence
    def list_evidence(self):
        ws = self.ws()
        m = self._model(ws)
        reg = Engine(m, self.work, cache=self.cache).register(ws["evidence"])
        return {
            "certificates": [{"id": c.get("id"), "component": c.get("component"), "state": c["state"], "reason": c["reason"],
                              "rows": c.get("resolved"), **({"reverify": c["reverify"]} if c.get("reverify") else {})} for c in reg["certificates"]],
            "witnesses": [{"id": w["id"], "at": w["at"], "use_case": w.get("use_case"), "date": w.get("date"), "source": w.get("source"),
                           "state": w["state"], "reason": w["reason"]} for w in reg["witnesses"]],
            "decisions": reg["decisions"],
            "recognisers": sorted(ws["evidence"]["recognisers"]), "deployment_manifest": bool(ws["evidence"]["deployments"]),
        }

    def add_certificate(self, certificate):
        ws = self.ws()
        m = self._model(ws)
        if not isinstance(certificate, dict) or not certificate.get("id") or not certificate.get("component"):
            raise ToolError('a certificate is {"id", "component", "targets": {target: never|sometimes|always} or "rows": {row: ...}, '
                            '"version", "issuer", "date", "method", "scope": [use cases], "context": {component: version}}')
        state, reason, rows = cert_import.classify(certificate, m)
        ev = ws["evidence"]
        ev["certificates"] = [c for c in ev["certificates"] if c.get("id") != certificate["id"]] + [_strip({**certificate, "manual": True})]
        ws["report"] = None
        self.save(ws)
        return {"added": certificate["id"], "state": state, "reason": reason, "rows": rows, "reverify": cert_import.reverify(certificate, m)}

    def add_witness(self, witness):
        ws = self.ws()
        m = self._model(ws)
        ev = ws["evidence"]
        try:
            w = log_import.manual_witness(witness, m, ev.get("deployments"))
        except log_import.WitnessError as e:
            raise ToolError("; ".join(e.problems)) from None
        state, reason = log_import.classify_witness(w, m)
        ev["witnesses"] = [x for x in ev["witnesses"] if x.get("id") != w["id"]] + [{**w, "manual": True}]
        ws["report"] = None
        self.save(ws)
        return {"added": w["id"], "state": state, "reason": reason, "witness": w}

    def ingest_log(self, filename, text=None, path=None):
        ws = self.ws()
        m = self._model(ws)
        ev = ws["evidence"]
        if bool(text) == bool(path):
            raise ToolError("give the log either as text or as a path")
        if path:
            full = path if os.path.isabs(path) else os.path.join(CASES, ws["case"], path) if ws["case"] and not os.path.exists(path) else path
            if not os.path.isfile(full):
                raise ToolError(f"no file {path}")
            text = open(full, encoding="utf-8").read()
        recs = [log_import.load_recogniser(t) for t in ev["recognisers"].values()]
        if not recs:
            raise ToolError("no recogniser in the workspace: add one with add_recogniser (or open a demo case)")
        deps = log_import.load_deployments(ev["deployments"]) if ev.get("deployments") else None
        found = log_import.recognise_all(text, filename, recs, m, deps, files=ev.get("lookups") or {})
        if not found:
            return {"added": 0, "note": "no recogniser matched this file"}
        new, unmatched = [], 0
        for rec, wits, un in found:
            new += wits
            unmatched += len(un)
        ids = {w["id"] for w in new}
        ev["witnesses"] = [w for w in ev["witnesses"] if w["id"] not in ids] + new
        ws["report"] = None
        self.save(ws)
        states = [(w["id"],) + log_import.classify_witness(w, m) for w in new]
        return {"added": len(new), "recognisers": [r["id"] for r, _, _ in found], "unmatched_lines": unmatched,
                "witnesses": [{"id": i, "state": s, "reason": r} for i, s, r in states]}

    def add_recogniser(self, name, text):
        try:
            rec = yaml.safe_load(text)
        except yaml.YAMLError as e:
            raise ToolError(f"not YAML: {e}") from None
        if not isinstance(rec, dict) or not rec.get("rules"):
            raise ToolError("a recogniser is a mapping with id, format, files, rules (see cases/*/recognisers/)")
        ws = self.ws()
        ws["evidence"]["recognisers"][name] = text
        self.save(ws)
        return {"added": name, "id": rec.get("id")}

    def set_deployments(self, text):
        try:
            log_import.load_deployments(text)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"not a deployment manifest: {e}") from None
        ws = self.ws()
        ws["evidence"]["deployments"] = text
        self.save(ws)
        return {"saved": True}

    def withdraw_certificate(self, certificate, by, reason):
        ws = self.ws()
        if not any(c.get("id") == certificate for c in ws["evidence"]["certificates"]):
            raise ToolError(f"no certificate {certificate!r} in the workspace")
        if not by or not reason:
            raise ToolError("a withdrawal records who decided and why")
        ws["evidence"]["decisions"].append({"kind": "withdraw-cert", "certificate": certificate, "by": by, "reason": reason})
        ws["report"] = None
        self.save(ws)
        return {"withdrawn": certificate}

    def reject_witness(self, witness, by, second_reviewer, reason):
        ws = self.ws()
        if not any(w.get("id") == witness for w in ws["evidence"]["witnesses"]):
            raise ToolError(f"no witness {witness!r} in the workspace")
        if not by or not second_reviewer or not reason:
            raise ToolError("rejecting a witness takes two people (by and second_reviewer) and a reason")
        ws["evidence"]["decisions"].append({"kind": "reject-witness", "witness": witness, "by": by, "second_reviewer": second_reviewer, "reason": reason})
        ws["report"] = None
        self.save(ws)
        return {"rejected": witness}

    def remove_evidence(self, id):  # noqa: A002
        ws = self.ws()
        ev = ws["evidence"]
        n = len(ev["certificates"]) + len(ev["witnesses"])
        ev["certificates"] = [c for c in ev["certificates"] if c.get("id") != id]
        ev["witnesses"] = [w for w in ev["witnesses"] if w.get("id") != id]
        if len(ev["certificates"]) + len(ev["witnesses"]) == n:
            raise ToolError(f"no certificate or witness {id!r}")
        ws["report"] = None
        self.save(ws)
        return {"removed": id}

    # ------------------------------------------------------------------ analysis
    def run_analysis(self, cells=None, rank=True):
        ws = self.ws()
        m = self._model(ws)
        events = []
        eng = Engine(m, self.work, cache=self.cache, on_event=events.append)
        ev = {k: ws["evidence"][k] for k in ("certificates", "witnesses", "decisions")}
        rep = eng.analyse(ev, only_cells=cells or None, rank=rank)
        rep = json.loads(json.dumps(rep, default=list))
        ws["report"] = rep
        self.save(ws)
        return _summary(rep)

    def _report(self):
        ws = self.ws()
        if not ws["report"]:
            raise ToolError("no analysis of the current model and evidence: call run_analysis first")
        return ws, ws["report"]

    def get_verdict(self, cell):
        _, rep = self._report()
        c = next((x for x in rep["cells"] if x["cell"] == cell), None)
        if c is None:
            raise ToolError(f"no cell {cell!r}; cells: {', '.join(x['cell'] for x in rep['cells'])}")
        keep = ("cell", "verdict", "statuses", "per_uc", "advice", "reasons", "conflicts", "suspended", "lacks_path", "candidates",
                "rows", "root_causes", "severity", "certs_used", "witnesses_used", "scope_withheld", "example_run")
        return {k: c.get(k) for k in keep if k in c}

    def explain_cell(self, cell, candidates=False):
        ws, rep = self._report()
        c = next((x for x in rep["cells"] if x["cell"] == cell), None)
        if c is None:
            raise ToolError(f"no cell {cell!r}")
        m = self._model(ws)
        eng = Engine(m, self.work, cache=self.cache)
        out = {"cell": cell, "verdict": c["verdict"], "advice": c.get("advice")}
        ex = c.get("example_run")
        if ex:
            tr = eng.trace_of(cell, ex["uc"], frozenset(ex["fire"]))
            out["reaching_run"] = {"use_case": ex["uc"], "rows_firing": ex["fire"], "story": explain.trace_story(m, tr, c.get("fields", []))}
        else:
            out["reaching_run"] = None
            out["note"] = "no run reaches the point in a remaining candidate"
        if candidates:
            ev = {k: ws["evidence"][k] for k in ("certificates", "witnesses", "decisions")}
            pos = eng.possibilities(cell, ev)
            out["candidates"] = {k: pos[k] for k in pos if k in ("space", "remaining_only", "suspended")}
            out["candidates"]["list"] = pos["candidates"][:60]
        return out

    def export_report(self, format="markdown", path=None):
        _, rep = self._report()
        if format == "markdown":
            text = markdown.report(rep)
        elif format == "cra":
            text = json.dumps(markdown.cra_export(rep), indent=1)
        else:
            raise ToolError("format is markdown or cra")
        if path:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            return {"written": os.path.abspath(path), "bytes": len(text.encode())}
        return {"text": text}

    # ------------------------------------------------------------------ edits (each one checked)
    def put_component(self, force=False, **spec):
        return self._edit(lambda d: E.put_component(d, {k: v for k, v in spec.items() if v is not None}), force)

    def remove_component(self, id, force=False):  # noqa: A002
        return self._edit(lambda d: E.remove_component(d, id), force)

    def connect(self, source, target, label="", force=False):
        return self._edit(lambda d: E.connect(d, source, target, label), force)

    def remove_edge(self, edge, force=False):
        return self._edit(lambda d: E.remove_edge(d, edge), force)

    def put_row(self, component, row, replace=None, force=False):
        return self._edit(lambda d: E.put_row(d, component, row, replace), force)

    def remove_row(self, component, row_id, force=False):
        return self._edit(lambda d: E.remove_row(d, component, row_id), force)

    def set_absorbs(self, component, port, modes, reason="", force=False):
        return self._edit(lambda d: E.set_absorbs(d, component, port, modes, reason), force)

    def drop_default(self, component, port, mode, reason, force=False):
        return self._edit(lambda d: E.drop_default(d, component, port, mode, reason), force)

    def restore_default(self, component, port, mode, force=False):
        return self._edit(lambda d: E.restore_default(d, component, port, mode), force)

    def put_guard(self, force=False, **spec):
        return self._edit(lambda d: E.put_guard(d, {k: v for k, v in spec.items() if v is not None}), force)

    def remove_guard(self, id, force=False):  # noqa: A002
        return self._edit(lambda d: E.remove_guard(d, id), force)

    def put_observation_point(self, force=False, **spec):
        return self._edit(lambda d: E.put_observation_point(d, {k: v for k, v in spec.items() if v is not None}), force)

    def remove_observation_point(self, id, force=False):  # noqa: A002
        return self._edit(lambda d: E.remove_observation_point(d, id), force)

    def put_use_case(self, id, entries, label="", force=False):  # noqa: A002
        return self._edit(lambda d: E.put_use_case(d, {"id": id, "entries": entries, "label": label}), force)

    def remove_use_case(self, id, force=False):  # noqa: A002
        return self._edit(lambda d: E.remove_use_case(d, id), force)

    def put_claim(self, cell, verdict="guarantee", by="", note=None, force=False):
        return self._edit(lambda d: E.put_claim(d, cell, verdict, by, note), force)

    def remove_claim(self, cell, by=None, force=False):
        return self._edit(lambda d: E.remove_claim(d, cell, by), force)

    def set_model_settings(self, force=False, **kw):
        return self._edit(lambda d: E.set_settings(d, **kw), force)


def _verdict_counts(rep):
    counts = {}
    for c in rep["cells"]:
        counts[c["verdict"]] = counts.get(c["verdict"], 0) + 1
    return counts


def _short_reason(c):
    r = c.get("reasons") or {}
    if c.get("suspended"):
        return f"suspended {', '.join(c['suspended'])}"
    if r.get("structural"):
        return "structural"
    if r.get("certificates"):
        return f"rests on {', '.join(r['certificates'])}"
    if c["verdict"] == "hope":
        return "an LLM row"
    return ""


def _summary(rep):
    return {
        "model": rep["model"]["name"], "seconds": rep.get("seconds"), "tlc_calls": len(rep.get("tlc_calls", [])),
        "verdicts": _verdict_counts(rep),
        "cells": [{"cell": c["cell"], "verdict": c["verdict"], "statuses": c.get("statuses", []), "why": _short_reason(c),
                   **({"conflicts": c["conflicts"]} if c.get("conflicts") else {}), **({"lacks_path": True} if c.get("lacks_path") else {}),
                   **({"advice": c["advice"]} if c.get("advice") else {})} for c in rep["cells"]],
        "certify_next": [{"guards": a["action"], "key": a.get("key"), "moves": [x["cell"] for x in a.get("moved", [])]} for a in (rep.get("ranking") or [])[:6]],
        "reverify": rep.get("reverify", []),
        "claims": [{"cell": cl["cell"], "judgement": cl.get("judgement"), "claimed": cl.get("verdict")} for cl in rep.get("claims", [])],
    }


# ---------------------------------------------------------------------------- the MCP server
def build_server(bench=None):
    from mcp.server.mcpserver import MCPServer
    from mcp.types import ToolAnnotations

    b = bench or Workbench()
    srv = MCPServer(name="bimodal-reasoner", title="Bimodal Agentic System Reasoner", version="2.0", instructions=INSTRUCTIONS)
    read = ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False)
    write = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)
    gone = ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False)

    from mcp.server.mcpserver.exceptions import ToolError as McpToolError

    def wrap(fn):
        """Our refusals go to the client as tool errors with their message (any other exception is
        reported by the SDK as an unexpected error, without the details)."""
        try:
            return fn()
        except ToolError as e:
            raise McpToolError(str(e)) from None

    # ---- workspace, cases, models
    @srv.tool(annotations=read)
    def workspace_status() -> dict[str, Any]:
        """What the shared workspace holds: the model (counts, whether it is well-formed, its problems), the evidence, the case and stage, the last analysis. Call this first."""
        return wrap(b.status)

    @srv.tool(annotations=read)
    def list_cases() -> dict[str, Any]:
        """The demo cases (smart-home hub, delegated wallet agent, MCP coding agent) with their scenario stages."""
        return {"cases": wrap(b.list_cases)}

    @srv.tool(annotations=write)
    def open_case(case: str, stage: str | None = None) -> dict[str, Any]:
        """Load a demo case into the workspace as it stands at a scenario stage (default: the first): its model, its evidence up to that stage, its recognisers, deployment manifest and lookup files. Replaces the workspace."""
        return wrap(lambda: b.open_case(case, stage))

    @srv.tool(annotations=write)
    def new_model(name: str, description: str = "") -> dict[str, Any]:
        """Start an empty model (four failure modes, default levels) in the workspace, with no evidence. Replaces the workspace."""
        return wrap(lambda: b.new_model(name, description))

    @srv.tool(annotations=write)
    def import_model(text: str | None = None, path: str | None = None, keep_evidence: bool = False) -> dict[str, Any]:
        """Put a model into the workspace from YAML or JSON text, or from a file path (the format of epa://docs/model-format). The evidence is cleared unless keep_evidence."""
        return wrap(lambda: b.import_model(text, path, keep_evidence))

    @srv.tool(annotations=read)
    def export_model(path: str | None = None) -> dict[str, Any]:
        """The workspace model as YAML (the document the CLI and the reasoner read); written to path if one is given."""
        return wrap(lambda: b.export_model(path))

    @srv.tool(annotations=read)
    def get_model(format: str = "summary") -> dict[str, Any]:  # noqa: A002
        """The workspace model: format=summary (components with ports and row ids, edges, guards, observation points, use cases, claims), yaml, or json (the whole document)."""
        return wrap(lambda: b.get_model(format))

    @srv.tool(annotations=read)
    def check_model() -> dict[str, Any]:
        """Check the model: its problems, or, when it is well-formed, its cells (mode@point) with the open rows and the number of candidates of each."""
        return wrap(b.check_model)

    @srv.tool(annotations=read)
    def list_rows(component: str | None = None) -> dict[str, Any]:
        """The rows the analyst wrote (as in the document), by component, and the rows the engine adds (pass-through, LLM defaults, guard leak and false-positive rows)."""
        return wrap(lambda: b.list_rows(component))

    # ---- edits: each is checked; one that would add problems is not saved unless force=true
    @srv.tool(annotations=write)
    def put_component(id: str, kind: str | None = None, label: str | None = None, version: str | None = None,  # noqa: A002
                      inputs: list[str] | None = None, outputs: list[str] | None = None, flow: dict[str, list[str]] | None = None,
                      authority: str | None = None, clearance: str | None = None, requires: str | None = None,
                      trusted: bool | None = None, raises: bool | None = None, new_id: str | None = None, force: bool = False) -> dict[str, Any]:
        """Create a component (kind: llm, deterministic, tool, store, external, user) or change the fields given. inputs/outputs add ports; flow maps each input port to the outputs it sends to; new_id renames it (edges follow)."""
        return wrap(lambda: b.put_component(force=force, id=id, kind=kind, label=label, version=version, inputs=inputs, outputs=outputs,
                                            flow=flow, authority=authority, clearance=clearance, requires=requires, trusted=trusted,
                                            raises=raises, new_id=new_id))

    @srv.tool(annotations=gone)
    def remove_component(id: str, force: bool = False) -> dict[str, Any]:  # noqa: A002
        """Remove a component, its edges, and the guards and observation points on them."""
        return wrap(lambda: b.remove_component(id, force))

    @srv.tool(annotations=write)
    def connect(source: str, target: str, label: str = "", force: bool = False) -> dict[str, Any]:
        """Add an edge from an output port to an input port, written component.port, or sys.name for a system input (source) or output (target). Missing ports are created."""
        return wrap(lambda: b.connect(source, target, label, force))

    @srv.tool(annotations=gone)
    def remove_edge(edge: str, force: bool = False) -> dict[str, Any]:
        """Remove an edge with its guards and its observation point."""
        return wrap(lambda: b.remove_edge(edge, force))

    @srv.tool(annotations=write)
    def put_row(component: str, row: dict[str, Any], replace: str | None = None, force: bool = False) -> dict[str, Any]:
        """Add a row to a component, or replace the row with the same id (or the row named by replace). A row: {id, label?, when: {port | "*": "any" | {mode: threshold}}, then: {port: "as it is" | {mode: "const k" | "keep" | "+k" | "max"}}, activation?: always | sometimes | never}. No when: an internal fault; no then: a sink; only "any" and "as it is": forwarding."""
        return wrap(lambda: b.put_row(component, row, replace, force))

    @srv.tool(annotations=gone)
    def remove_row(component: str, row_id: str, force: bool = False) -> dict[str, Any]:
        """Remove one row of a component."""
        return wrap(lambda: b.remove_row(component, row_id, force))

    @srv.tool(annotations=write)
    def set_absorbs(component: str, port: str, modes: list[str], reason: str = "", force: bool = False) -> dict[str, Any]:
        """Say which failure modes stop at an input of a non-LLM component, with the reason (every failure passes through otherwise). modes=[] lets everything pass again."""
        return wrap(lambda: b.set_absorbs(component, port, modes, reason, force))

    @srv.tool(annotations=write)
    def drop_default(component: str, port: str, mode: str, reason: str, force: bool = False) -> dict[str, Any]:
        """Drop a worst-case default of an LLM component (on any message, mode at 10 on port), with the structural reason."""
        return wrap(lambda: b.drop_default(component, port, mode, reason, force))

    @srv.tool(annotations=write)
    def restore_default(component: str, port: str, mode: str, force: bool = False) -> dict[str, Any]:
        """Bring back a dropped worst-case default of an LLM component."""
        return wrap(lambda: b.restore_default(component, port, mode, force))

    @srv.tool(annotations=write)
    def put_guard(id: str | None = None, edge: str | None = None, label: str | None = None,  # noqa: A002
                  targets: list[dict[str, Any]] | None = None, version: str | None = None, learned: bool | None = None,
                  closed_output: bool | None = None, fp_omission: int | None = None, new_id: str | None = None, force: bool = False) -> dict[str, Any]:
        """Create a guard on an edge, or change the fields given. targets: [{mode, threshold, decidable} | {taint: true} | {conf: level} | {auth: level}]. learned: a classifier or LLM judge (never certifiable as never). closed_output: may wash taint."""
        return wrap(lambda: b.put_guard(force=force, id=id, edge=edge, label=label, targets=targets, version=version, learned=learned,
                                        closed_output=closed_output, fp_omission=fp_omission, new_id=new_id))

    @srv.tool(annotations=gone)
    def remove_guard(id: str, force: bool = False) -> dict[str, Any]:  # noqa: A002
        """Remove a guard."""
        return wrap(lambda: b.remove_guard(id, force))

    @srv.tool(annotations=write)
    def put_observation_point(id: str | None = None, edge: str | None = None, label: str | None = None, log: str | None = None,  # noqa: A002
                              tolerate: dict[str, int] | None = None, taint: str | None = None, clearance: str | None = None,
                              requires: str | None = None, new_id: str | None = None, force: bool = False) -> dict[str, Any]:
        """Create an observation point on an edge (one per edge; it judges every top-level mode at 1 unless tolerate says otherwise), or change the fields given. tolerate: {mode: lowest magnitude that counts}; taint: reject; clearance/requires: a level or receiver."""
        return wrap(lambda: b.put_observation_point(force=force, id=id, edge=edge, label=label, log=log, tolerate=tolerate, taint=taint,
                                                    clearance=clearance, requires=requires, new_id=new_id))

    @srv.tool(annotations=gone)
    def remove_observation_point(id: str, force: bool = False) -> dict[str, Any]:  # noqa: A002
        """Remove an observation point."""
        return wrap(lambda: b.remove_observation_point(id, force))

    @srv.tool(annotations=write)
    def put_use_case(id: str, entries: list[dict[str, Any]], label: str = "", force: bool = False) -> dict[str, Any]:  # noqa: A002
        """Create or replace a use case: entries [{port: system input name, token: {taint: bool, conf: level, auth: level, modes: {mode: magnitude}}}]."""
        return wrap(lambda: b.put_use_case(id, entries, label, force))

    @srv.tool(annotations=gone)
    def remove_use_case(id: str, force: bool = False) -> dict[str, Any]:  # noqa: A002
        """Remove a use case."""
        return wrap(lambda: b.remove_use_case(id, force))

    @srv.tool(annotations=write)
    def put_claim(cell: str, verdict: str = "guarantee", by: str = "", note: str | None = None, force: bool = False) -> dict[str, Any]:
        """Record that someone claims a verdict (guarantee, hope, exposed) for a cell (mode@point); the analysis judges the claim."""
        return wrap(lambda: b.put_claim(cell, verdict, by, note, force))

    @srv.tool(annotations=gone)
    def remove_claim(cell: str, by: str | None = None, force: bool = False) -> dict[str, Any]:
        """Remove the claim(s) about a cell (by one claimant, if given)."""
        return wrap(lambda: b.remove_claim(cell, by, force))

    @srv.tool(annotations=write)
    def set_model_settings(name: str | None = None, description: str | None = None, modes: list[Any] | None = None,
                           confidentiality: list[str] | None = None, authority: list[str] | None = None, force: bool = False) -> dict[str, Any]:
        """Change the model's name, description, failure modes (a list of names, or {mode: [sub-kinds]}) or the confidentiality and authority levels (low to high)."""
        return wrap(lambda: b.set_model_settings(force=force, name=name, description=description, modes=modes,
                                                 confidentiality=confidentiality, authority=authority))

    # ---- evidence
    @srv.tool(annotations=read)
    def list_evidence() -> dict[str, Any]:
        """The evidence register against the current model: every certificate and witness with its state (in force, rejected, stale, withdrawn) and reason, the decisions, the recognisers."""
        return wrap(b.list_evidence)

    @srv.tool(annotations=write)
    def add_certificate(certificate: dict[str, Any]) -> dict[str, Any]:
        """Add a certificate and say how the model classifies it. {id, component, targets: {target key: never|sometimes|always} (guards) or rows: {row id: ...}, version, issuer, date, method, scope: [use cases], context: {component: version}}. Never on an LLM row or a learned guard is rejected (the LLM rule)."""
        return wrap(lambda: b.add_certificate(certificate))

    @srv.tool(annotations=write)
    def add_witness(witness: dict[str, Any]) -> dict[str, Any]:
        """Add a witness written by hand: {id?, use_case?, date? (YYYY-MM-DD), source?, note?, at: {point: {modes: {mode: k | [lo, hi]}, taint: bool, conf: level, auth: level}}}. 0 means the failure was not there. Be as exact as the log is: a witness no run of the model can produce puts every cell in conflict."""
        return wrap(lambda: b.add_witness(witness))

    @srv.tool(annotations=write)
    def ingest_log(filename: str, text: str | None = None, path: str | None = None) -> dict[str, Any]:
        """Turn a log into witnesses with the workspace's recognisers (a demo case brings its own; a path may be relative to the open case's folder, e.g. data/statements/duna-bank-2026-10-15.csv)."""
        return wrap(lambda: b.ingest_log(filename, text, path))

    @srv.tool(annotations=write)
    def add_recogniser(name: str, text: str) -> dict[str, Any]:
        """Add a recogniser (YAML: id, format, files, match, use_case, date, rules with when and witness) to read logs with."""
        return wrap(lambda: b.add_recogniser(name, text))

    @srv.tool(annotations=write)
    def set_deployments(text: str) -> dict[str, Any]:
        """Set the deployment manifest (JSON: {changes: [{date, set: {component: version}}]}), which dates witnesses' versions."""
        return wrap(lambda: b.set_deployments(text))

    @srv.tool(annotations=write)
    def withdraw_certificate(certificate: str, by: str, reason: str) -> dict[str, Any]:
        """Record the decision to withdraw a certificate (it stays in the register as withdrawn; its rows are open again)."""
        return wrap(lambda: b.withdraw_certificate(certificate, by, reason))

    @srv.tool(annotations=write)
    def reject_witness(witness: str, by: str, second_reviewer: str, reason: str) -> dict[str, Any]:
        """Record the decision to reject a witness (the log is wrong); it takes two people and a reason."""
        return wrap(lambda: b.reject_witness(witness, by, second_reviewer, reason))

    @srv.tool(annotations=gone)
    def remove_evidence(id: str) -> dict[str, Any]:  # noqa: A002
        """Take a certificate or witness out of the workspace altogether (a decision to withdraw or reject is usually the better record)."""
        return wrap(lambda: b.remove_evidence(id))

    # ---- analysis
    @srv.tool(annotations=write)
    def run_analysis(cells: list[str] | None = None, rank: bool = True) -> dict[str, Any]:
        """Run the analysis (TLA+/TLC then clingo) on the workspace model and evidence; may take from a second to minutes. Returns every cell's verdict with a short reason, conflicts, what to certify next, re-verification and claims. cells limits it to some cells (mode@point)."""
        return wrap(lambda: b.run_analysis(cells, rank))

    @srv.tool(annotations=read)
    def get_verdict(cell: str) -> dict[str, Any]:
        """One cell of the last analysis in full: statuses, advice, reasons (structural, certificates it rests on, dropped defaults), conflicts and suspended certificates, candidates, root causes, evidence used."""
        return wrap(lambda: b.get_verdict(cell))

    @srv.tool(annotations=read)
    def explain_cell(cell: str, candidates: bool = False) -> dict[str, Any]:
        """A run of the model in which the failure reaches the point, round by round; with candidates=true also the remaining candidate assignments."""
        return wrap(lambda: b.explain_cell(cell, candidates))

    @srv.tool(annotations=read)
    def export_report(format: str = "markdown", path: str | None = None) -> dict[str, Any]:  # noqa: A002
        """The last analysis as a Markdown report or the CRA export (JSON); written to path if one is given."""
        return wrap(lambda: b.export_report(format, path))

    # ---- resources
    @srv.resource("epa://docs/model-format", name="model-format", title="The model document format", mime_type="text/markdown")
    def model_format() -> str:
        """How a model is written: components, ports, rows, guards, edges, use cases, observation points, claims, evidence."""
        return open(os.path.join(DOCS, "model-format.md"), encoding="utf-8").read()

    @srv.resource("epa://docs/user-guide", name="user-guide", title="The reasoner user guide", mime_type="text/markdown")
    def user_guide() -> str:
        """How the reasoner is used, step by step."""
        return open(os.path.join(DOCS, "user-guide.md"), encoding="utf-8").read()

    @srv.resource("epa://workspace/model.yaml", name="workspace-model", title="The model in the shared workspace", mime_type="text/yaml")
    def workspace_model() -> str:
        """The model the tools work on, as YAML."""
        ws = b.ws()
        return yaml.safe_dump(ws["doc"], sort_keys=False, allow_unicode=True, width=110) if ws["doc"] else "# no model in the workspace yet\n"

    return srv


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="python -m epa mcp", description="The Bimodal Agentic System Reasoner as an MCP server (stdio).")
    ap.add_argument("--workspace", help="the shared workspace file (default: <work>/workspace.json)")
    ap.add_argument("--work", help="the work folder for the run cache and TLC (default: EPA_WORK or .epa-work)")
    a = ap.parse_args(argv)
    build_server(Workbench(a.workspace, a.work)).run("stdio")
