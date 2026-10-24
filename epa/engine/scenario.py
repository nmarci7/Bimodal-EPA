"""Case folders and their scenarios: which model and which evidence files make up each stage.

cases/<case>/case.yaml:
  title, summary, figure, model: model.yaml, deployments: data/deployments.json,
  recognisers: [recognisers/*.yaml], lookup_files: [data/*.csv]
  stages:
    - id: S1
      label: the team certifies the two order guards
      model: model.yaml                   # optional: another model file from this stage on
      versions: {gm: mandate-v3}          # optional: a redeployment (versions only, rows unchanged)
      certificates: [certs/c_gd.json]
      logs: [data/statement-2026-10-15.csv]
      decisions: [{kind: withdraw-cert, certificate: c_gm, reason: ...}]
      carry: true                         # keep the evidence of earlier stages (default)
"""
from __future__ import annotations

import glob
import os

import yaml

from ..intake import cert_import, log_import
from ..model.load import load_model, read_document


def load_case(case_dir):
    return yaml.safe_load(open(os.path.join(case_dir, "case.yaml"), encoding="utf-8"))


def recognisers(case_dir, meta):
    out = []
    for pat in meta.get("recognisers", ["recognisers/*.yaml"]):
        for p in sorted(glob.glob(os.path.join(case_dir, pat))):
            out.append(log_import.load_recogniser(p))
    return out


def lookup_files(case_dir, meta):
    files = {}
    for pat in meta.get("lookup_files", ["data/*.csv", "data/*.json"]):
        for p in glob.glob(os.path.join(case_dir, pat)):
            files[os.path.basename(p)] = open(p, encoding="utf-8").read()
    return files


def apply_versions(doc, versions):
    """A stage may change component versions (a redeployment) without changing the model's rows."""
    if not versions:
        return doc
    doc = dict(doc)
    doc["components"] = [dict(c, version=versions.get(c["id"], c.get("version"))) for c in doc["components"]]
    doc["guards"] = [dict(g, version=versions.get(g["id"], g.get("version"))) for g in doc.get("guards", [])]
    return doc


def stage_inputs(case_dir, stage_id=None):
    """-> (model document, evidence dict, stage meta). Stages accumulate unless carry: false."""
    meta = load_case(case_dir)
    stages = meta.get("stages", [])
    model_path = meta.get("model", "model.yaml")
    deps = log_import.load_deployments(os.path.join(case_dir, meta["deployments"])) if meta.get("deployments") else None
    recs = recognisers(case_dir, meta)
    files = lookup_files(case_dir, meta)
    certs, wits, decisions, versions = [], [], [], {}
    chosen = None
    for st in stages:
        if not st.get("carry", True):
            certs, wits, decisions = [], [], []
        if st.get("model"):
            model_path = st["model"]
        versions.update(st.get("versions", {}))
        m = load_model(apply_versions(read_document(os.path.join(case_dir, model_path)), versions))
        for c in st.get("certificates", []):
            certs += cert_import.load(os.path.join(case_dir, c))
        for lg in st.get("logs", []):
            path = os.path.join(case_dir, lg)
            text = open(path, encoding="utf-8").read()
            for _, ws, _ in log_import.recognise_all(text, path, recs, m, deps, case_dir, files):
                wits += ws
        decisions += st.get("decisions", [])
        if stage_id is None or st["id"] == stage_id:
            chosen = st
            if stage_id is not None:
                break
    doc = apply_versions(read_document(os.path.join(case_dir, model_path)), versions)
    return doc, {"certificates": certs, "witnesses": wits, "decisions": decisions}, chosen
