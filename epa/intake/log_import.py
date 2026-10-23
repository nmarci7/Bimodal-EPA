"""Logs, traces and statements -> witnesses, through recognisers.

A recogniser is a small YAML file that says how one kind of log line becomes a witness: the format
(csv, jsonl, json, regex), which lines it applies to, the use case, the date, lookup lists, and rules
whose first match decides which fields the witness logs at which observation points. Every witness
records the file, the line and the recogniser it came from, and the component versions in force on
its date (from the deployment manifest), so a stale or mislabelled witness can be traced.

Example:
  id: bank-statement-v1
  format: csv
  use_case: pay
  date: {field: booking_date}
  lookups: {mandate: {file: mandate.csv, column: iban}}
  rules:
    - when: {field: creditor_iban, not_in: mandate}
      witness: {o_statement: {modes: {oom: [1, 10]}}}
    - when: {field: creditor_iban, in: mandate}
      witness: {o_statement: {modes: {oom: [0, 0]}}}
"""
from __future__ import annotations

import csv
import io
import json
import os
import re

import yaml


def load_recogniser(src):
    if isinstance(src, dict):
        return src
    if "\n" in src:
        return yaml.safe_load(src)
    with open(src, encoding="utf-8") as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# deployment manifest: which component versions were in force on a date
# ---------------------------------------------------------------------------

def load_deployments(src):
    if src is None:
        return {"changes": []}
    if isinstance(src, dict):
        return src
    text = open(src).read() if "\n" not in src and os.path.exists(src) else src
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return yaml.safe_load(text)


def versions_at(deployments, date):
    v = {}
    for ch in sorted(deployments.get("changes", []), key=lambda c: c["date"]):
        if str(ch["date"]) <= str(date)[:10]:
            v.update(ch["set"])
    return v


# ---------------------------------------------------------------------------
# reading records
# ---------------------------------------------------------------------------

def records(text, rec):
    fmt = rec.get("format", "jsonl")
    if fmt == "csv":
        for i, row in enumerate(csv.DictReader(io.StringIO(text), delimiter=rec.get("delimiter", ",")), start=2):
            yield i, {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in row.items() if k}
    elif fmt == "jsonl":
        for i, line in enumerate(text.splitlines(), start=1):
            if line.strip():
                yield i, json.loads(line)
    elif fmt == "json":
        data = json.loads(text)
        items = data.get(rec.get("items", "items"), []) if isinstance(data, dict) else data
        for i, it in enumerate(items, start=1):
            yield i, it
    elif fmt == "regex":
        pat = re.compile(rec["pattern"])
        for i, line in enumerate(text.splitlines(), start=1):
            mt = pat.search(line)
            if mt:
                yield i, mt.groupdict()
    else:
        raise ValueError(f"unknown format {fmt}")


def _get(rec, path):
    cur = rec
    for part in str(path).split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def holds(cond, r, lookups):
    if cond is None:
        return True
    if "all" in cond:
        return all(holds(c, r, lookups) for c in cond["all"])
    if "any" in cond:
        return any(holds(c, r, lookups) for c in cond["any"])
    if "not" in cond:
        return not holds(cond["not"], r, lookups)
    v = _get(r, cond["field"])
    if "eq" in cond:
        return str(v) == str(cond["eq"])
    if "ne" in cond:
        return str(v) != str(cond["ne"])
    if "in" in cond:
        S = lookups.get(cond["in"]) if isinstance(cond["in"], str) else {str(x) for x in cond["in"]}
        if isinstance(v, list):
            return all(str(x) in S for x in v)
        return str(v) in S
    if "not_in" in cond:
        S = lookups.get(cond["not_in"]) if isinstance(cond["not_in"], str) else {str(x) for x in cond["not_in"]}
        if isinstance(v, list):
            return any(str(x) not in S for x in v)
        return str(v) not in S
    if "contains" in cond:
        return v is not None and str(cond["contains"]) in (v if isinstance(v, list) else str(v))
    if "regex" in cond:
        return v is not None and re.search(cond["regex"], str(v)) is not None
    for op, f in (("gt", lambda a, b: a > b), ("ge", lambda a, b: a >= b),
                  ("lt", lambda a, b: a < b), ("le", lambda a, b: a <= b)):
        if op in cond:
            a, b = _num(v), _num(cond[op])
            return a is not None and b is not None and f(a, b)
    if "exists" in cond:
        return (v is not None and v != "") == bool(cond["exists"])
    raise ValueError(f"unknown condition {cond}")


