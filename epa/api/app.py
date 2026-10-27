"""HTTP API and the analyst UI.

  uvicorn epa.api.app:app --port 8765        (or: python -m epa serve)

The browser holds the model and the evidence; the server parses, checks, translates and runs. Every
analysis streams its coordinator events (Server-Sent Events) so the UI can show the loop working.
"""
from __future__ import annotations

import json
import os
import platform
import threading
import time
import uuid

import clingo
import yaml
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import workspace as WS
from ..alethic import tlc_runner
from ..engine.cache import RunCache
from ..engine.coordinator import Engine
from ..epistemic.reason import candidate_space
from ..intake import bootstrap, cert_import, log_import, mcp_import
from ..model import cone as C
from ..model import wellformed
from ..model.load import ModelError, load_model, normalise, read_document, validate
from ..report import explain, markdown

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WEB = os.path.join(ROOT, "web")
CASES = os.path.join(ROOT, "cases")
WORK = os.environ.get("EPA_WORK", os.path.join(ROOT, ".epa-work"))
os.makedirs(WORK, exist_ok=True)
WORKSPACE = os.environ.get("EPA_WORKSPACE") or WS.default_path(WORK)

app = FastAPI(title="EPA engine v2", version="2.0")
CACHE = RunCache(os.path.join(WORK, "runs.sqlite"))
ANALYSES = {}
RUN_LOCK = threading.Lock()


# ---------------------------------------------------------------------------- helpers
def _model(doc):
    try:
        return load_model(doc)
    except ModelError as e:
        raise HTTPException(status_code=422, detail={"problems": e.problems})


def _case_dir(case):
    d = os.path.join(CASES, case)
    if not os.path.isdir(d) or os.path.sep in case or case.startswith("."):
        raise HTTPException(404, "no such case")
    return d


# ---------------------------------------------------------------------------- health and cases
@app.get("/api/health")
def health():
    ok, ver = tlc_runner.java_ok()
    try:
        jar = tlc_runner.find_jar()
    except FileNotFoundError:
        jar = None
    return {"java": ok, "java_version": ver, "tla2tools": jar, "clingo": clingo.__version__,
            "python": platform.python_version(), "work": WORK}


@app.get("/api/cases")
def cases():
    out = []
    for name in sorted(os.listdir(CASES)):
        meta_path = os.path.join(CASES, name, "case.yaml")
        if os.path.exists(meta_path):
            meta = yaml.safe_load(open(meta_path))
            out.append({"id": name, **{k: meta.get(k) for k in ("title", "summary", "figure", "order")}})
    out.sort(key=lambda c: c.get("order") or 99)
    return out


@app.get("/api/cases/{case}")
def case(case: str):
    d = _case_dir(case)
    meta = yaml.safe_load(open(os.path.join(d, "case.yaml")))
    files = []
    for base, _, names in os.walk(d):
        for n in sorted(names):
            rel = os.path.relpath(os.path.join(base, n), d)
            if not n.startswith("."):
                files.append(rel)
    model_text = open(os.path.join(d, meta.get("model", "model.yaml")), encoding="utf-8").read()
    return {"id": case, "meta": meta, "model_text": model_text, "model": read_document(model_text),
            "files": sorted(files)}


@app.get("/api/cases/{case}/file")
def case_file(case: str, path: str):
    d = _case_dir(case)
    full = os.path.abspath(os.path.join(d, path))
    if not full.startswith(d + os.sep) or not os.path.isfile(full):
        raise HTTPException(404, "no such file")
    return PlainTextResponse(open(full, encoding="utf-8").read())


@app.get("/api/cases/{case}/figure")
def case_figure(case: str):
    d = _case_dir(case)
    meta = yaml.safe_load(open(os.path.join(d, "case.yaml")))
    if not meta.get("figure"):
        raise HTTPException(404, "no figure")
    return FileResponse(os.path.join(d, meta["figure"]))


# ---------------------------------------------------------------------------- model
class Text(BaseModel):
    text: str


class Doc(BaseModel):
    doc: dict


@app.post("/api/model/parse")
def model_parse(body: Text):
    try:
        doc = read_document(body.text)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, detail={"problems": [f"cannot read the document: {e}"]})
    return {"doc": doc, "problems": validate(doc) if isinstance(doc, dict) else ["not a mapping"]}


