"""Edits of a model document, for callers that are not the browser (the MCP server).

Each function changes the document (a dict in the format of docs/model-format.md) in place and
returns a short note of what it did. It refuses what can never be right (an unknown component, a
duplicate id) with an EditError; everything else is left to the model check (validate and
load_model), which the caller runs afterwards, so the rules live in one place. The functions mirror
what the reasoner does in web/state.js and web/modeldialogs.js: wiring creates the ports it names,
renaming a component or a port follows the edges and rows that use it, removing a component removes
its edges and the guards and observation points on them.
"""
from __future__ import annotations

import copy
import re

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ROW_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")
KINDS = ("llm", "deterministic", "tool", "store", "external", "user")
COMPONENT_FIELDS = ("kind", "label", "version", "authority", "clearance", "requires", "trusted", "taint", "raises", "flow")
GUARD_FIELDS = ("label", "edge", "version", "learned", "closed_output", "fp_omission", "targets")
OBS_FIELDS = ("label", "edge", "log", "tolerate", "taint", "tolerate_taint", "clearance", "requires")


class EditError(ValueError):
    """An edit that cannot apply to this document."""


# ---------------------------------------------------------------- lookups
def ensure_lists(doc):
    for k in ("components", "guards", "edges", "use_cases", "observation_points", "claims"):
        doc.setdefault(k, [])
    doc.setdefault("layout", {}).setdefault("sys", {})
    for c in doc["components"]:
        c.setdefault("in", []), c.setdefault("out", []), c.setdefault("rows", [])
    return doc


def component(doc, cid):
    c = next((c for c in doc["components"] if c["id"] == cid), None)
    if c is None:
        raise EditError(f"no component {cid!r}; components: {', '.join(x['id'] for x in doc['components']) or 'none'}")
    return c


def _edge(doc, eid):
    e = next((e for e in doc["edges"] if e["id"] == eid), None)
    if e is None:
        raise EditError(f"no edge {eid!r}; edges: {', '.join(x['id'] for x in doc['edges']) or 'none'}")
    return e


def ids_in_use(doc):
    """Components and guards share one name space (and 'sys' is reserved)."""
    return {c["id"] for c in doc["components"]} | {g["id"] for g in doc["guards"]} | {"sys"}


def fresh(base, taken):
    s = re.sub(r"[^A-Za-z0-9_]", "_", base)
    if not re.match(r"^[A-Za-z_]", s):
        s = "x_" + s
    if s not in taken:
        return s
    i = 2
    while f"{s}{i}" in taken:
        i += 1
    return f"{s}{i}"


def top_modes(doc):
    out = []
    for m in doc.get("modes") or []:
        if isinstance(m, str):
            out.append(m)
        elif isinstance(m, dict):
            out.append(m["name"] if "name" in m else next(iter(m)))
    return out


def sys_ports(doc):
    ins, outs = set(), set()
    for e in doc["edges"]:
        if str(e.get("from", "")).startswith("sys."):
            ins.add(e["from"][4:])
        if str(e.get("to", "")).startswith("sys."):
            outs.add(e["to"][4:])
    for name, v in (doc.get("layout", {}).get("sys") or {}).items():
        (ins if v.get("dir") == "in" else outs if v.get("dir") == "out" else set()).add(name)
    return ins, outs


def _split(ref):
    if not isinstance(ref, str) or "." not in ref:
        raise EditError(f"a port is written component.port or sys.name, not {ref!r}")
    a, b = ref.split(".", 1)
    return a, b


