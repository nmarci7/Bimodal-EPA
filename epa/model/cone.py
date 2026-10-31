"""Cells and cones.

A *cell* is one failure judged at one observation point: a mode or sub-kind, taint, confidentiality
or authority. Its *cone* is the part of the model that can change the cell: the components upstream
of the point, the use cases that enter there, the rows that can change the observed fields or whether a
message exists on the observed edge, and the mode fields those rows read and write. Rows outside the
cone cannot change the cell, so they are left out of its runs and its candidates. Completeness and
correctness count only the components with a row kept in the cone (`report_components`).
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field

# Bumped whenever the meaning of a run changes, so that cached runs of an older engine are not reused.
# 2: formal core draft 4 - pass-through by default, forwarding / internal-fault / sink rows, phased guards.
# 3: FIFO firing - queues per input port, one ready component per step, the stopping rule; taint levels.
# 4: the loop bound k and the cut report; tokens keep all their fields; sub-kinds have defaults of their own.
SEMANTICS = 4


def default_schedule():
    """The firing semantics when nobody names one: fifo, unless EPA_SCHEDULE says otherwise."""
    return os.environ.get("EPA_SCHEDULE", "fifo")


def schedule_of(m):
    return m.schedule or default_schedule()


@dataclass(frozen=True)
class Cell:
    kind: str      # mode | taint | conf | auth
    field: str     # the mode field for kind == mode, else the kind
    obs: str

    @property
    def id(self):
        return f"{self.field}@{self.obs}"

    @staticmethod
    def parse(s):
        f, o = s.split("@", 1)
        kind = f if f in ("taint", "conf", "auth") else "mode"
        return Cell(kind, f, o)


@dataclass
class Cone:
    cells: list
    obs: str
    components: list
    edges: list
    use_cases: list
    rows: list            # rows whose activation varies between runs (open, and fixed-sometimes)
    always: list          # rows fixed to always, inside the cone
    fields: list          # mode fields the cone reads
    cell_rows: dict = field(default_factory=dict)   # cell id -> the rows of that cell's own cone
    cell_fields: dict = field(default_factory=dict) # cell id -> the mode fields that cell's cone reads
    rel: set = field(default_factory=set)            # (edge, field) pairs the runs compute exactly
    cell_rel: dict = field(default_factory=dict)     # cell id -> the (edge, field) pairs its own rows decide
    cell_always: dict = field(default_factory=dict)  # cell id -> the always rows of that cell's own cone
    scope_ucs: list = None                           # use cases that can send over the point (the scope rule)

    def key(self, m):
        payload = {
            "semantics": SEMANTICS,
            "schedule": schedule_of(m),
            "loop_bound": m.loop_bound,
            "kinds": sorted({c.kind for c in self.cells}),
            "rows": {r: m.rows[r].to_json() for r in self.rows + self.always},
            "comps": {c: _comp_sig(m.components[c]) for c in self.components},
            "edges": {e: [list(m.edges[e].src), list(m.edges[e].dst)] for e in self.edges},
            "ucs": [[u.id, [[eid, tok] for eid, tok in u.entries]] for u in m.use_cases if u.id in self.use_cases],
            "fields": self.fields,
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def _comp_sig(c):
    return {"kind": c.kind, "flow": c.flow, "passes": c.passes, "trusted": c.trusted, "taint": c.taint,
            "authority": c.authority,
            "raises": c.raises, "targets": [{k: v for k, v in t.items() if k != "row"} for t in c.targets],
            "learned": c.learned, "closed": c.closed_output, "fp": c.fp_omission, "on_cycle": c.on_cycle}


def cells(m, only=None):
    out = []
    for o in m.obs.values():
        for f in m.fields:
            if f in o.tolerate:
                out.append(Cell("mode", f, o.id))
        if o.tolerate_taint is not None:
            out.append(Cell("taint", "taint", o.id))
        if o.clearance is not None:
            out.append(Cell("conf", "conf", o.id))
        if o.requires is not None:
            out.append(Cell("auth", "auth", o.id))
    if only:
        wanted = set(only)
        out = [c for c in out if c.id in wanted]
    return out


def upstream(m, edge_id):
    """Components from which a message can reach the edge (its source included)."""
    preds = {}
    for e in m.edges.values():
        if e.dst[0] != "sys" and e.src[0] != "sys":
            preds.setdefault(e.dst[0], set()).add(e.src[0])
    start = m.edges[edge_id].src[0]
    if start == "sys":
        return set()
    seen, stack = set(), [start]
    while stack:
        c = stack.pop()
        if c in seen:
            continue
        seen.add(c)
        stack += list(preds.get(c, ()))
    return seen


def _when_ports(m, r):
    if "*" in r.when:
        return list(m.components[r.comp].ins)
    return list(r.when)


def forwarding(m, c):
    """Every way a component forwards a message: (input ports, output port, row or None, join).
    The `flow` of a port is a forwarding of that port alone; a forwarding row names its ports (all of
    them must arrive, a fork-join) or any input ("*"). A row's "as it is" outputs forward too, but the
    message they send exists because a failure row fired, so it is not a normal message."""
    out = []
    for p, qs in c.flow.items():
        for q in qs:
            out.append(([p], q, None, "all"))
    for r in m.comp_rows(c.id):
        if r.kind not in ("fwd", "row") or r.fixed == "N":
            continue
        ports = list(c.ins) if "*" in r.when else list(r.when)
        for q in r.asis:
            out.append((ports, q, r, "any" if "*" in r.when else "all"))
    return out


def normal_edges(m):
    """Per use case, the edges the normal flow uses (every guard passes a normal message): the flow,
    and forwarding rows whose input ports all carry a normal message."""
    out = {}
    for u in m.use_cases:
        used = {eid for eid, _ in u.entries}
        changed = True
        while changed:
            changed = False
            for c in m.components.values():
                at = {p for p in c.ins if any(e.id in used for e in m.edges_into(c.id, p))}
                for ports, q, r, join in forwarding(m, c):
                    if r is not None and r.kind != "fwd":
                        continue
                    ok = (any(p in at for p in ports) if join == "any" else all(p in at for p in ports)) if ports else False
                    if ok:
                        for e2 in m.edges_from(c.id, q):
                            if e2.id not in used:
                                used.add(e2.id)
                                changed = True
        out[u.id] = used
    return out


def possible(m):
    """Per use case, an over-approximation of which edges can carry a message and which mode fields
    can be non-zero on them, whatever the rows' activations."""
    out = {}
    for u in m.use_cases:
        pos = {eid: {f for f, v in tok["b"].items() if v > 0} for eid, tok in u.entries}
        changed = True
        while changed:
            changed = False
            for c in m.components.values():
                inp = {p: [e.id for e in m.edges_into(c.id, p) if e.id in pos] for p in c.ins}
                fields_at = {p: set().union(*[pos[e] for e in es]) if es else set() for p, es in inp.items()}
                emit = {}
                for ports, qp, r, join in forwarding(m, c):
                    arrived = [p for p in ports if inp.get(p)]
                    if not arrived or (join == "all" and len(arrived) < len(ports)):
                        continue
                    if r is not None and not _trigger_possible(m, c, r, inp, fields_at):
                        continue
                    emit.setdefault(qp, set())
                    for p in arrived:
                        emit[qp] |= fields_at[p] & set(c.passes.get(p, []))
                if not c.is_guard:
                    for r in m.comp_rows(c.id):
                        if r.kind in ("row", "default") and _trigger_possible(m, c, r, inp, fields_at):
                            for qp, d in r.then.items():
                                emit.setdefault(qp, set())
                                emit[qp] |= set(d)
                else:
                    fp = m.rows.get(f"fp.{c.id}")
                    if fp is not None and inp.get("in"):
                        emit.setdefault("out", set()).update(fp.then.get("out", {}))
                for qp, fs in emit.items():
                    for e in m.edges_from(c.id, qp):
                        if e.id not in pos:
                            pos[e.id] = set(fs)
                            changed = True
                        elif not fs <= pos[e.id]:
                            pos[e.id] |= fs
                            changed = True
        out[u.id] = pos
    return out