@app.post("/api/model/check")
def model_check(body: Doc):
    problems = validate(body.doc)
    if problems:
        return {"ok": False, "problems": problems}
    try:
        m = load_model(body.doc)
    except ModelError as e:
        return {"ok": False, "problems": e.problems}
    cells = C.cells(m)
    cones = []
    for c in cells:
        k = C.cone_of_cell(m, c)
        cones.append({"cell": c.id, "rows": k.rows, "fields": k.fields, "components": k.components,
                      "candidates": candidate_space(m, k.rows), "runs": (2 ** len(k.rows)) * max(1, len(k.use_cases))})
    return {"ok": True, "problems": [], "summary": m.summary(), "cells": cones,
            "absorbed": wellformed.absorbed(m), "decisions": m.decisions}


@app.post("/api/model/yaml")
def model_yaml(body: Doc):
    return PlainTextResponse(yaml.safe_dump(body.doc, sort_keys=False, allow_unicode=True, width=110))


# ---------------------------------------------------------------------------- evidence intake
class LogUpload(BaseModel):
    doc: dict
    filename: str
    text: str
    recognisers: list[str]
    deployments: str | None = None
    lookups: dict = {}


@app.post("/api/evidence/logs")
def evidence_logs(body: LogUpload):
    m = _model(body.doc)
    recs = [log_import.load_recogniser(r) for r in body.recognisers]
    deps = log_import.load_deployments(body.deployments) if body.deployments else None
    try:
        found = log_import.recognise_all(body.text, body.filename, recs, m, deps, files=body.lookups)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, detail={"problems": [str(e)]})
    if not found:
        return {"recognisers": [], "witnesses": [], "unmatched": [], "note": "no recogniser matched this file"}
    ws_all, unmatched = [], []
    for rec, ws, un in found:
        for w in ws:
            w["state"], w["reason"] = log_import.classify_witness(w, m)
        ws_all += ws
        unmatched += [{"recogniser": rec["id"], "line": n} for n in un]
    return {"recognisers": [r["id"] for r, _, _ in found], "witnesses": ws_all, "unmatched": unmatched}


@app.get("/api/cases/{case}/bundle")
def case_bundle(case: str):
    """Everything the UI needs to work on a case: the model text, the recognisers, the deployment
    manifest and lookup files (loaded silently), and the evidence files the analyst can upload."""
    import glob
    from ..engine.scenario import load_case
    d = _case_dir(case)
    meta = load_case(d)

    def rel(p):
        return os.path.relpath(p, d)

    recs = {}
    for pat in meta.get("recognisers", ["recognisers/*.yaml"]):
        for p in sorted(glob.glob(os.path.join(d, pat))):
            recs[rel(p)] = open(p, encoding="utf-8").read()
    lookups = {}
    for pat in meta.get("lookup_files", ["data/*.csv", "data/*.json"]):
        for p in sorted(glob.glob(os.path.join(d, pat))):
            if os.path.basename(p) != os.path.basename(meta.get("deployments", "")):
                lookups[os.path.basename(p)] = open(p, encoding="utf-8").read()
    deps = open(os.path.join(d, meta["deployments"]), encoding="utf-8").read() if meta.get("deployments") else None
    logs, certs, models, intake = [], [], [], []
    for base, _, names in os.walk(d):
        for n in sorted(names):
            p = os.path.join(base, n)
            r = rel(p)
            if r.startswith("certs/"):
                certs.append(r)
            elif r.startswith("intake/"):
                intake.append(r)
            elif r.startswith("data/") and os.path.basename(p) not in lookups and r != meta.get("deployments"):
                logs.append(r)
            elif r.endswith((".yaml", ".yml")) and r.startswith("model"):
                models.append(r)
    return {"id": case, "meta": meta, "model_text": open(os.path.join(d, meta.get("model", "model.yaml")),
                                                         encoding="utf-8").read(),
            "models": sorted(models), "recognisers": recs, "deployments": deps, "lookups": lookups,
            "logs": sorted(logs), "certificates": sorted(certs), "intake": sorted(intake),
            "stages": meta.get("stages", [])}


@app.get("/api/cases/{case}/stages/{stage}")
def case_stage(case: str, stage: str):
    """The model and the evidence of one scenario stage, as the analyst would have assembled them."""
    from ..engine.scenario import stage_inputs
    d = _case_dir(case)
    doc, ev, st = stage_inputs(d, stage)
    return {"doc": doc, "evidence": ev, "stage": st}


class CertUpload(BaseModel):
    doc: dict
    text: str


