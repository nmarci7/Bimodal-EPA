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
import hashlib
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
    if "eq_field" in cond:
        return str(v) == str(_get(r, cond["eq_field"]))
    if "ne_field" in cond:
        return str(v) != str(_get(r, cond["ne_field"]))
    if "nonempty" in cond:
        return bool(v) == bool(cond["nonempty"])
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


def _aggregate(recs_iter, rec):
    """With `group_by` and `aggregate: true`, rules see one record per group: the first record's
    fields, `_count` (how many lines share the key) and `_lines`."""
    groups, order = {}, []
    for line_no, r in recs_iter:
        k = str(_get(r, rec["group_by"]))
        if k not in groups:
            groups[k] = {**r, "_count": 0, "_lines": []}
            order.append(k)
        groups[k]["_count"] += 1
        groups[k]["_lines"].append(line_no)
    for k in order:
        yield groups[k]["_lines"][0], groups[k]


def witnesses_from_text(text, filename, rec, m=None, deployments=None, base_dir=".", files=None):
    """Apply one recogniser to one uploaded file. Returns (witnesses, unmatched line numbers)."""
    lookups = _lookups(rec, base_dir, files)
    deployments = deployments or {"changes": []}
    groups, order, unmatched = {}, [], []
    source = records(text, rec)
    aggregate = bool(rec.get("aggregate") and rec.get("group_by"))
    if aggregate:
        source = _aggregate(((i, r) for i, r in source if holds(rec.get("match"), r, lookups)), rec)
    stem = os.path.splitext(os.path.basename(filename))[0]
    for line_no, r in source:
        if not aggregate and not holds(rec.get("match"), r, lookups):
            continue
        for rule in rec["rules"]:
            if holds(rule.get("when"), r, lookups):
                at = _resolve_levels(rule["witness"], m)
                date_spec = rec.get("date", {"field": "date"})
                date = str(_get(r, date_spec["field"]) if isinstance(date_spec, dict) else date_spec or "")[:10]
                uc = rec.get("use_case")
                if isinstance(uc, dict):
                    uc = rec["use_case"].get("map", {}).get(str(_get(r, uc["field"])), _get(r, uc["field"]))
                if rec.get("id_field"):
                    key = str(_get(r, rec["id_field"]))
                elif rec.get("group_by") and not aggregate:
                    key = str(_get(r, rec["group_by"]))
                else:
                    key = f"{line_no}"
                if key not in groups:
                    wid = f"w_{rec.get('id_prefix', stem)}_{key}"
                    groups[key] = {"id": "".join(ch if ch.isalnum() else "_" for ch in wid),
                                   "use_case": uc, "at": {}, "date": date,
                                   "source": f"{os.path.basename(filename)} line {line_no}",
                                   "recogniser": rec["id"], "versions": versions_at(deployments, date),
                                   "rule": rule.get("label", ""), "lines": []}
                    order.append(key)
                w = groups[key]
                w["lines"] += r["_lines"] if aggregate else [line_no]
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


class WitnessError(ValueError):
    """A hand-entered witness that does not fit the model; .problems lists why."""
    def __init__(self, problems):
        super().__init__("; ".join(problems))
        self.problems = problems


