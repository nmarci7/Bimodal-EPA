"""From explored states to runs, and from runs to what the alethic layer says about a cell.

A run is a use case, a switch vector F and, under fifo, a firing order. Only the outcome of a firing
order matters here: the terminal states (`done`) carry the monitor label of every edge of the cone, and
terminal states of one (use case, F) with identical monitors are one Run. One (use case, F) can have
several Runs; they differ in `variant`. A cell reads the label of its observation point.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

from .dump_reader import parse_labels, parse_value, read_dump_raw


@dataclass
class Run:
    uc: str
    fire: frozenset
    fired: frozenset              # rows of the cone that applied in this run
    labels: dict                  # edge id -> {"u", "n", "k": token}
    rounds: int = 0               # rounds schedule only: how many rounds it took
    terminal_variants: int = 1    # how many distinct outcomes this (use case, F) has
    variant: int = 0              # which of them this run is

    def key(self):
        return (self.uc, self.fire, self.variant)


def _note_heads(q, heads, cache):
    """Add the head combination of every component in this queue state: {component: {combination}},
    a combination being a sorted tuple of (port, failures at its head)."""
    if q in cache:
        return
    cache.add(q)
    per = {}
    for key, msgs in parse_value(q).items():
        if msgs:
            comp, port = key.rsplit("__", 1)
            b = msgs[0]["k"]["b"]       # a cone with no mode field has an empty function here, printed <<>>
            per.setdefault(comp, []).append((port, tuple(sorted(f for f, v in dict(b).items() if v))))
    for comp, combo in per.items():
        heads.setdefault(comp, set()).add(tuple(sorted(combo)))


def runs_from_dump(dump_path, keep_edges, heads=None):
    """One Run per distinct outcome of each (use case, switch vector). `heads`, if given, collects the
    head combination of every component in every state read."""
    runs, cache, per_key, seen_q = {}, {}, {}, set()
    for raw in read_dump_raw(dump_path):
        if heads is not None and "q" in raw:
            _note_heads(raw["q"], heads, seen_q)
        if raw.get("done") != "TRUE":
            continue
        uc, fire = parse_value(raw["uc"]), frozenset(parse_value(raw["fire"]))
        fired = frozenset(parse_value(raw["fired"]))
        lab = parse_labels(raw["lab"], cache)
        labels = {e: lab[e] for e in keep_edges if e in lab}
        outcomes = per_key.setdefault((uc, fire), {})
        ident = (fired, json.dumps(labels, sort_keys=True))
        if ident in outcomes:
            continue
        outcomes[ident] = r = Run(uc=uc, fire=fire, fired=fired, labels=labels, variant=len(outcomes),
                                  rounds=parse_value(raw["rnd"]) if "rnd" in raw else 0)
        runs[r.key()] = r
    for r in runs.values():
        r.terminal_variants = len(per_key[(r.uc, r.fire)])
    return runs


def _states_of(dump_path, uc, fire):
    fire = frozenset(fire)
    want, vectors = f'"{uc}"', {}
    for raw in read_dump_raw(dump_path):
        if raw["uc"] != want:
            continue
        text = raw["fire"]
        if text not in vectors:
            vectors[text] = frozenset(parse_value(text)) == fire
        if vectors[text]:
            yield {k: parse_value(v) for k, v in raw.items()}


def trace(dump_path, uc, fire, edges, labels=None, sources=None):
    """One run told step by step: [{round, fired, labels, component?}]. Under rounds that is the single
    chain of its states, skipping rounds that changed no edge. Under fifo the dump has no successor links,
    so a path is rebuilt from the states themselves: one consistent firing order that ends in the outcome
    `labels` (any outcome if None), every firing a step. `sources` names the component sending on each
    edge, as it is named in the queues."""
    states = list(_states_of(dump_path, uc, fire))
    if states and "rnd" in states[0]:
        steps = [{"round": s["rnd"], "fired": sorted(s["fired"]),
                  "labels": {e: s["lab"][e] for e in edges if e in s["lab"]}} for s in states]
        steps.sort(key=lambda x: x["round"])
    else:
        steps = _fifo_path(states, edges, labels, sources or {})
    out, prev = [], None
    for st in steps:
        if prev is not None and "component" not in st and st["labels"] == prev["labels"]:
            continue
        out.append(st)
        prev = st
    return out


def _consumed(s):
    """How much of the run has happened: tokens taken off the queues, and internal faults applied.
    Every firing raises it."""
    delivered = sum(len(v) for v in s["seen"].values())
    waiting = sum(len(v) for v in s["q"].values())
    return delivered - waiting + len(s["spent"])


def _fired_by(a, b, sources):
    """The component whose firing leads from state a to state b, or None if no single firing does: only
    one component took heads, and every edge that delivered something is one of its own."""
    if any(x not in list(b["seen"][e]) for e, xs in a["seen"].items() for x in xs):
        return None
    senders = {sources.get(e, e) for e in a["seen"] if len(b["seen"][e]) != len(a["seen"][e])}
    popped = set()
    for p, xs in a["q"].items():
        ys = b["q"][p]
        if ys[:len(xs)] == xs:
            continue
        if xs and ys[:len(xs) - 1] == xs[1:]:
            popped.add(p.rsplit("__", 1)[0])
        else:
            return None
    if len(popped | senders) > 1:
        return None
    if popped:
        comp = popped.pop()
        ports = [p for p in a["q"] if p.rsplit("__", 1)[0] == comp]
        return comp if all(not a["q"][p] or b["q"][p][:len(a["q"][p]) - 1] == a["q"][p][1:] for p in ports) else None
    return next(iter(senders), "") if set(a["spent"]) < set(b["spent"]) else None


def _fifo_path(states, edges, labels, sources):
    if not states:
        return []
    states = sorted(states, key=_consumed)
    goal = lambda s: s["done"] and (labels is None or {e: s["lab"][e] for e in edges if e in s["lab"]} == labels)  # noqa: E731
    dead = set()

    def walk(i, path):
        if goal(states[i]):
            return path
        for j in range(i + 1, len(states)):
            if j in dead or _consumed(states[j]) <= _consumed(states[i]):
                continue
            comp = _fired_by(states[i], states[j], sources)
            if comp is not None:
                found = walk(j, path + [(j, comp)])
                if found:
                    return found
        dead.add(i)
        return None
    found = walk(0, [(0, None)]) or []
    return [{"round": n, "component": comp, "fired": sorted(states[i]["fired"]),
             "labels": {e: states[i]["lab"][e] for e in edges if e in states[i]["lab"]}}
            for n, (i, comp) in enumerate(found)]


# ---------------------------------------------------------------------------
# reading a cell off a run
# ---------------------------------------------------------------------------

def effective(m, tok, mode):
    return max([tok["b"].get(f, 0) for f in m.family(mode)] or [0])


def used(m, cell, run):
    o = m.obs[cell.obs]
    return bool(run.labels[o.edge]["u"])


def reaches(m, cell, run):
    o = m.obs[cell.obs]
    lab = run.labels[o.edge]
    if not lab["u"]:
        return False
    tok = lab["k"]
    if cell.kind == "mode":
        return effective(m, tok, cell.field) >= o.tolerate[cell.field]
    if cell.kind == "taint":
        return tok["t"] > o.tolerate_taint
    if cell.kind == "conf":
        return tok["c"] > o.clearance
    if cell.kind == "auth":
        return tok["a"] < o.requires
    raise ValueError(cell.kind)


def severity(m, cell, run):
    """How bad the failure is when it reaches: its magnitude, or the lattice distance for provenance."""
    o = m.obs[cell.obs]
    lab = run.labels[o.edge]
    if not lab["u"]:
        return 0
    tok = lab["k"]
    if cell.kind == "mode":
        return max([m.severity.get(f, tok["b"].get(f, 0)) for f in m.family(cell.field) if tok["b"].get(f, 0)] or [0])
    if cell.kind == "taint":
        return 1 if tok["t"] > o.tolerate_taint else 0
    if cell.kind == "conf":
        return max(0, tok["c"] - o.clearance)
    return max(0, o.requires - tok["a"])


def races(m, cell, runs):
    """Pairs (a run that reaches, one that uses the point clean) of one use case and switch vector: only
    the firing order tells them apart, so the cell's outcome is order dependent. A run that sends nothing
    over the point is no clean use, as in the status."""
    by = {}
    for r in runs:
        if used(m, cell, r):
            by.setdefault((r.uc, r.fire), {}).setdefault(reaches(m, cell, r), r)
    return [(x[True], x[False]) for x in by.values() if len(x) == 2]


def race_at(m, a, b):
    """Where two runs of one use case and switch vector part: the component that got the same on every
    input edge and still sent something else, and the input ports it took. None if they part on a loop
    that hides the first difference."""
    differ = [e for e in a.labels if a.labels[e] != b.labels.get(e)]

    def inputs(c):
        return {p: [e.id for e in m.edges_into(c, p) if e.id in a.labels] for p in m.components[c].ins}
    sources = list(dict.fromkeys(m.edges[e].src[0] for e in differ if m.edges[e].src[0] != "sys"))
    first = [c for c in sources if not any(e in differ for es in inputs(c).values() for e in es)]
    for c in first + sources:
        used = [p for p, es in inputs(c).items() if any(a.labels[e]["u"] or b.labels[e]["u"] for e in es)]
        named = [r for r in m.comp_rows(c) if len(r.when) > 1 and set(r.when) <= set(used)]
        if named or len(used) > 1:
            return c, sorted(named[0].when) if named else used
    return None


def witness_fields_for_cell(m, cone, cell, witness, rel=None):
    """The part of a witness that constrains this cell exactly: logged fields at points inside the
    cone, restricted to the mode fields the cone tracks (plus provenance for provenance cells)."""
    out = {}
    for obs_id, logged in witness["at"].items():
        o = m.obs.get(obs_id)
        if o is None or o.edge not in cone.edges:
            continue
        own = obs_id == cell.obs
        sel = {}
        if own and "used" in logged:
            sel["used"] = logged["used"]
        for mode, rng in (logged.get("modes") or {}).items():
            if all((o.edge, f) in (rel if rel is not None else cone.rel) for f in m.family(mode)):
                sel.setdefault("modes", {})[mode] = rng
        if own and cell.kind != "mode":
            for k in ("taint", "conf", "auth"):
                if k in logged and k == cell.kind:
                    sel[k] = logged[k]
        if sel:
            out[obs_id] = sel
    return out


def _taint_matches(level, logged, tolerated):
    """A log says whether the taint is beyond what the point accepts (true or false), or names a level
    or a range of levels."""
    if isinstance(logged, bool):
        return (level > (tolerated or 0)) == logged
    lo, hi = logged if isinstance(logged, (list, tuple)) else (logged, logged)
    return lo <= level <= hi


def matches(m, projected, run, use_case=None):
    """A run matches a (projected) witness if it is a run of the witness's use case and every
    logged field is what the run carries there."""
    if use_case and run.uc != use_case:
        return False
    for obs_id, logged in projected.items():
        lab = run.labels[m.obs[obs_id].edge]
        if "used" in logged and bool(lab["u"]) != bool(logged["used"]):
            return False
        if logged.get("modes"):
            if not lab["u"]:
                if any(lo > 0 for lo, hi in logged["modes"].values()):
                    return False
                continue
            for mode, (lo, hi) in logged["modes"].items():
                v = effective(m, lab["k"], mode)
                if not (lo <= v <= hi):
                    return False
        if "taint" in logged and lab["u"] and not _taint_matches(lab["k"]["t"], logged["taint"], m.obs[obs_id].tolerate_taint):
            return False
        if "conf" in logged and lab["u"]:
            lo, hi = logged["conf"]
            if not (lo <= lab["k"]["c"] <= hi):
                return False
        if "auth" in logged and lab["u"]:
            lo, hi = logged["auth"]
            if not (lo <= lab["k"]["a"] <= hi):
                return False
    return True