def _trigger_possible(m, c, r, inp, fields_at):
    if "*" in r.when:
        return any(inp[p] for p in c.ins)
    for p, pat in r.when.items():
        if not inp.get(p):
            return False
        for f in pat.get("modes", {}):
            if not set(m.family(f)) & fields_at[p]:
                return False
    return True


def _creates_message(m, r, port, ucs=None):
    """A row creates a message if, in some use case where it can fire, it emits on an edge no normal
    message uses: then whether that edge is used at all depends on the row (and on guards that drop)."""
    if ucs is None:
        ucs = [u.id for u in m.use_cases]
    if not hasattr(m, "_normal_edges"):
        m._normal_edges = normal_edges(m)
        m._possible = possible(m)
    c = m.components[r.comp]
    es = [e.id for e in m.edges_from(r.comp, port)]
    for u in ucs:
        pos = m._possible[u]
        inp = {p: [e.id for e in m.edges_into(c.id, p) if e.id in pos] for p in c.ins}
        fields_at = {p: set().union(*[pos[e] for e in ids]) if ids else set() for p, ids in inp.items()}
        if _trigger_possible(m, c, r, inp, fields_at) and not set(es) <= m._normal_edges[u]:
            return True
    return False


def downstream_guards(m, comp, port):
    """Guards a message sent on this port can pass through."""
    seen, out = set(), set()
    stack = [e.dst[0] for e in m.edges_from(comp, port)]
    while stack:
        c = stack.pop()
        if c in seen or c == "sys":
            continue
        seen.add(c)
        if m.components[c].is_guard:
            out.add(c)
        for q in m.components[c].outs:
            stack += [e.dst[0] for e in m.edges_from(c, q)]
    return out