def manual_witness(spec, m, deployments=None):
    """A witness entered by hand (in the workbench, or by an agent through the MCP server), checked
    against the model and shaped as a recogniser would shape it.

    spec: {id?, use_case?, date? (YYYY-MM-DD), source?, note?,
           at: {obs_id: {modes: {field: k | [lo, hi]}, taint: bool, conf: level | [lo, hi],
                         auth: level | [lo, hi], used: bool}}}
    A magnitude k means exactly k (0: the failure was not there); [lo, hi] a range the log cannot
    narrow. The versions are those in force on the date (deployment manifest), else the model's own.
    Raises WitnessError listing every problem.
    """
    p = []
    at_in = spec.get("at") or {}
    if not isinstance(at_in, dict) or not at_in:
        p.append("a witness logs at least one observation point")
        at_in = {}
    norm = {}
    for obs_id, logged in at_in.items():
        if obs_id not in m.obs:
            p.append(f"unknown observation point {obs_id!r}")
            continue
        logged = logged or {}
        x = {}
        for f, v in (logged.get("modes") or {}).items():
            if f not in m.fields:
                p.append(f"{obs_id}: unknown failure mode {f!r}")
                continue
            lo, hi = (v, v) if not isinstance(v, (list, tuple)) else (v[0], v[1])
            try:
                lo, hi = int(lo), int(hi)
            except (TypeError, ValueError):
                p.append(f"{obs_id}: the magnitude of {f} must be a number from 0 to 10")
                continue
            if not 0 <= lo <= hi <= 10:
                p.append(f"{obs_id}: the magnitude of {f} must lie in 0..10 (low <= high)")
                continue
            x.setdefault("modes", {})[f] = [lo, hi]
        if "taint" in logged and logged["taint"] is not None:
            x["taint"] = bool(logged["taint"])
        for k, levels in (("conf", m.conf_levels), ("auth", m.auth_levels)):
            v = logged.get(k)
            if v is None or v == "":
                continue
            pair = list(v) if isinstance(v, (list, tuple)) else [v, v]
            if any(lv not in levels for lv in pair if isinstance(lv, str)) or len(pair) != 2:
                p.append(f"{obs_id}: {k} must name levels of {levels}")
                continue
            x[k] = pair
        if "used" in logged and logged["used"] is not None:
            x["used"] = bool(logged["used"])
        if not x:
            p.append(f"{obs_id}: say what was seen there (a failure magnitude, taint, confidentiality or authority)")
        norm[obs_id] = x
    uc = spec.get("use_case") or None
    if uc and uc not in {u.id for u in m.use_cases}:
        p.append(f"unknown use case {uc!r}")
    date = str(spec.get("date") or "")[:10]
    if date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        p.append(f"the date {date!r} is not YYYY-MM-DD")
    if p:
        raise WitnessError(p)
    at = _resolve_levels(norm, m)
    if deployments and date:
        versions = versions_at(load_deployments(deployments), date)
    else:
        versions = {c.id: c.version for c in m.components.values() if c.version is not None}
    wid = spec.get("id") or "w_manual_" + hashlib.sha1(json.dumps([at, uc, date], sort_keys=True).encode()).hexdigest()[:6]
    wid = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in str(wid))
    return {"id": wid, "use_case": uc, "at": at, "date": date, "source": spec.get("source") or "entered by hand",
            "recogniser": "manual", "versions": versions, "rule": spec.get("note") or "", "lines": []}


def classify_witness(w, m, rejected=()):
    """-> (state, reason). in force | stale | rejected"""
    if w["id"] in rejected:
        return "rejected", "rejected by a recorded decision (second reviewer signed)"
    for obs_id in w["at"]:
        if obs_id not in m.obs:
            return "rejected", f"unknown observation point {obs_id}"
    if w.get("use_case") and w["use_case"] not in {u.id for u in m.use_cases}:
        return "rejected", f"unknown use case {w['use_case']}"
    from ..model.cone import upstream
    passed = set()
    for obs_id in w["at"]:
        passed |= upstream(m, m.obs[obs_id].edge)
    stale = []
    for cid, v in (w.get("versions") or {}).items():
        if cid not in passed:
            continue          # a witness is a run through the components upstream of what it logs
        c = m.components.get(cid)
        if c is not None and c.version is not None and c.version != v:
            stale.append(f"{cid} was {v}, now {c.version}")
    if stale:
        return "stale", "; ".join(stale)
    return "in force", ""


def recognise_all(text, filename, recognisers, m=None, deployments=None, base_dir=".", files=None):
    """Every recogniser whose `files` globs match the file name, applied in turn (one log can say
    several things, e.g. out-of-mandate lines and duplicates); falls back to the first that yields."""
    import fnmatch
    out = []
    for rec in recognisers:
        globs = rec.get("files", [])
        if globs and any(fnmatch.fnmatch(os.path.basename(filename), g) for g in globs):
            ws, un = witnesses_from_text(text, filename, rec, m, deployments, base_dir, files)
            out.append((rec, ws, un))
    if not out:
        rec, ws, un = recognise_any(text, filename, recognisers, m, deployments, base_dir, files)
        if rec is not None:
            out.append((rec, ws, un))
    return out


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