@app.post("/api/evidence/certificates")
def evidence_certs(body: CertUpload):
    m = _model(body.doc)
    out = []
    for c in cert_import.load(body.text):
        state, reason, rows = cert_import.classify(c, m)
        out.append({**c, "state": state, "reason": reason, "resolved": rows, "reverify": cert_import.reverify(c, m)})
    return {"certificates": out}


class WitnessIn(BaseModel):
    doc: dict
    witness: dict
    deployments: str | None = None


@app.post("/api/evidence/witness")
def evidence_witness(body: WitnessIn):
    """A witness entered by hand: shaped as a recogniser would shape it, then classified."""
    m = _model(body.doc)
    try:
        w = log_import.manual_witness(body.witness, m, body.deployments)
    except log_import.WitnessError as e:
        raise HTTPException(422, detail={"problems": e.problems})
    w["state"], w["reason"] = log_import.classify_witness(w, m)
    return {"witness": w}


class EvidenceReq(BaseModel):
    doc: dict
    evidence: dict = {}


@app.post("/api/evidence/register")
def evidence_register(body: EvidenceReq):
    """The evidence register against the current model: every certificate and witness with its state."""
    m = _model(body.doc)
    return Engine(m, WORK, cache=CACHE).register(body.evidence)


class Boot(BaseModel):
    traces: str
    tools: str | None = None
    answers: str | None = None
    name: str = "bootstrapped"
    server: str = ""
    server_trust: bool = False


@app.post("/api/bootstrap")
def do_bootstrap(body: Boot):
    skel = bootstrap.skeleton_from_traces(bootstrap.read_spans(body.traces))
    if body.tools:
        server = body.server
        if server not in skel["components"]:
            # the traced component that stands for the MCP server: the one named after it
            server = next((c for c in skel["components"] if "mcp" in c.lower()), server)
        skel = bootstrap.skeleton_from_mcp(mcp_import.read_tools_list(body.tools), skel, server=server,
                                           server_trust=body.server_trust)
    out = {"skeleton": skel, "questions": bootstrap.questionnaire(skel)}
    if body.answers:
        try:
            doc = bootstrap.apply_answers(skel, yaml.safe_load(body.answers), body.name)
            out["doc"] = doc
            out["problems"] = validate(doc)
        except Exception as e:  # noqa: BLE001
            out["problems"] = [str(e)]
    return out


# ---------------------------------------------------------------------------- the shared workspace
# The model and evidence the MCP server works on (python -m epa mcp); the workbench can open it, or
# save its own model there for an assistant to work on (epa/workspace.py).
@app.get("/api/workspace/meta")
def workspace_meta():
    return {**WS.meta(WORKSPACE), "path": WORKSPACE}


@app.get("/api/workspace")
def workspace_get():
    ws = WS.load(WORKSPACE)
    if not ws["doc"]:
        raise HTTPException(404, "the shared workspace is empty: an MCP client fills it (python -m epa mcp), "
                                 "or save a model there from the workbench")
    return {k: ws[k] for k in ("doc", "evidence", "case", "stage", "updated", "by")}


class WorkspaceIn(BaseModel):
    doc: dict
    evidence: dict = {}
    case: str | None = None
    stage: str | None = None


@app.put("/api/workspace")
def workspace_put(body: WorkspaceIn):
    keep = ("certificates", "witnesses", "decisions", "recognisers", "deployments", "lookups", "files")
    ev = {**WS.empty_evidence(), **{k: v for k, v in body.evidence.items() if k in keep}}
    WS.save(WORKSPACE, {"doc": body.doc, "evidence": ev, "case": body.case, "stage": body.stage, "report": None}, "browser")
    return {**WS.meta(WORKSPACE), "path": WORKSPACE}


# ---------------------------------------------------------------------------- analyses
class AnalysisReq(BaseModel):
    doc: dict
    evidence: dict = {}
    cells: list[str] | None = None
    rank: bool = True
    label: str = ""


@app.post("/api/analyses")
def start_analysis(body: AnalysisReq):
    m = _model(body.doc)
    aid = uuid.uuid4().hex[:10]
    st = {"id": aid, "status": "running", "events": [], "report": None, "error": None,
          "model": m, "evidence": body.evidence, "label": body.label, "started": time.time(), "engine": None}
    ANALYSES[aid] = st

    def on_event(e):
        st["events"].append(e)

    def work():
        with RUN_LOCK:
            try:
                eng = Engine(m, WORK, on_event=on_event, cache=CACHE)
                st["engine"] = eng
                rep = eng.analyse(body.evidence, only_cells=body.cells, rank=body.rank)
                rep["id"] = aid
                rep["label"] = body.label
                st["report"] = rep
                st["status"] = "done"
            except Exception as ex:  # noqa: BLE001
                import traceback
                st["status"] = "error"
                st["error"] = f"{ex}\n{traceback.format_exc()[-2000:]}"
                st["events"].append({"step": "error", "msg": str(ex)})
    threading.Thread(target=work, daemon=True).start()
    return {"id": aid}


