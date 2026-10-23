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


def mode_reach(m):
    """Over-approximation: which mode fields can be non-zero on which edge (any activation)."""
    on = {e: set() for e in m.edges}
    for u in m.use_cases:
        for eid, tok in u.entries:
            on[eid] |= {f for f, v in tok["b"].items() if v > 0}
    changed = True
    while changed:
        changed = False
        for c in m.components.values():
            incoming = {p: set().union(*[on[e.id] for e in m.edges_into(c.id, p)]) if m.edges_into(c.id, p) else set()
                        for p in c.ins}
            out = {q: set() for q in c.outs}
            for p, qs in c.flow.items():
                for q in qs:
                    out[q] |= incoming.get(p, set()) & set(c.passes)
                    if c.is_guard:
                        out[q] |= incoming.get(p, set())
            for r in m.comp_rows(c.id):
                for q, emits in r.then.items():
                    out[q] |= set(emits)
            for q, fs in out.items():
                for e in m.edges_from(c.id, q):
                    if not fs <= on[e.id]:
                        on[e.id] |= fs
                        changed = True
    return on


def unmatched_failures(m):
    """Failure modes that can arrive at a non-LLM component's input port and match no row and no
    pass-through there: they are absorbed silently, which is optimistic (A6). Listed for review."""
    on = mode_reach(m)
    out = []
    for c in m.components.values():
        if c.llm or c.is_guard:
            continue
        for p in c.ins:
            arriving = set().union(*[on[e.id] for e in m.edges_into(c.id, p)]) if m.edges_into(c.id, p) else set()
            handled = set(c.passes)
            for r in m.comp_rows(c.id):
                pat = r.when.get(p) or r.when.get("*")
                if pat and "modes" in pat:
                    for f in pat["modes"]:
                        handled |= set(m.family(f))
            for f in sorted(arriving - handled, key=m.fields.index):
                out.append({"component": c.id, "port": p, "mode": f})
    return out