# ---------------------------------------------------------------- components
def put_component(doc, spec):
    """Create a component, or change the fields given (rename with new_id)."""
    ensure_lists(doc)
    cid = spec.get("id")
    if not cid:
        raise EditError("a component needs an id")
    there = next((c for c in doc["components"] if c["id"] == cid), None)
    if spec.get("kind") is not None and spec["kind"] not in KINDS:
        raise EditError(f"kind must be one of {', '.join(KINDS)}")
    if there is None:
        if not IDENT.match(cid) or cid in ids_in_use(doc):
            raise EditError(f"{cid!r} is not a free identifier")
        if not spec.get("kind"):
            raise EditError("a new component needs a kind: " + ", ".join(KINDS))
        c = {"id": cid, "kind": spec["kind"], "label": spec.get("label", ""), "in": list(spec.get("inputs") or []),
             "out": list(spec.get("outputs") or []), "rows": []}
        doc["components"].append(c)
        note = f"added {spec['kind']} component {cid}"
    else:
        c = there
        note = f"changed component {cid}"
        for p in spec.get("inputs") or []:
            if p not in c["in"]:
                c["in"].append(p)
        for q in spec.get("outputs") or []:
            if q not in c["out"]:
                c["out"].append(q)
    for k in COMPONENT_FIELDS:
        if k in spec and k != "kind":
            if spec[k] is None:
                c.pop(k, None)
            else:
                c[k] = spec[k]
    if spec.get("kind"):
        c["kind"] = spec["kind"]
    if spec.get("new_id") and spec["new_id"] != c["id"]:
        rename_component(doc, c["id"], spec["new_id"])
        note += f", renamed to {spec['new_id']}"
    return note


def rename_component(doc, old, new):
    if not IDENT.match(new) or new in ids_in_use(doc):
        raise EditError(f"{new!r} is not a free identifier")
    component(doc, old)["id"] = new
    for e in doc["edges"]:
        for end in ("from", "to"):
            a, b = _split(e[end])
            if a == old:
                e[end] = f"{new}.{b}"


def remove_component(doc, cid):
    component(doc, cid)
    gone = [e["id"] for e in doc["edges"] if _split(e["from"])[0] == cid or _split(e["to"])[0] == cid]
    doc["components"] = [c for c in doc["components"] if c["id"] != cid]
    _drop_edges(doc, gone)
    return f"removed component {cid} and {len(gone)} edge(s)"


def _drop_edges(doc, ids):
    ids = set(ids)
    doc["edges"] = [e for e in doc["edges"] if e["id"] not in ids]
    doc["guards"] = [g for g in doc["guards"] if g.get("edge") not in ids]
    doc["observation_points"] = [o for o in doc["observation_points"] if o.get("edge") not in ids]


# ---------------------------------------------------------------- wiring
def connect(doc, source, target, label="", edge_id=None):
    """An edge from source (component.port or sys.name) to target; missing ports are created. As in the
    reasoner, the first wire out of a system input gives the model its first use case."""
    ensure_lists(doc)
    (fa, fp), (ta, tp) = _split(source), _split(target)
    if fa == "sys" and ta == "sys":
        raise EditError("two system ports cannot be wired directly")
    if fa == ta:
        raise EditError("a component cannot be wired to itself; add a store or a loop component")
    ins, outs = sys_ports(doc)
    notes = []
    if fa == "sys":
        if fp in outs:
            raise EditError(f"sys.{fp} is a system output: it only receives")
        doc["layout"]["sys"].setdefault(fp, {})["dir"] = "in"
    else:
        c = component(doc, fa)
        if fp not in c["out"]:
            c["out"].append(fp)
            if c.get("flow") is not None:
                for p in c["in"]:
                    c["flow"].setdefault(p, []).append(fp)
            notes.append(f"output port {fa}.{fp}")
    if ta == "sys":
        if tp in ins:
            raise EditError(f"sys.{tp} is a system input: it only sends")
        doc["layout"]["sys"].setdefault(tp, {})["dir"] = "out"
    else:
        c = component(doc, ta)
        if tp not in c["in"]:
            c["in"].append(tp)
            if c.get("flow") is not None:
                c["flow"][tp] = list(c["out"])
            notes.append(f"input port {ta}.{tp}")
    if any(e["from"] == source and e["to"] == target for e in doc["edges"]):
        raise EditError(f"{source} and {target} are already wired")
    eid = edge_id or fresh(f"e_{fa if fa != 'sys' else fp}_{ta if ta != 'sys' else tp}", {e["id"] for e in doc["edges"]})
    if any(e["id"] == eid for e in doc["edges"]):
        raise EditError(f"there is already an edge {eid}")
    doc["edges"].append({"id": eid, "from": source, "to": target, "label": label or ""})
    note = f"added edge {eid}: {source} → {target}" + (f" (new {', '.join(notes)})" if notes else "")
    if fa == "sys" and not doc["use_cases"]:
        doc["use_cases"].append({"id": "uc1", "label": "", "entries": [{"port": fp, "token": {}}]})
        note += "; added use case uc1 entering there"
    return note


