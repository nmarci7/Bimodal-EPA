"""From explored states to runs, and from runs to what the alethic layer says about a cell.

A run is identified by its use case and its firing choice F. Its terminal state (the fixpoint)
carries the label of every edge of the cone; a cell reads the label of its observation point.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .dump_reader import parse_labels, parse_value, read_dump, read_dump_raw


@dataclass
class Run:
    uc: str
    fire: frozenset
    fired: frozenset              # rows of the cone that fired (and matched) in this run
    labels: dict                  # edge id -> {"u", "n", "k": token}
    rounds: int = 0
    terminal_variants: int = 1    # >1 only if interleavings reached different fixpoints (never expected)

    def key(self):
        return (self.uc, self.fire)


def runs_from_dump(dump_path, keep_edges):
    """One Run per (use case, firing choice); checks that every interleaving ends in one fixpoint."""
    runs, cache = {}, {}
    for raw in read_dump_raw(dump_path):
        if raw.get("done") != "TRUE":
            continue
        s = {k: parse_value(raw[k]) for k in ("uc", "fire", "fired", "rnd")}
        s["lab"] = parse_labels(raw["lab"], cache)
        labels = {e: s["lab"][e] for e in keep_edges if e in s["lab"]}
        key = (s["uc"], frozenset(s["fire"]))
        r = Run(uc=s["uc"], fire=frozenset(s["fire"]), fired=frozenset(s["fired"]), labels=labels, rounds=s["rnd"])
        if key in runs:
            if runs[key].labels != labels:
                runs[key].terminal_variants += 1
        else:
            runs[key] = r
    return runs


def trace(dump_path, uc, fire, edges):
    """The states of one run in order (rounds schedule): what each edge carried after each round."""
    steps = []
    for s in read_dump(dump_path, wanted={"uc", "fire", "lab", "rnd", "fired"}):
        if s["uc"] == uc and frozenset(s["fire"]) == frozenset(fire):
            steps.append({"round": s["rnd"], "fired": sorted(s["fired"]),
                          "labels": {e: s["lab"][e] for e in edges if e in s["lab"]}})
    steps.sort(key=lambda x: x["round"])
    out, prev = [], None
    for st in steps:
        if prev is not None and st["labels"] == prev["labels"]:
            continue
        out.append(st)
        prev = st
    return out


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
        return bool(tok["t"])
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
        return effective(m, tok, cell.field)
    if cell.kind == "taint":
        return 1 if tok["t"] else 0
    if cell.kind == "conf":
        return max(0, tok["c"] - o.clearance)
    return max(0, o.requires - tok["a"])


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
        if "taint" in logged and lab["u"] and bool(lab["k"]["t"]) != bool(logged["taint"]):
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
