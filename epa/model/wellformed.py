"""Checks that make a model ill-formed, and the static list of unmatched failures (assumption A6)."""


def check(m) -> list:
    p = []
    for g in m.components.values():
        if not g.is_guard:
            continue
        for t in g.targets:
            if g.learned and t["decidable"]:
                p.append(f"guard {g.id}: a learned guard cannot have a decidable target")
            if t["kind"] == "taint" and not g.closed_output:
                p.append(f"guard {g.id}: taint may only be washed by a guard whose output domain is closed")
    for r in m.rows.values():
        for port, emits in r.then.items():
            for mode, (op, _) in emits.items():
                if op in ("keep", "plus", "max") and not any("modes" in pat for pat in r.when.values()):
                    p.append(f"row {r.id}: '{op}' needs a mode in its when part")
    for o in m.obs.values():
        if o.edge not in m.edges:
            p.append(f"observation point {o.id}: edge {o.edge} does not exist")
    return p


def absorbed(m):
    """What the model says is absorbed, for review: the declared absorptions (with their reasons) and
    the sink rows. Since every other failure passes through where a component forwards (A6), these are
    the places where a failure stops, and each is a claim an auditor can dispute."""
    out = []
    for c in m.components.values():
        for a in c.absorbs:
            out.append({"component": c.id, "port": a["port"], "modes": a["modes"], "reason": a["reason"],
                        "kind": "declared"})
    for r in m.rows.values():
        if r.kind == "sink":
            for p, pat in r.when.items():
                out.append({"component": r.comp, "port": p, "modes": sorted(pat.get("modes", {})),
                            "reason": r.label or r.reason, "kind": "sink", "row": r.id})
    return out