def _trigger_fields(m, r):
    fs = set()
    for pat in r.when.values():
        for f in pat.get("modes", {}):
            fs |= set(m.family(f))
    return fs


def _carries_alone(m, r, sub):
    """The row sends on an edge of the sub-network from an input port that does not forward there."""
    c = m.components[r.comp]
    forwards = {(p, q) for ports, q, f, _ in forwarding(m, c) if f is None for p in ports}
    return any((p, q) not in forwards and any(e.id in sub for e in m.edges_into(c.id, p))
               for q in r.then if any(e.id in sub for e in m.edges_from(c.id, q)) for p in _when_ports(m, r))


def _guards_met(m, rid, U, sub):
    """The guard targets, off a cycle, that a token sent by this row alone can trigger on its way to the
    point: a mode target if the token carries that mode, a provenance target always."""
    r = m.rows[rid]
    if r.kind not in ("row", "default") or not _carries_alone(m, r, sub):
        return []
    c = m.components[r.comp]
    out = []
    for q, emits in r.then.items():
        mine = set(emits)
        if q in r.asis:
            mine |= {f for p in _when_ports(m, r) for f in c.passes.get(p, [])}
        for gid in downstream_guards(m, r.comp, q) & U:
            g = m.components[gid]
            if not g.on_cycle:
                out += [(g, t) for t in g.targets if t["kind"] != "mode" or set(m.family(t["mode"])) & mine]
    return out


_WORSE = {"conf": max, "taint": max, "auth": min}


def _level(tok, kind):
    return tok[{"conf": "c", "taint": "t", "auth": "a"}[kind]]


def _sent(m, c, kind, levels):
    """What a firing of c sends in this provenance dimension, given the levels of its heads."""
    if kind == "conf":
        return max(levels)
    if kind == "taint":
        return max(levels + [c.taint])
    return c.authority if c.raises else min(levels + [c.authority])


def _provenance_bound(m, u, kind, skip=()):
    """The worst level of this dimension each edge can carry in use case u, without the rows in `skip`.
    An upper bound: guards are read as passing everything."""
    worse = _WORSE[kind]
    at = {eid: _level(tok, kind) for eid, tok in u.entries}
    changed = True

    def put(q_edges, v):
        nonlocal changed
        for e in q_edges:
            if e.id not in at or worse(at[e.id], v) != at[e.id]:
                at[e.id] = v if e.id not in at else worse(at[e.id], v)
                changed = True
    while changed:
        changed = False
        for c in m.components.values():
            heard = {p: [at[e.id] for e in m.edges_into(c.id, p) if e.id in at] for p in c.ins}
            for ports, q, r, _ in forwarding(m, c):
                if r is None or r.id not in skip:
                    levels = [v for p in ports for v in heard[p]]
                    if levels:
                        put(m.edges_from(c.id, q), _sent(m, c, kind, levels))
            for r in m.comp_rows(c.id):
                if r.kind in ("row", "default", "fp") and r.id not in skip:
                    levels = [v for p in _when_ports(m, r) for v in heard.get(p, [])]
                    for q in r.then:
                        if levels:
                            put(m.edges_from(c.id, q), _sent(m, c, kind, levels))
    return at


def _provenance_carriers(m, kind, ucs, sub, U):
    """The rows a provenance cell needs under fifo. A token carries the provenance of the heads of its own
    firing, nothing else, so a row that sends from a port with no forwarding to that output may be the
    only way that port's provenance goes on (rounds joined every input into every label instead). It
    matters only if it can send something worse than the output gets without such rows."""
    carriers = [r for r in m.rows.values() if r.comp in U and r.kind in ("row", "default") and r.fixed != "N"
                and _carries_alone(m, r, sub)]
    skip = {r.id for r in carriers}
    out = []
    for u in (x for x in m.use_cases if x.id in ucs):
        full, bare = _provenance_bound(m, u, kind), _provenance_bound(m, u, kind, skip)
        for r in carriers:
            c = m.components[r.comp]
            levels = [full[e.id] for p in _when_ports(m, r) for e in m.edges_into(c.id, p) if e.id in full]
            for q in r.then:
                for e in m.edges_from(c.id, q):
                    if levels and e.id in sub and r not in out:
                        v = _sent(m, c, kind, levels)
                        if e.id not in bare or _WORSE[kind](v, bare[e.id]) != bare[e.id]:
                            out.append(r)
    return out