@app.get("/api/analyses/{aid}/events")
def analysis_events(aid: str):
    st = ANALYSES.get(aid)
    if st is None:
        raise HTTPException(404)

    def gen():
        i = 0
        while True:
            evs = st["events"]
            while i < len(evs):
                yield f"data: {json.dumps(evs[i])}\n\n"
                i += 1
            if st["status"] != "running" and i >= len(st["events"]):
                break
            time.sleep(0.1)
        yield f"event: end\ndata: {json.dumps({'status': st['status'], 'error': st['error']})}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/analyses/{aid}")
def analysis(aid: str):
    st = ANALYSES.get(aid)
    if st is None:
        raise HTTPException(404)
    return JSONResponse({"id": aid, "status": st["status"], "error": st["error"], "report": st["report"],
                         "events": st["events"]}, )


def _engine(aid):
    st = ANALYSES.get(aid)
    if st is None or st["status"] != "done":
        raise HTTPException(404, "analysis not ready")
    return st, Engine(st["model"], WORK, cache=CACHE)


@app.get("/api/analyses/{aid}/cells/{cell}/possibilities")
def possibilities(aid: str, cell: str):
    st, eng = _engine(aid)
    with RUN_LOCK:
        return eng.possibilities(cell, st["evidence"])


@app.get("/api/analyses/{aid}/cells/{cell}/trace")
def cell_trace(aid: str, cell: str):
    st, eng = _engine(aid)
    res = next((c for c in st["report"]["cells"] if c["cell"] == cell), None)
    if res is None or not res.get("example_run"):
        return {"cell": cell, "story": [], "note": "no run reaches the point in a remaining candidate"}
    ex = res["example_run"]
    with RUN_LOCK:
        tr = eng.trace_of(cell, ex["uc"], frozenset(ex["fire"]))
    cone_fields = res.get("fields", [])
    return {"cell": cell, "run": ex, "story": explain.trace_story(st["model"], tr, cone_fields)}


@app.get("/api/analyses/{aid}/cells/{cell}/asp")
def cell_asp(aid: str, cell: str):
    st, eng = _engine(aid)
    m = st["model"]
    cone = next(k for k in C.cones(m, C.cells(m)) if cell in k.cell_rows)
    reg = eng.register(st["evidence"])
    with RUN_LOCK:
        eng.ensure(cone, [{}])
        prob, _, _ = eng.problem(cone, C.Cell.parse(cell),
                                 [c for c in reg["certificates"] if c["state"] == "in force"],
                                 [w for w in reg["witnesses"] if w["state"] == "in force"])
    return PlainTextResponse(prob.program_text())


@app.get("/api/tla/{h}")
def tla(h: str):
    d = os.path.join(WORK, "tlc", os.path.basename(h))
    if not os.path.isdir(d):
        raise HTTPException(404)
    return {"module": open(os.path.join(d, "Cone.tla")).read(), "cfg": open(os.path.join(d, "Cone.cfg")).read(),
            "library": open(os.path.join(d, "EpaLib.tla")).read(),
            "stats": open(os.path.join(d, "stats.txt")).read()[-3000:]}


@app.get("/api/analyses/{aid}/report.md")
def report_md(aid: str):
    st = ANALYSES.get(aid)
    if st is None or not st["report"]:
        raise HTTPException(404)
    return PlainTextResponse(markdown.report(st["report"]), media_type="text/markdown")


@app.get("/api/analyses/{aid}/cra.json")
def report_cra(aid: str):
    st = ANALYSES.get(aid)
    if st is None or not st["report"]:
        raise HTTPException(404)
    return markdown.cra_export(st["report"])


# ---------------------------------------------------------------------------- the UI
@app.middleware("http")
async def revalidate_ui(request, call_next):
    """The browser asks again for every UI file (a 304 when it is unchanged), so a new version of the
    workbench is never shown half old, half new from the cache."""
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/web/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


if os.path.isdir(WEB):
    app.mount("/web", StaticFiles(directory=WEB), name="web")


@app.get("/")
def index():
    return FileResponse(os.path.join(WEB, "index.html"))