def remove_edge(doc, eid):
    _edge(doc, eid)
    _drop_edges(doc, [eid])
    return f"removed edge {eid} with its guards and observation point"


# ---------------------------------------------------------------- rows
def put_row(doc, cid, row, replace=None):
    """Add a row to a component, or replace the row with id `replace` (default: the row's own id)."""
    c = component(doc, cid)
    if not isinstance(row, dict) or not row.get("id"):
        raise EditError("a row is a mapping with an id, a when part and a then part (docs/model-format.md, Rows)")
    if not ROW_ID.match(row["id"]):
        raise EditError(f"row id {row['id']!r} must start with a letter or _ and use letters, digits, _ and dots")
    old = replace or row["id"]
    others = {r["id"] for x in doc["components"] for r in x.get("rows", []) if not (x is c and r["id"] == old)}
    if row["id"] in others:
        raise EditError(f"another row is already called {row['id']}")
    row = {"id": row["id"], **{k: v for k, v in row.items() if k != "id"}}
    row.setdefault("when", {})
    row.setdefault("then", {})
    for i, r in enumerate(c["rows"]):
        if r["id"] == old:
            c["rows"][i] = row
            return f"replaced row {old} of {cid}" + (f" (now {row['id']})" if row["id"] != old else "")
    if replace:
        raise EditError(f"{cid} has no row {replace}")
    c["rows"].append(row)
    return f"added row {row['id']} to {cid}"


def remove_row(doc, cid, rid):
    c = component(doc, cid)
    if not any(r["id"] == rid for r in c["rows"]):
        raise EditError(f"{cid} has no row {rid}; its rows: {', '.join(r['id'] for r in c['rows']) or 'none'}")
    c["rows"] = [r for r in c["rows"] if r["id"] != rid]
    return f"removed row {rid} of {cid}"


def set_absorbs(doc, cid, port, modes, reason=""):
    """What stops at an input of a non-LLM component (modes [] lets everything pass again)."""
    c = component(doc, cid)
    if port not in c["in"]:
        raise EditError(f"{cid} has no input port {port}")
    c["absorbs"] = [a for a in c.get("absorbs", []) if a.get("port") != port]
    if modes:
        c["absorbs"].append({"port": port, "modes": list(modes), "reason": reason})
    if not c["absorbs"]:
        c.pop("absorbs")
    return f"{cid}.{port} absorbs {', '.join(modes)}" if modes else f"everything passes at {cid}.{port}"


def drop_default(doc, cid, port, mode, reason):
    c = component(doc, cid)
    c["drop_defaults"] = [d for d in c.get("drop_defaults", []) if not (d.get("port") == port and d.get("mode") == mode)]
    c["drop_defaults"].append({"port": port, "mode": mode, "reason": reason})
    return f"dropped the default {mode} on {cid}.{port}"


def restore_default(doc, cid, port, mode):
    c = component(doc, cid)
    c["drop_defaults"] = [d for d in c.get("drop_defaults", []) if not (d.get("port") == port and d.get("mode") == mode)]
    if not c["drop_defaults"]:
        c.pop("drop_defaults")
    return f"restored the default {mode} on {cid}.{port}"