def report_components(m, cone, cell):
    """The components that count as in a cell's cone for completeness and correctness: those with a row
    kept in it. A component that only forwards through its flow is searched through but stays out."""
    rows = set(cone.cell_rows.get(cell.id, ())) | set(cone.cell_always.get(cell.id, ()))
    return sorted({m.rows[r].comp for r in rows})


def mentions(m, comp, port, f):
    """The component's table names failure f on this port: a row's pattern or a declared absorption
    names it, its parent or one of its sub-kinds. A row that says only `any` does not name it."""
    kin = {f, m.parent.get(f)} | set(m.children(f))
    if any(a["port"] == port and kin & set(a["modes"]) for a in m.components[comp].absorbs):
        return True
    return any(kin & set(r.when.get(port, {}).get("modes", {})) for r in m.comp_rows(comp))


def cone_of_cell(m, cell):
    """Backward relevance over (edge, mode field) pairs, starting at the observed edge: a row is in
    the cone if it writes a relevant field on an edge, or decides whether a message exists on a
    path to the point; the fields its when part reads on its input edges become relevant in turn."""
    o = m.obs[cell.obs]
    U = upstream(m, o.edge)
    sub_edges = [e.id for e in m.edges.values() if e.dst[0] in U or e.id == o.edge]
    sub = set(sub_edges)
    ucs = [u.id for u in m.use_cases if any(eid in sub for eid, _ in u.entries)]
    rel = set()
    if cell.kind == "mode":
        rel |= {(o.edge, f) for f in m.family(cell.field)}
    include = set()
    work = list(rel)

    def mark(edge_id, fields):
        for f in fields:
            if (edge_id, f) not in rel:
                rel.add((edge_id, f))
                work.append((edge_id, f))

    def add_row(r):
        if r.id in include or r.fixed == "N":
            return
        include.add(r.id)
        comp = m.components[r.comp]
        for p, pat in r.when.items():
            for g in pat.get("modes", {}):
                for pp in (comp.ins if p == "*" else [p]):
                    for e in m.edges_into(r.comp, pp):
                        if e.id in sub:
                            mark(e.id, m.family(g))

    def add_guard_target(g, t):
        add_row(m.rows[t["row"]])
        if t["kind"] == "mode":
            for e in m.edges_into(g.id, "in"):
                if e.id in sub:
                    mark(e.id, m.family(t["mode"]))

    # rows that decide whether a message exists on a path to the point, and the guards that may drop it
    for r in m.rows.values():
        if r.comp not in U or r.kind not in ("row", "default", "fp") or r.fixed == "N":
            continue
        for qp in r.then:
            if any(e.id in sub for e in m.edges_from(r.comp, qp)) and _creates_message(m, r, qp, ucs):
                add_row(r)
                for gid in downstream_guards(m, r.comp, qp) & U:
                    g = m.components[gid]
                    if not g.on_cycle:
                        for t in g.targets:
                            add_guard_target(g, t)
    if cell.kind != "mode" and schedule_of(m) == "fifo":
        for r in _provenance_carriers(m, cell.kind, ucs, sub, U):
            add_row(r)
    # guards whose provenance target is the cell's kind
    if cell.kind != "mode":
        for g in m.components.values():
            if g.is_guard and g.id in U:
                for t in g.targets:
                    if t["kind"] == cell.kind:
                        add_guard_target(g, t)
    def settle():
        while work:
            eid, f = work.pop()
            src = m.edges[eid].src
            if src[0] == "sys" or src[0] not in U:
                continue
            c = m.components[src[0]]
            if c.is_guard:
                for e in m.edges_into(c.id, "in"):
                    if e.id in sub:
                        mark(e.id, [f])
                for t in c.targets:
                    if t["kind"] == "mode" and f in m.family(t["mode"]):
                        add_guard_target(c, t)
                fp = m.rows.get(f"fp.{c.id}")
                if fp is not None and f == "omission":
                    add_row(fp)
                continue
            for r in m.comp_rows(c.id):
                if f in r.then.get(src[1], {}):
                    add_row(r)
            # pass-through: the field comes from every input port that forwards to this output, unless a
            # sink row there may absorb it
            for ports, q, r, _ in forwarding(m, c):
                if q != src[1]:
                    continue
                if r is not None:
                    add_row(r)
                for p in ports:
                    if f not in c.passes.get(p, []):
                        continue
                    for e in m.edges_into(c.id, p):
                        if e.id in sub:
                            mark(e.id, [f])
                    for s in m.comp_rows(c.id):
                        if s.kind == "sink" and any(f in m.family(g) for g in s.when.get(p, {}).get("modes", {})):
                            add_row(s)

    settle()
    # Under fifo a failure row can send a token of its own, which a guard off a cycle may drop even on an
    # edge the normal flow also uses: the guards such a token can meet decide whether it arrives.
    if schedule_of(m) == "fifo":
        met = set()
        while True:
            fresh = [t for r in include for g, t in _guards_met(m, r, U, sub) if t["row"] not in met]
            if not fresh:
                break
            for t in fresh:
                met.add(t["row"])
                g = m.components[m.rows[t["row"]].comp]
                add_guard_target(g, t)
            settle()
    # forwarding rows are structure: they decide which messages exist and which are normal
    for r in m.rows.values():
        if r.kind == "fwd" and r.comp in U and r.fixed != "N":
            include.add(r.id)
    rows = sorted(r for r in include if m.rows[r].open or m.rows[r].fixed == "S")
    always = sorted(r for r in include if m.rows[r].fixed == "A")
    fields = [f for f in m.fields if any(f == ff for _, ff in rel)]
    comps = sorted(U)
    if not hasattr(m, "_possible"):
        m._normal_edges = normal_edges(m)
        m._possible = possible(m)
    scope_ucs = [u for u in ucs if o.edge in m._possible[u]]
    return Cone(cells=[cell], obs=cell.obs, components=comps, edges=sub_edges, use_cases=ucs,
                rows=rows, always=always, fields=fields, cell_rows={cell.id: rows},
                cell_fields={cell.id: fields}, rel=set(rel), cell_rel={cell.id: set(rel)}, scope_ucs=scope_ucs,
                cell_always={cell.id: always})


