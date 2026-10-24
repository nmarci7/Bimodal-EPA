"""Cells and cones.

A *cell* is one failure judged at one observation point: a mode or sub-kind, taint, confidentiality
or authority. Its *cone* is the part of the model that can change the cell: the components upstream
of the point, the use cases that enter there, the rows whose firing can change the observed fields or
whether a message exists on the observed edge, and the mode fields those rows read and write. Rows
outside the cone cannot change the cell, so they are left out of its runs and its candidates.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field


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
    fields: list          # mode fields the generated model tracks
    cell_rows: dict = field(default_factory=dict)   # cell id -> the rows of that cell's own cone
    cell_fields: dict = field(default_factory=dict) # cell id -> the mode fields that cell's cone reads
    rel: set = field(default_factory=set)            # (edge, field) pairs the runs compute exactly
    cell_rel: dict = field(default_factory=dict)     # cell id -> the (edge, field) pairs its own rows decide

    def key(self, m):
        payload = {
            "rows": {r: m.rows[r].to_json() for r in self.rows + self.always},
            "comps": {c: _comp_sig(m.components[c]) for c in self.components},
            "edges": {e: [list(m.edges[e].src), list(m.edges[e].dst)] for e in self.edges},
            "ucs": [[u.id, [[eid, tok] for eid, tok in u.entries]] for u in m.use_cases if u.id in self.use_cases],
            "fields": self.fields,
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def _comp_sig(c):
    return {"kind": c.kind, "flow": c.flow, "passes": c.passes, "trusted": c.trusted, "authority": c.authority,
            "raises": c.raises, "targets": [{k: v for k, v in t.items() if k != "row"} for t in c.targets],
            "learned": c.learned, "closed": c.closed_output, "fp": c.fp_omission, "on_cycle": c.on_cycle}


def cells(m, only=None):
    out = []
    for o in m.obs.values():
        for f in m.fields:
            if f in o.tolerate:
                out.append(Cell("mode", f, o.id))
        if o.taint == "reject":
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


def normal_edges(m):
    """Per use case, the edges the normal flow uses (every guard passes a normal message)."""
    out = {}
    for u in m.use_cases:
        used = {eid for eid, _ in u.entries}
        stack = list(used)
        while stack:
            e = m.edges[stack.pop()]
            c = e.dst[0]
            if c == "sys":
                continue
            comp = m.components[c]
            for q in comp.flow.get(e.dst[1], []):
                for e2 in m.edges_from(c, q):
                    if e2.id not in used:
                        used.add(e2.id)
                        stack.append(e2.id)
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
                for p, es in inp.items():
                    if not es:
                        continue
                    for qp in c.flow.get(p, []):
                        emit.setdefault(qp, set())
                        emit[qp] |= fields_at[p] if c.is_guard else (fields_at[p] & set(c.passes))
                if not c.is_guard:
                    for r in m.comp_rows(c.id):
                        if _trigger_possible(m, c, r, inp, fields_at):
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
    # guards whose provenance target is the cell's kind
    if cell.kind != "mode":
        for g in m.components.values():
            if g.is_guard and g.id in U:
                for t in g.targets:
                    if t["kind"] == cell.kind:
                        add_guard_target(g, t)
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
        if f in c.passes:
            for p in c.ins:
                if src[1] in c.flow.get(p, []):
                    for e in m.edges_into(c.id, p):
                        if e.id in sub:
                            mark(e.id, [f])
    rows = sorted(r for r in include if m.rows[r].open or m.rows[r].fixed == "S")
    always = sorted(r for r in include if m.rows[r].fixed == "A")
    fields = [f for f in m.fields if any(f == ff for _, ff in rel)]
    comps = sorted(U)
    return Cone(cells=[cell], obs=cell.obs, components=comps, edges=sub_edges, use_cases=ucs,
                rows=rows, always=always, fields=fields, cell_rows={cell.id: rows},
                cell_fields={cell.id: fields}, rel=set(rel), cell_rel={cell.id: set(rel)})


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
                    g.rel |= k.rel
                    break
            else:
                groups.append(Cone(cells=list(k.cells), obs=k.obs, components=k.components, edges=k.edges,
                                   use_cases=k.use_cases, rows=list(k.rows), always=list(k.always),
                                   fields=list(k.fields), cell_rows=dict(k.cell_rows),
                                   cell_fields=dict(k.cell_fields), rel=set(k.rel),
                                   cell_rel=dict(k.cell_rel)))
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