# ---------------------------------------------------------------- guards and observation points
def put_guard(doc, spec):
    """Create a guard on an edge, or change the fields given (rename with new_id)."""
    ensure_lists(doc)
    gid = spec.get("id")
    g = next((x for x in doc["guards"] if gid and x["id"] == gid), None)
    if g is None:
        if not spec.get("edge"):
            raise EditError("a new guard needs the edge it cuts")
        _edge(doc, spec["edge"])
        gid = gid or fresh("g", ids_in_use(doc))
        if not IDENT.match(gid) or gid in ids_in_use(doc):
            raise EditError(f"{gid!r} is not a free identifier")
        g = {"id": gid, "label": "", "edge": spec["edge"], "targets": []}
        doc["guards"].append(g)
        note = f"added guard {gid} on {spec['edge']}"
    else:
        note = f"changed guard {gid}"
    for k in GUARD_FIELDS:
        if k in spec:
            if spec[k] is None:
                g.pop(k, None)
            else:
                g[k] = spec[k]
    if g.get("edge"):
        _edge(doc, g["edge"])
    if spec.get("new_id") and spec["new_id"] != g["id"]:
        if not IDENT.match(spec["new_id"]) or spec["new_id"] in ids_in_use(doc):
            raise EditError(f"{spec['new_id']!r} is not a free identifier")
        g["id"] = spec["new_id"]
        note += f", renamed to {g['id']}"
    return note


def remove_guard(doc, gid):
    if not any(g["id"] == gid for g in doc["guards"]):
        raise EditError(f"no guard {gid!r}")
    doc["guards"] = [g for g in doc["guards"] if g["id"] != gid]
    return f"removed guard {gid}"


def put_observation_point(doc, spec):
    """Create an observation point on an edge (judging every top-level mode at 1 unless told), or
    change the fields given (rename with new_id; claims follow)."""
    ensure_lists(doc)
    oid = spec.get("id")
    o = next((x for x in doc["observation_points"] if oid and x["id"] == oid), None)
    taken = {x["id"] for x in doc["observation_points"]}
    if o is None:
        if not spec.get("edge"):
            raise EditError("a new observation point needs the edge it observes")
        e = _edge(doc, spec["edge"])
        if any(x.get("edge") == e["id"] for x in doc["observation_points"]):
            raise EditError(f"{e['id']} already has an observation point")
        recv = _split(e["to"])
        oid = oid or fresh(f"o_{recv[1] if recv[0] == 'sys' else recv[0]}", taken)
        if not IDENT.match(oid) or oid in taken:
            raise EditError(f"{oid!r} is not a free identifier")
        o = {"id": oid, "edge": e["id"], "label": spec.get("label") or oid, "tolerate": {m: 1 for m in top_modes(doc)}}
        doc["observation_points"].append(o)
        note = f"added observation point {oid} on {e['id']}"
    else:
        note = f"changed observation point {oid}"
    for k in OBS_FIELDS:
        if k in spec:
            if spec[k] is None:
                o.pop(k, None)
            else:
                o[k] = spec[k]
    if spec.get("new_id") and spec["new_id"] != o["id"]:
        new = spec["new_id"]
        if not IDENT.match(new) or new in taken:
            raise EditError(f"{new!r} is not a free identifier")
        for cl in doc["claims"]:
            f, _, at = str(cl.get("cell", "")).partition("@")
            if at == o["id"]:
                cl["cell"] = f"{f}@{new}"
        o["id"] = new
        note += f", renamed to {new}"
    return note


def remove_observation_point(doc, oid):
    if not any(o["id"] == oid for o in doc["observation_points"]):
        raise EditError(f"no observation point {oid!r}")
    doc["observation_points"] = [o for o in doc["observation_points"] if o["id"] != oid]
    return f"removed observation point {oid}"