def cones(m, cell_list, merge_limit=10):
    """One cone per cell; cones of the same observation point are merged when the union stays small,
    so that one model-checker run serves all the cells of that point."""
    per_cell = [cone_of_cell(m, c) for c in cell_list]
    by_obs = {}
    for k in per_cell:
        by_obs.setdefault(k.obs, []).append(k)
    out = []
    for obs_id, ks in by_obs.items():
        groups = []
        for k in sorted(ks, key=lambda k: -len(k.rows)):
            for g in groups:
                union = set(g.rows) | set(k.rows)
                if len(union) <= merge_limit or set(k.rows) <= set(g.rows):
                    g.rows = sorted(union)
                    g.always = sorted(set(g.always) | set(k.always))
                    g.fields = [f for f in m.fields if f in set(g.fields) | set(k.fields)]
                    g.cells += k.cells
                    g.cell_rows.update(k.cell_rows)
                    g.cell_fields.update(k.cell_fields)
                    g.cell_rel.update(k.cell_rel)
                    g.cell_always.update(k.cell_always)
                    g.rel |= k.rel
                    break
            else:
                groups.append(Cone(cells=list(k.cells), obs=k.obs, components=k.components, edges=k.edges,
                                   use_cases=k.use_cases, rows=list(k.rows), always=list(k.always),
                                   fields=list(k.fields), cell_rows=dict(k.cell_rows),
                                   cell_fields=dict(k.cell_fields), rel=set(k.rel),
                                   cell_rel=dict(k.cell_rel), scope_ucs=k.scope_ucs,
                                   cell_always=dict(k.cell_always)))
        out += groups
    return out


def exact_points(m, cone):
    """Observation points inside the cone whose logged mode fields the cone's runs compute exactly:
    the cell's own point, and any other point inside it whose messages no excluded row can create."""
    pts = []
    for o in m.obs.values():
        if o.edge not in cone.edges:
            continue
        if o.id == cone.obs:
            pts.append(o.id)
            continue
        U2 = upstream(m, o.edge)
        sub2 = {e.id for e in m.edges.values() if e.dst[0] in U2 or e.id == o.edge}
        ok = True
        for r in m.rows.values():
            if r.comp not in U2 or r.kind not in ("row", "default", "fp") or r.fixed in ("N", "A"):
                continue
            for qp in r.then:
                if any(e.id in sub2 for e in m.edges_from(r.comp, qp)) and _creates_message(m, r, qp, cone.use_cases) \
                        and r.id not in cone.rows:
                    ok = False
        if ok:
            pts.append(o.id)
    return pts