def _lookups(rec, base_dir, files=None):
    out = {}
    for name, spec in (rec.get("lookups") or {}).items():
        if "values" in spec:
            out[name] = {str(x) for x in spec["values"]}
            continue
        path = spec["file"]
        text = (files or {}).get(os.path.basename(path))
        if text is None:
            with open(os.path.join(base_dir, path), encoding="utf-8") as f:
                text = f.read()
        if path.endswith(".csv"):
            out[name] = {row[spec["column"]].strip() for row in csv.DictReader(io.StringIO(text))}
        else:
            data = json.loads(text)
            out[name] = {str(x) for x in (data[spec["key"]] if "key" in spec else data)}
    return out


def _resolve_levels(at, m):
    out = {}
    for obs_id, logged in at.items():
        x = dict(logged)
        if "modes" in x:
            x["modes"] = {k: [int(v[0]), int(v[1])] if isinstance(v, (list, tuple)) else [int(v), int(v)]
                          for k, v in x["modes"].items()}
        for k, levels in (("conf", m.conf_levels if m else None), ("auth", m.auth_levels if m else None)):
            if k in x and levels is not None:
                v = x[k]
                if isinstance(v, str):
                    x[k] = [levels.index(v), levels.index(v)]
                elif isinstance(v, (list, tuple)):
                    x[k] = [levels.index(v[0]) if isinstance(v[0], str) else v[0],
                            levels.index(v[1]) if isinstance(v[1], str) else v[1]]
        out[obs_id] = x
    return out


def witnesses_from_text(text, filename, rec, m=None, deployments=None, base_dir=".", files=None):
    """Apply one recogniser to one uploaded file. Returns (witnesses, unmatched line numbers)."""
    lookups = _lookups(rec, base_dir, files)
    deployments = deployments or {"changes": []}
    groups, order, unmatched = {}, [], []
    for line_no, r in records(text, rec):
        if not holds(rec.get("match"), r, lookups):
            continue
        for rule in rec["rules"]:
            if holds(rule.get("when"), r, lookups):
                at = _resolve_levels(rule["witness"], m)
                date_spec = rec.get("date", {"field": "date"})
                date = str(_get(r, date_spec["field"]) if isinstance(date_spec, dict) else date_spec or "")[:10]
                uc = rec.get("use_case")
                if isinstance(uc, dict):
                    uc = rec["use_case"].get("map", {}).get(str(_get(r, uc["field"])), _get(r, uc["field"]))
                key = str(_get(r, rec["group_by"])) if rec.get("group_by") else f"{line_no}"
                stem = os.path.splitext(os.path.basename(filename))[0]
                if key not in groups:
                    groups[key] = {"id": f"w_{stem}_{key}".replace("-", "_").replace(".", "_"),
                                   "use_case": uc, "at": {}, "date": date,
                                   "source": f"{os.path.basename(filename)} line {line_no}",
                                   "recogniser": rec["id"], "versions": versions_at(deployments, date),
                                   "rule": rule.get("label", ""), "lines": []}
                    order.append(key)
                w = groups[key]
                w["lines"].append(line_no)
                for obs_id, logged in at.items():
                    cur = w["at"].setdefault(obs_id, {})
                    for k, v in logged.items():
                        if k == "modes":
                            cur.setdefault("modes", {}).update(v)
                        else:
                            cur[k] = v
                break
        else:
            unmatched.append(line_no)
    return [groups[k] for k in order], unmatched


def classify_witness(w, m, rejected=()):
    """-> (state, reason). in force | stale | rejected"""
    if w["id"] in rejected:
        return "rejected", "rejected by a recorded decision (second reviewer signed)"
    for obs_id in w["at"]:
        if obs_id not in m.obs:
            return "rejected", f"unknown observation point {obs_id}"
    if w.get("use_case") and w["use_case"] not in {u.id for u in m.use_cases}:
        return "rejected", f"unknown use case {w['use_case']}"
    stale = []
    for cid, v in (w.get("versions") or {}).items():
        c = m.components.get(cid)
        if c is not None and c.version is not None and c.version != v:
            stale.append(f"{cid} was {v}, now {c.version}")
    if stale:
        return "stale", "; ".join(stale)
    return "in force", ""


def recognise_any(text, filename, recognisers, m=None, deployments=None, base_dir=".", files=None):
    """Pick the recogniser whose `files` glob matches the file name (or the first that yields witnesses)."""
    import fnmatch
    for rec in recognisers:
        globs = rec.get("files", [])
        if globs and any(fnmatch.fnmatch(os.path.basename(filename), g) for g in globs):
            ws, un = witnesses_from_text(text, filename, rec, m, deployments, base_dir, files)
            return rec, ws, un
    for rec in recognisers:
        try:
            ws, un = witnesses_from_text(text, filename, rec, m, deployments, base_dir, files)
        except Exception:  # noqa: BLE001 - a recogniser for another format
            continue
        if ws:
            return rec, ws, un
    return None, [], []