# ---------------------------------------------------------------- use cases, claims, settings
def put_use_case(doc, spec):
    """Create or replace a use case: {id, label?, entries: [{port, token: {taint, conf, auth, modes}}]}."""
    ensure_lists(doc)
    if not spec.get("id") or not IDENT.match(spec["id"]):
        raise EditError("a use case needs an identifier as id")
    entries = spec.get("entries")
    if not entries:
        raise EditError("a use case enters at least one system input: entries: [{port, token}]")
    uc = {"id": spec["id"], "label": spec.get("label", ""), "entries": [{"port": e["port"], "token": e.get("token") or {}} for e in entries]}
    for i, u in enumerate(doc["use_cases"]):
        if u["id"] == spec["id"]:
            doc["use_cases"][i] = uc
            return f"replaced use case {spec['id']}"
    doc["use_cases"].append(uc)
    return f"added use case {spec['id']}"


def remove_use_case(doc, uid):
    if not any(u["id"] == uid for u in doc["use_cases"]):
        raise EditError(f"no use case {uid!r}")
    doc["use_cases"] = [u for u in doc["use_cases"] if u["id"] != uid]
    return f"removed use case {uid}"


def put_claim(doc, cell, verdict="guarantee", by="", note=None):
    """A claim about a cell (one per cell and claimant: a second put replaces it)."""
    ensure_lists(doc)
    cl = {"cell": cell, "verdict": verdict, "by": by}
    if note:
        cl["note"] = note
    doc["claims"] = [c for c in doc["claims"] if not (c.get("cell") == cell and c.get("by", "") == by)] + [cl]
    return f"{by or 'someone'} claims {verdict} for {cell}"


def remove_claim(doc, cell, by=None):
    before = len(doc["claims"])
    doc["claims"] = [c for c in doc["claims"] if not (c.get("cell") == cell and (by is None or c.get("by", "") == by))]
    if len(doc["claims"]) == before:
        raise EditError(f"no claim about {cell}")
    return f"removed the claim(s) about {cell}"


def set_settings(doc, name=None, description=None, modes=None, confidentiality=None, authority=None,
                 worst_case_defaults=None):
    notes = []
    if name is not None:
        doc["name"] = name
        notes.append("name")
    if description is not None:
        doc["description"] = description
        notes.append("description")
    if modes is not None:
        doc["modes"] = modes
        notes.append("failure modes")
    if confidentiality is not None:
        doc.setdefault("lattices", {})["confidentiality"] = list(confidentiality)
        notes.append("confidentiality levels")
    if authority is not None:
        doc.setdefault("lattices", {})["authority"] = list(authority)
        notes.append("authority levels")
    if worst_case_defaults is not None:
        doc["worst_case_defaults"] = worst_case_defaults
        notes.append(f"worst-case defaults for {'every component' if worst_case_defaults == 'all' else 'LLM components'}")
    return "changed " + (", ".join(notes) or "nothing")


# The failure modes a new model starts with: the failure classes of FPTC (Wallace 2005), taken from the
# SHARD/HAZOP guide words - omission and commission (service), early and late (timing), value - with
# value split into coarse (detectable from the data) and subtle (plausible but wrong), after
# Bondavalli and Simoncini. web/state.js (blankDoc) starts a model the same way.
NEW_MODES = ["omission", {"commission": []}, "early", "late", {"value": ["coarse", "subtle"]}]


def blank(name="new-system", description=""):
    """A new, empty model, as File → New model in the reasoner: the FPTC failure modes, and worst-case
    defaults for every component, so a component nobody modelled is never a guarantee."""
    return {"name": name, "description": description,
            "modes": copy.deepcopy(NEW_MODES), "worst_case_defaults": "all",
            "lattices": {"confidentiality": ["public", "internal", "confidential"], "authority": ["none", "user", "admin"]},
            "components": [], "guards": [], "edges": [], "use_cases": [], "observation_points": [], "claims": [],
            "layout": {"sys": {}}}
