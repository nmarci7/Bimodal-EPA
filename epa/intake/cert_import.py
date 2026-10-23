"""Certificates: records that state the activation of some rows of one component.

A certificate record (JSON):
  {"id": "c_gm", "component": "gm", "targets": {"oom": "never"}            # guard targets, or
                                    "rows": {"p_offmandate": "S"},          # rows by id
   "version": "mandate-v2", "issuer": "wallet team", "date": "2026-10-21",
   "method": "exhaustive mandate-scope test + review", "scope": ["pay"],
   "context": {"agent": "gpt-x-2026-05"},      # upstream versions at signing (re-verify list)
   "evidence": "link to the report"}
"""
from __future__ import annotations

import json

WORD = {"never": "N", "sometimes": "S", "always": "A", "n": "N", "s": "S", "a": "A",
        "N": "N", "S": "S", "A": "A"}


def load(src):
    data = json.load(open(src)) if isinstance(src, str) and not src.lstrip().startswith(("{", "[")) else (
        json.loads(src) if isinstance(src, str) else src)
    if isinstance(data, dict) and "certificates" in data:
        data = data["certificates"]
    return data if isinstance(data, list) else [data]


def resolve_rows(cert, m):
    """The certificate's statements as {row id: N|S|A}."""
    rows = {}
    comp = cert.get("component")
    for key, v in (cert.get("targets") or {}).items():
        rows[f"leak.{comp}.{key}"] = WORD.get(v, v)
    for key, v in (cert.get("rows") or {}).items():
        rid = key
        if rid not in m.rows:
            for cand in (f"{comp}.{key}", f"leak.{comp}.{key}", f"default.{comp}.{key}"):
                if cand in m.rows:
                    rid = cand
        rows[rid] = WORD.get(v, v)
    return rows


def classify(cert, m, withdrawn=()):
    """-> (state, reason, rows). state: in force | rejected | stale | withdrawn."""
    rows = resolve_rows(cert, m)
    comp = m.components.get(cert.get("component"))
    if cert.get("id") in withdrawn:
        return "withdrawn", "withdrawn by a recorded decision", rows
    if comp is None:
        return "rejected", f"unknown component {cert.get('component')!r}", rows
    if not rows:
        return "rejected", "states no row", rows
    for r, x in rows.items():
        row = m.rows.get(r)
        if row is None:
            return "rejected", f"unknown row {r}", rows
        if row.comp != comp.id:
            return "rejected", f"row {r} belongs to {row.comp}, not {comp.id}", rows
        if x not in ("N", "S", "A"):
            return "rejected", f"unknown activation {x!r} for {r}", rows
        if x == "N" and row.llm:
            what = "a learned guard" if comp.is_guard else "an LLM row"
            return "rejected", f"never on {what} ({r}): the LLM rule forbids it", rows
        if x == "N" and row.kind == "leak" and not row.decidable:
            return "rejected", f"never on a target that is not decidable from the edge ({r})", rows
    if comp.version is not None and cert.get("version") not in (None, comp.version):
        return "stale", f"{comp.id} is now {comp.version}, the certificate covers {cert.get('version')}", rows
    return "in force", "", rows


def reverify(cert, m):
    """Upstream components whose version changed since the certificate was signed."""
    out = []
    for cid, v in (cert.get("context") or {}).items():
        c = m.components.get(cid)
        if c is not None and c.version is not None and c.version != v:
            out.append({"component": cid, "signed_with": v, "now": c.version})
    return out
