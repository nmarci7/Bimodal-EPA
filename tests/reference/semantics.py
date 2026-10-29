"""Reference semantics of the bimodal error-propagation framework, written from the TDK chapter
(draft 4) and the SPEC that records the later decisions. It is a specification in code:

  * no cones, no projection of witnesses, no TLC, no ASP;
  * every run of every use case under every switch vector is propagated, every candidate of the
    whole model is enumerated, and the statuses are counted directly.

    reference(doc, evidence) -> {cell_id: {"verdict": str, "statuses": [N|S|A, ...],
                                           "remaining": int, "suspended": [certificate ids]}}

The models are tiny (at most a handful of open rows), so brute force is the point: what this file
computes should be obviously what the definitions say. Section numbers in comments (§n) refer to
the items of the SPEC.
"""
from __future__ import annotations

import itertools
from collections import namedtuple
from dataclasses import dataclass, field

TOP = 10                                    # every magnitude saturates at 10 (§12)
DEFAULT_MODES = ["omission", "commission", "early", "late", "value"]
DEFAULT_CONF = ["public", "internal", "confidential"]
DEFAULT_AUTH = ["none", "user", "admin"]
KINDS = {"llm", "deterministic", "tool", "store", "external", "user"}
WORD = {"never": "N", "sometimes": "S", "always": "A", "N": "N", "S": "S", "A": "A",
        "n": "N", "s": "S", "a": "A"}
ANY = None                                  # the pattern "any message"
AS_IS = "as it is"                          # the emission "as it is"
ORDER = "NSA"


class IllFormed(Exception):
    """The model cannot be loaded (the reference refuses it, as the engine must)."""


# ---------------------------------------------------------------------------------------------
# tokens and labels (§9)
# ---------------------------------------------------------------------------------------------

Token = namedtuple("Token", "b c a t")      # b: magnitudes in field order; c: conf index;
#                                             a: authority index (top = most); t: tainted
Label = namedtuple("Label", "used normal tok")


def all_clear(M):
    return Token(tuple(0 for _ in M.fields), 0, M.auth_top, False)


def merge(t1, t2):
    """Cell by cell into the worse value: max magnitudes, max conf, MIN authority, or taint."""
    return Token(tuple(max(x, y) for x, y in zip(t1.b, t2.b)), max(t1.c, t2.c), min(t1.a, t2.a),
                 t1.t or t2.t)


def join(l1, l2):
    return Label(l1.used or l2.used, l1.normal or l2.normal, merge(l1.tok, l2.tok))


def effective(M, tok, mode):
    """A rule about a mode reads the largest magnitude among the mode and its sub-kinds."""
    return max(tok.b[M.fidx[f]] for f in M.family(mode))


# ---------------------------------------------------------------------------------------------
# the model
# ---------------------------------------------------------------------------------------------

@dataclass
class Comp:
    id: str
    kind: str
    ins: list
    outs: list
    flow: dict = field(default_factory=dict)
    trusted: bool = True
    authority: int = 0
    raises: bool = False
    clearance: int = 0
    requires: int = 0
    version: str | None = None
    absorbed: dict = field(default_factory=dict)     # input port -> set of fields absorbed there
    # guards
    guard: bool = False
    targets: list = field(default_factory=list)
    learned: bool = False
    fp_omission: int = 10

    @property
    def llm(self):
        return self.kind == "llm"


@dataclass
class Row:
    id: str
    comp: str
    kind: str            # failure | forward | internal | sink | default | leak | fp
    when: dict           # port ("*" = any input) -> ANY | {field: threshold}
    then: dict           # out port -> AS_IS | {field: (op, k)}
    domain: tuple        # the activations a candidate may give it (one value: fixed)
    target: dict | None = None

    @property
    def fixed(self):
        return self.domain[0] if len(self.domain) == 1 else None

    @property
    def emits_failure(self):
        return any(isinstance(e, dict) and e for e in self.then.values())


@dataclass
class Obs:
    id: str
    seg: str             # the segment after every guard on the edge (what the receiver gets)
    doc_edge: str
    cells: list          # [(cell id, kind, field-or-None, threshold-or-level)]


def _modes(doc):
    top, parent = [], {}
    for item in doc.get("modes", DEFAULT_MODES):
        if isinstance(item, str):
            top.append(item)
        elif isinstance(item, dict) and "name" in item:
            top.append(item["name"])
            for s in item.get("subkinds", []) or []:
                parent[s] = item["name"]
        elif isinstance(item, dict):
            for k, subs in item.items():
                top.append(k)
                for s in subs or []:
                    parent[s] = k
    return top, parent


def _ref(s):
    if not isinstance(s, str) or "." not in s:
        raise IllFormed(f"bad port reference {s!r}")
    return tuple(s.split(".", 1))


def _op(op):
    if isinstance(op, bool):
        raise IllFormed(f"bad emission {op!r}")
    if isinstance(op, int):
        return ("const", max(0, min(TOP, op)))
    s = str(op).strip()
    if s in ("keep", "max"):                 # max is the legacy spelling of keep (§5)
        return ("keep", 0)
    if s.startswith("+"):
        return ("plus", int(s[1:]))
    if s.startswith("const"):
        return ("const", max(0, min(TOP, int(s.split()[1]))))
    raise IllFormed(f"unknown emission {op!r}")


class Model:
    def __init__(self, doc):
        self.doc = doc
        self.top_modes, self.parent = _modes(doc)
        self.fields = []
        for t in self.top_modes:
            self.fields += [t] + [s for s, p in self.parent.items() if p == t]
        self.fidx = {f: i for i, f in enumerate(self.fields)}
        lat = doc.get("lattices") or {}
        self.conf = list(lat.get("confidentiality", DEFAULT_CONF))
        self.auth = list(lat.get("authority", DEFAULT_AUTH))
        self.auth_top = len(self.auth) - 1
        self.comps, self.rows = {}, {}
        self._components()
        self._edges_and_guards()
        self._worst_case_defaults()
        self._use_cases()
        self._observation_points()
        self._graph()

    # -- lattices and modes --------------------------------------------------------------
    def family(self, m):
        if m not in self.fidx:
            raise IllFormed(f"unknown mode {m!r}")
        return [m] + [s for s, p in self.parent.items() if p == m]

    def _level(self, levels, name, what):
        if name not in levels:
            raise IllFormed(f"unknown {what} level {name!r}")
        return levels.index(name)

    # -- components and their rows (§1-§7) ----------------------------------------------
    def _components(self):
        for c in self.doc.get("components", []):
            cid, kind = c.get("id"), c.get("kind")
            if not cid or cid in self.comps or cid == "sys":
                raise IllFormed(f"missing, duplicate or reserved component id {cid!r}")
            if kind not in KINDS:
                raise IllFormed(f"component {cid}: unknown kind {kind!r}")
            ins, outs = list(c.get("in", [])), list(c.get("out", []))
            if "pass" in c and (kind == "llm" or c["pass"] != "all"):
                # pass: is gone; the old engine needs an explicit `pass: all`, which is what
                # every non-LLM component now does anyway
                raise IllFormed(f"component {cid}: 'pass' is gone (only 'pass: all' on a non-LLM is tolerated)")
            flow = c.get("flow")
            flow = {p: list(outs) for p in ins} if flow is None else {p: list(qs or []) for p, qs in flow.items()}
            for p, qs in flow.items():
                if p not in ins or any(q not in outs for q in qs):
                    raise IllFormed(f"component {cid}: bad flow {p}: {qs}")
            comp = Comp(
                id=cid, kind=kind, ins=ins, outs=outs, flow=flow,
                trusted=bool(c.get("trusted", kind not in ("external", "user"))),
                authority=self._level(self.auth, c.get("authority", self.auth[-1]), "authority"),
                raises=bool(c.get("raises", False)),
                clearance=self._level(self.conf, c.get("clearance", self.conf[-1]), "confidentiality"),
                requires=self._level(self.auth, c.get("requires", self.auth[0]), "authority"),
                version=c.get("version"), absorbed={p: set() for p in ins})
            for a in c.get("absorbs", []) or []:
                modes = a.get("modes", a.get("mode"))
                fs = set(self.fields) if modes == "all" else \
                    set().union(*[set(self.family(m)) for m in ([modes] if isinstance(modes, str) else modes)])
                port = a.get("port")
                if port != "*" and port not in ins:
                    raise IllFormed(f"component {cid}: absorbs at unknown port {port!r}")
                for p in (ins if port == "*" else [port]):
                    comp.absorbed[p] |= fs
            self.comps[cid] = comp
            for r in c.get("rows", []) or []:
                self._row(comp, r)

    def _row(self, comp, r):
        rid = r.get("id")
        if not rid or rid in self.rows:
            raise IllFormed(f"component {comp.id}: missing or duplicate row id {rid!r}")
        when = {}
        for p, pat in (r.get("when") or {}).items():
            if p != "*" and p not in comp.ins:
                raise IllFormed(f"row {rid}: unknown input port {p!r}")
            if pat in ("any", None, True) or pat == {}:
                when[p] = ANY
            elif isinstance(pat, dict):
                for m in pat:
                    self.family(m)
                when[p] = {m: int(k) for m, k in pat.items()}
            else:
                raise IllFormed(f"row {rid}: bad pattern {pat!r}")
        if "*" in when and (when["*"] is not ANY or len(when) > 1):
            raise IllFormed(f"row {rid}: 'any input' takes only 'any' and stands alone")
        then = {}
        for q, em in (r.get("then") or {}).items():
            if q not in comp.outs:
                raise IllFormed(f"row {rid}: unknown output port {q!r}")
            if em in (None, AS_IS, "as-is") or em == {}:
                then[q] = AS_IS
            elif isinstance(em, dict):
                for m in em:
                    self.family(m)
                then[q] = {m: _op(op) for m, op in em.items()}
            else:
                raise IllFormed(f"row {rid}: bad emission {em!r}")
        failure_pats = [p for p, pat in when.items() if pat is not ANY]
        if not when:
            kind = "internal"                                           # §3
            if not then or any(e is AS_IS or any(op != "const" for op, _ in e.values()) for e in then.values()):
                raise IllFormed(f"row {rid}: an internal fault emits only const k")
        elif not then:
            kind = "sink"                                               # §4
            if not failure_pats:
                raise IllFormed(f"row {rid}: a sink needs a failure pattern")
        elif not failure_pats and all(e is AS_IS for e in then.values()):
            kind = "forward"                                            # §2
        else:
            kind = "failure"                                            # §5
        for e in then.values():
            if e is not AS_IS and any(op == "keep" or op == "plus" for op, _ in e.values()) and not failure_pats:
                raise IllFormed(f"row {rid}: keep and +k need a failure in the condition")
        act = r.get("activation")
        if act is not None:
            if act not in ("never", "sometimes", "always"):
                raise IllFormed(f"row {rid}: unknown activation {act!r}")
            domain = (WORD[act],)
        elif kind == "forward":
            domain = ("A",)
        else:
            domain = None
        row = Row(id=rid, comp=comp.id, kind=kind, when=when, then=then, domain=domain or ())
        if comp.llm and row.emits_failure:
            if domain == ("N",):
                raise IllFormed(f"row {rid}: an LLM row that emits a failure cannot be never (LLM rule)")
            row.domain = domain or ("S", "A")                          # §7, §13
        else:
            row.domain = domain or ("N", "S", "A")
        self.rows[rid] = row

    def _worst_case_defaults(self):
        """§6: for every LLM output port and top-level mode a worst-case default, replaced only by
        an analyst row of the same shape ("*" (or the only input): any => exactly that mode, const).
        With `worst_case_defaults: all` every component gets them; the default of a component that is
        not an LLM may be never (the LLM rule does not reach it)."""
        every = self.doc.get("worst_case_defaults", "llm")
        if every not in ("llm", "all"):
            raise IllFormed(f"worst_case_defaults {every!r}")
        for c in self.doc.get("components", []):
            comp = self.comps[c["id"]]
            if not comp.llm and every != "all":
                if c.get("drop_defaults"):
                    raise IllFormed(f"component {comp.id}: drop_defaults on a non-LLM component")
                continue
            dropped = set()
            for d in c.get("drop_defaults", []) or []:
                if not d.get("reason"):
                    raise IllFormed(f"component {comp.id}: dropping a default needs a reason")
                dropped.add((d.get("port"), d.get("mode")))
            mine = [r for r in self.rows.values() if r.comp == comp.id]
            for q in comp.outs:
                for m in self.top_modes:
                    if any(self._replaces(comp, r, q, m) for r in mine) or (q, m) in dropped:
                        continue
                    rid = f"default.{comp.id}.{q}.{m}"
                    self.rows[rid] = Row(id=rid, comp=comp.id, kind="default", when={"*": ANY},
                                         then={q: {m: ("const", TOP)}},
                                         domain=("S", "A") if comp.llm else ("N", "S", "A"))

    @staticmethod
    def _replaces(comp, r, q, m):
        any_input = r.when == {"*": ANY} or (len(comp.ins) == 1 and r.when == {comp.ins[0]: ANY})
        return any_input and isinstance(r.then.get(q), dict) and m in r.then[q] and r.then[q][m][0] == "const"

    # -- edges and guards (§8) ------------------------------------------------------------
    def _edges_and_guards(self):
        self.segs = {}                                   # segment id -> (src, dst)
        doc_edges = {}
        for e in self.doc.get("edges", []):
            eid = e.get("id")
            if not eid or eid in doc_edges:
                raise IllFormed(f"missing or duplicate edge id {eid!r}")
            src, dst = _ref(e.get("from")), _ref(e.get("to"))
            for (owner, port), side in ((src, "outs"), (dst, "ins")):
                if owner != "sys" and (owner not in self.comps or port not in getattr(self.comps[owner], side)):
                    raise IllFormed(f"edge {eid}: unknown port {owner}.{port}")
            doc_edges[eid] = (src, dst)
            self.segs[eid] = (src, dst)
        self.last_seg = {eid: eid for eid in doc_edges}
        by_edge = {}
        for g in self.doc.get("guards", []) or []:
            gid = g.get("id")
            eid = g.get("edge", g.get("on", g.get(True)))
            if not gid or gid in self.comps or gid == "sys":
                raise IllFormed(f"missing or duplicate guard id {gid!r}")
            if eid not in doc_edges:
                raise IllFormed(f"guard {gid}: unknown edge {eid!r}")
            learned = bool(g.get("learned", False))
            comp = Comp(id=gid, kind="guard", ins=["in"], outs=["out"], flow={"in": ["out"]}, trusted=True,
                        authority=self.auth_top, clearance=len(self.conf) - 1, requires=0,
                        version=g.get("version"), guard=True, learned=learned,
                        fp_omission=int(g.get("fp_omission", TOP)), absorbed={"in": set()})
            keys = set()
            for t in g.get("targets", []) or []:
                dec = bool(t.get("decidable", False))
                if learned and dec:
                    raise IllFormed(f"guard {gid}: a learned guard has no decidable target")
                if "mode" in t:
                    self.family(t["mode"])
                    tt = {"kind": "mode", "key": t["mode"], "mode": t["mode"], "threshold": int(t.get("threshold", 1))}
                elif "taint" in t:
                    if not g.get("closed_output", False):
                        raise IllFormed(f"guard {gid}: taint may be washed only by a closed-output guard")
                    tt = {"kind": "taint", "key": "taint"}
                elif "conf" in t:
                    tt = {"kind": "conf", "key": "conf", "level": self._level(self.conf, t["conf"], "confidentiality")}
                elif "auth" in t:
                    tt = {"kind": "auth", "key": "auth", "level": self._level(self.auth, t["auth"], "authority")}
                else:
                    raise IllFormed(f"guard {gid}: unknown target {t!r}")
                if tt["key"] in keys:
                    raise IllFormed(f"guard {gid}: two targets named {tt['key']}")
                keys.add(tt["key"])
                tt["row"] = f"leak.{gid}.{tt['key']}"
                tt["decidable"] = dec and not learned
                comp.targets.append(tt)
                self.rows[tt["row"]] = Row(id=tt["row"], comp=gid, kind="leak", when={"in": ANY}, then={"out": AS_IS},
                                           domain=("N", "S", "A") if tt["decidable"] else ("S", "A"), target=tt)
            if learned:
                rid = f"fp.{gid}"
                self.rows[rid] = Row(id=rid, comp=gid, kind="fp", when={"in": ANY},
                                     then={"out": {"omission": ("const", comp.fp_omission)}}, domain=("S", "A"))
            self.comps[gid] = comp
            by_edge.setdefault(eid, []).append(gid)
        for eid, gids in by_edge.items():               # several guards on one edge: listed order
            src, dst = doc_edges[eid]
            prev = eid
            self.segs[eid] = (src, (gids[0], "in"))
            for i, gid in enumerate(gids):
                seg = f"{eid}__{gid}"
                self.segs[seg] = ((gid, "out"), (gids[i + 1], "in") if i + 1 < len(gids) else dst)
                prev = seg
            self.last_seg[eid] = prev
        self.doc_edges = doc_edges
        self.into, self.outof = {}, {}
        for s, (src, dst) in self.segs.items():
            self.outof.setdefault(src, []).append(s)
            self.into.setdefault(dst, []).append(s)

    # -- use cases and observation points (§11, §14) -------------------------------------
    def _token(self, tok):
        tok = tok or {}
        b = [0] * len(self.fields)
        for m, v in (tok.get("modes") or {}).items():
            if m not in self.fidx:
                raise IllFormed(f"unknown mode {m!r} in a starting token")
            b[self.fidx[m]] = max(0, min(TOP, int(v)))
        return Token(tuple(b), self._level(self.conf, tok["conf"], "confidentiality") if "conf" in tok else 0,
                     self._level(self.auth, tok["auth"], "authority") if "auth" in tok else self.auth_top,
                     bool(tok.get("taint", False)))

    def _use_cases(self):
        self.use_cases = {}
        for u in self.doc.get("use_cases", []) or []:
            ents = u["entries"] if "entries" in u else [{"port": u.get("entry"), "token": u.get("token")}]
            entries = []
            for ent in ents:
                port = str(ent["port"]).replace("sys.", "")
                segs = self.outof.get(("sys", port), [])
                if not segs:
                    raise IllFormed(f"use case {u['id']}: no edge leaves sys.{port}")
                entries += [(s, self._token(ent.get("token"))) for s in segs]
            self.use_cases[u["id"]] = entries
        if not self.use_cases:
            raise IllFormed("at least one use case is needed")

    def _observation_points(self):
        self.obs = {}
        for o in self.doc.get("observation_points", []) or []:
            oid, eid = o.get("id"), o.get("edge")
            if eid not in self.doc_edges:
                raise IllFormed(f"observation point {oid}: unknown edge {eid!r}")
            recv_owner = self.doc_edges[eid][1][0]
            recv = self.comps.get(recv_owner) if recv_owner != "sys" else None
            tol = {m: int(k) for m, k in (o.get("tolerate") or {}).items()}
            cells = []
            for f in self.fields:
                if f in tol:
                    cells.append((f"{f}@{oid}", "mode", f, tol[f]))
            for m in tol:
                self.family(m)
            if o.get("taint", "accept") == "reject":
                cells.append((f"taint@{oid}", "taint", None, None))
            clr, req = o.get("clearance"), o.get("requires")
            if clr is None and req is None and recv is not None:        # §14: the receiver's own
                if recv.clearance < len(self.conf) - 1:
                    clr = self.conf[recv.clearance]
                if recv.requires > 0:
                    req = self.auth[recv.requires]
            for val, key, levels, own in ((clr, "conf", self.conf, "clearance"), (req, "auth", self.auth, "requires")):
                if val is None:
                    continue
                if val == "receiver":
                    if recv is None:
                        raise IllFormed(f"observation point {oid}: its receiver is outside the model")
                    lvl = getattr(recv, own)
                else:
                    lvl = self._level(levels, val, key)
                cells.append((f"{key}@{oid}", key, None, lvl))
            self.obs[oid] = Obs(id=oid, seg=self.last_seg[eid], doc_edge=eid, cells=cells)

    def cells(self):
        return [(o.id,) + cell for o in self.obs.values() for cell in o.cells]

    # -- the component graph: strongly connected components in topological order (§12) ---
    def _graph(self):
        succ = {c: set() for c in self.comps}
        for src, dst in self.segs.values():
            if src[0] != "sys" and dst[0] != "sys":
                succ[src[0]].add(dst[0])
        index, low, stack, on_stack, sccs = {}, {}, [], set(), []
        counter = itertools.count()

        def visit(v):                                   # Tarjan; emits SCCs in reverse topological order
            index[v] = low[v] = next(counter)
            stack.append(v)
            on_stack.add(v)
            for w in sorted(succ[v]):
                if w not in index:
                    visit(w)
                    low[v] = min(low[v], low[w])
                elif w in on_stack:
                    low[v] = min(low[v], index[w])
            if low[v] == index[v]:
                scc = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    scc.append(w)
                    if w == v:
                        break
                sccs.append(sorted(scc))

        for v in sorted(self.comps):
            if v not in index:
                visit(v)
        self.scc_order = list(reversed(sccs))
        self.on_cycle = {}
        for scc in self.scc_order:
            for v in scc:
                self.on_cycle[v] = len(scc) > 1 or v in succ[v]

    def reaches_segment(self, start_seg, target_seg):
        """Structural reachability along edges (through any component, any port)."""
        seen, stack = set(), [start_seg]
        while stack:
            s = stack.pop()
            if s in seen:
                continue
            seen.add(s)
            dst = self.segs[s][1]
            if dst[0] != "sys":
                for q in self.comps[dst[0]].outs:
                    stack += self.outof.get((dst[0], q), [])
        return target_seg in seen


# ---------------------------------------------------------------------------------------------
# propagation of one use case under one switch vector (§5, §8, §10-§12)
# ---------------------------------------------------------------------------------------------

def _port(M, lab, comp, port):
    out = Label(False, False, all_clear(M))
    for s in M.into.get((comp, port), []):
        out = join(out, lab[s])
    return out


def _send(M, lab, comp, port, label):
    changed = False
    for s in M.outof.get((comp, port), []):
        new = join(lab[s], label)
        if new != lab[s]:
            lab[s] = new
            changed = True
    return changed


def _guard_step(M, g, lab, on, may_drop):
    L = _port(M, lab, g.id, "in")
    if not L.used:
        return False
    tok = L.tok
    b, c, a, t = list(tok.b), tok.c, tok.a, tok.t
    caught = False
    for tg in g.targets:
        if tg["kind"] == "mode":
            present = effective(M, tok, tg["mode"]) >= tg["threshold"]
        elif tg["kind"] == "taint":
            present = tok.t
        elif tg["kind"] == "conf":
            present = tok.c > tg["level"]
        else:
            present = tok.a < tg["level"]
        if not present or tg["row"] in on:          # absent, or the leak row lets it through
            continue
        caught = True
        if tg["kind"] == "mode":                    # the reduced-target rule
            for f in M.family(tg["mode"]):
                b[M.fidx[f]] = min(b[M.fidx[f]], tg["threshold"] - 1)
        elif tg["kind"] == "taint":
            t = False
        elif tg["kind"] == "conf":
            c = tg["level"]
        else:
            a = tg["level"]
    if f"fp.{g.id}" in on and "omission" in M.fidx:
        i = M.fidx["omission"]
        b[i] = max(b[i], min(TOP, g.fp_omission))
    if may_drop and caught and not L.normal:
        return False                                # a caught failure-created message is dropped
    return _send(M, lab, g.id, "out", Label(True, L.normal, Token(tuple(b), c, a, t)))


def _matches(M, row, ins):
    """-> (matched, matched ports, trigger value v or None)."""
    ports, v = [], None
    for p, pat in row.when.items():
        if p == "*":
            used = [q for q in ins if ins[q].used]
            if not used:
                return False, [], None
            ports += used
            continue
        L = ins[p]
        if not L.used:
            return False, [], None
        if pat is not ANY:
            for m, k in pat.items():
                e = effective(M, L.tok, m)
                if e < k:
                    return False, [], None
                v = e if v is None else max(v, e)
        ports.append(p)
    return True, ports, v


def _emit(op, k, v):
    if op == "const":
        return k
    if op == "keep":
        return v
    return min(v + k, TOP)


def _component_step(M, comp, lab, on):
    ins = {p: _port(M, lab, comp.id, p) for p in comp.ins}
    used = [p for p in comp.ins if ins[p].used]
    # provenance of every token the component emits (§10)
    conf = max([ins[p].tok.c for p in used], default=0)
    taint = (not comp.trusted) or any(ins[p].tok.t for p in used)
    auth = comp.authority if comp.raises else min([comp.authority] + [ins[p].tok.a for p in used])
    rows = [r for r in M.rows.values() if r.comp == comp.id and r.id in on]
    fired = {}
    for r in rows:
        if r.kind != "internal":
            ok, ports, v = _matches(M, r, ins)
            if ok:
                fired[r.id] = (ports, v)
    # what may pass through from each input port: nothing for an LLM; otherwise everything that
    # is neither absorbed structurally nor consumed by a firing sink (§1, §4)
    blocked = {p: set(comp.absorbed.get(p, ())) for p in comp.ins}
    for r in rows:
        if r.kind == "sink" and r.id in fired:
            for p, pat in r.when.items():
                if pat is not ANY:
                    for m in pat:
                        blocked[p] |= set(M.family(m))
    zero = tuple(0 for _ in M.fields)

    def through(ports):
        b = list(zero)
        if comp.llm:
            return tuple(b)
        for p in ports:
            for f in M.fields:
                if f not in blocked[p]:
                    i = M.fidx[f]
                    b[i] = max(b[i], ins[p].tok.b[i])
        return tuple(b)

    sent = {q: [] for q in comp.outs}                  # out port -> [(normal, magnitudes)]
    for p in used:                                     # the flow forwards normal(p) (§2, §11)
        for q in comp.flow.get(p, []):
            sent[q].append((ins[p].normal, through([p])))
    for r in rows:
        if r.kind == "sink":
            continue
        if r.kind == "internal":                       # needs no message, fires whenever on (§3)
            for q, em in r.then.items():
                b = list(zero)
                for m, (op, k) in em.items():
                    b[M.fidx[m]] = max(b[M.fidx[m]], k)
                sent[q].append((False, tuple(b)))
            continue
        if r.id not in fired:
            continue
        ports, v = fired[r.id]
        if r.kind == "forward":
            normal = any(ins[p].normal for p in ports) if "*" in r.when else all(ins[p].normal for p in ports)
            for q in r.then:
                sent[q].append((normal, through(ports)))
            continue
        for q, em in r.then.items():                   # failure rows: never normal
            if em is AS_IS:
                sent[q].append((False, through(ports)))
            else:
                b = list(zero)
                for m, (op, k) in em.items():
                    b[M.fidx[m]] = max(b[M.fidx[m]], _emit(op, k, v))
                sent[q].append((False, tuple(b)))
    changed = False
    for q, contribs in sent.items():
        if not contribs:
            continue
        b = tuple(max(x) for x in zip(*[bb for _, bb in contribs]))
        label = Label(True, any(n for n, _ in contribs), Token(b, conf, auth, taint))
        changed |= _send(M, lab, comp.id, q, label)
    return changed


def propagate(M, uc, on):
    """The labels of every segment after propagating use case `uc` with the rows in `on` switched on."""
    lab = {s: Label(False, False, all_clear(M)) for s in M.segs}
    for s, tok in M.use_cases[uc]:
        lab[s] = join(lab[s], Label(True, True, tok))
    for scc in M.scc_order:
        if len(scc) == 1 and M.comps[scc[0]].guard and not M.on_cycle[scc[0]]:
            _guard_step(M, M.comps[scc[0]], lab, on, may_drop=True)   # once, from its settled input
            continue
        while True:
            changed = False
            for cid in scc:
                comp = M.comps[cid]
                if comp.guard:
                    changed |= _guard_step(M, comp, lab, on, may_drop=False)
                else:
                    changed |= _component_step(M, comp, lab, on)
            if not changed:
                break
    return lab


def cell_outcome(M, cell, label):
    """(used, reaches) of one cell for the label on its observed segment."""
    _oid, _cid, kind, f, k = cell
    if not label.used:
        return False, False
    tok = label.tok
    if kind == "mode":
        return True, effective(M, tok, f) >= k
    if kind == "taint":
        return True, tok.t
    if kind == "conf":
        return True, tok.c > k
    return True, tok.a < k


def witness_matches(M, w, uc, lab):
    if w.get("use_case") and w["use_case"] != uc:
        return False
    for oid, logged in w["at"].items():
        L = lab[M.obs[oid].seg]
        if "used" in logged and bool(logged["used"]) != L.used:
            return False
        modes = logged.get("modes") or {}
        if not L.used:
            if any(lo > 0 for lo, _hi in modes.values()):
                return False
            continue
        for m, (lo, hi) in modes.items():
            if not lo <= effective(M, L.tok, m) <= hi:
                return False
        if "taint" in logged and bool(logged["taint"]) != L.tok.t:
            return False
        for key, val, levels in (("conf", L.tok.c, M.conf), ("auth", L.tok.a, M.auth)):
            if key in logged:
                lo, hi = [levels.index(x) if isinstance(x, str) else int(x) for x in logged[key]]
                if not lo <= val <= hi:
                    return False
    return True


# ---------------------------------------------------------------------------------------------
# candidates, runs, evidence, verdicts (§13-§18)
# ---------------------------------------------------------------------------------------------

def classify_certificate(M, cert):
    """-> (state, pins) with state in force | rejected | stale."""
    comp_id = cert.get("component")
    pins = {}
    for key, v in (cert.get("targets") or {}).items():
        pins[f"leak.{comp_id}.{key}"] = WORD.get(v, v)
    for key, v in (cert.get("rows") or {}).items():
        rid = key
        if rid not in M.rows:
            for cand in (f"{comp_id}.{key}", f"leak.{comp_id}.{key}", f"default.{comp_id}.{key}"):
                if cand in M.rows:
                    rid = cand
        pins[rid] = WORD.get(v, v)
    comp = M.comps.get(comp_id)
    if comp is None or not pins:
        return "rejected", pins
    for rid, x in pins.items():
        row = M.rows.get(rid)
        if row is None or row.comp != comp_id or x not in ("N", "S", "A"):
            return "rejected", pins
        if x == "N" and ((M.comps[row.comp].llm and row.emits_failure) or row.kind == "fp"
                         or (row.kind == "leak" and not row.target["decidable"])):
            return "rejected", pins
    if comp.version is not None and cert.get("version") is not None and cert["version"] != comp.version:
        return "stale", pins
    return "in force", pins


def classify_witness(M, w):
    if any(oid not in M.obs for oid in w.get("at", {})):
        return "rejected"
    if w.get("use_case") and w["use_case"] not in M.use_cases:
        return "rejected"
    for cid, v in (w.get("versions") or {}).items():
        c = M.comps.get(cid)
        if c is not None and c.version is not None and c.version != v:
            return "stale"
    return "in force"


class Analysis:
    """Every run of the whole model, every candidate, and what the evidence leaves."""

    def __init__(self, doc, evidence=None):
        self.M = M = Model(doc)
        evidence = evidence or {}
        self.cells = M.cells()
        # switch vectors range over the rows that may be on or off in some run
        self.open_rows = sorted(r.id for r in M.rows.values() if r.fixed is None)
        self.bit_rows = sorted(r.id for r in M.rows.values() if r.fixed in (None, "S"))
        always = {r.id for r in M.rows.values() if r.fixed == "A"}
        self.certs = []
        for c in evidence.get("certificates", []) or []:
            state, pins = classify_certificate(M, c)
            self.certs.append({"id": c["id"], "state": state, "pins": pins, "scope": list(c.get("scope") or [])})
        self.wits = [w for w in evidence.get("witnesses", []) or [] if classify_witness(M, w) == "in force"]
        # every run: (use case, vector) -> outcomes per cell, witness matches
        self.runs, self.labs = {}, {}
        for uc in M.use_cases:
            for vec in itertools.product((0, 1), repeat=len(self.bit_rows)):
                on = always | {r for r, bit in zip(self.bit_rows, vec) if bit}
                lab = propagate(M, uc, on)
                self.labs[(uc, vec)] = lab
                self.runs[(uc, vec)] = (
                    {cell[1]: cell_outcome(M, cell, lab[M.obs[cell[0]].seg]) for cell in self.cells},
                    {w["id"]: witness_matches(M, w, uc, lab) for w in self.wits})
        # every candidate: an activation for every open row; fixed rows keep theirs
        self.candidates = []
        doms = [M.rows[r].domain for r in self.open_rows]
        fixed = {r.id: r.fixed for r in M.rows.values() if r.fixed is not None}
        for choice in itertools.product(*doms):
            act = dict(fixed)
            act.update(zip(self.open_rows, choice))
            bits = [{"N": (0,), "A": (1,), "S": (0, 1)}[act[r]] for r in self.bit_rows]
            vecs = list(itertools.product(*bits))
            self.candidates.append((act, vecs))

    # -- per candidate ---------------------------------------------------------------------
    def allowed_runs(self, cand):
        _act, vecs = cand
        return [(uc, v) for uc in self.M.use_cases for v in vecs]

    def status(self, cand, cell_id):
        U = X = 0
        for key in self.allowed_runs(cand):
            used, reaches = self.runs[key][0][cell_id]
            U += used
            X += reaches
        if U == 0:
            return "x"
        if X == 0:
            return "N"
        return "A" if X == U else "S"

    def consistent(self, cand, w):
        return any(self.runs[key][1][w["id"]] for key in self.allowed_runs(cand))

    @staticmethod
    def satisfies(cand, certs):
        act = cand[0]
        return all(act.get(r) == x for c in certs for r, x in c["pins"].items())

    # -- suspension (§18) --------------------------------------------------------------------
    def suspended(self):
        in_force = [c for c in self.certs if c["state"] == "in force"]
        susp = set()
        for w in self.wits:
            pool = [c for c in in_force if not w.get("use_case") or not c["scope"] or w["use_case"] in c["scope"]]
            consistent = [cand for cand in self.candidates if self.consistent(cand, w)]

            def conflicting(S):
                return not any(self.satisfies(cand, S) for cand in consistent)

            bad = [S for n in range(len(pool) + 1) for S in itertools.combinations(pool, n) if conflicting(S)]
            for S in bad:
                ids = {c["id"] for c in S}
                if not any({c["id"] for c in T} < ids for T in bad):
                    susp |= ids
        for c in in_force:
            if any(self.M.rows[r].fixed not in (None, x) for r, x in c["pins"].items()):
                susp.add(c["id"])
        for c1, c2 in itertools.combinations(in_force, 2):
            if any(r in c2["pins"] and c2["pins"][r] != x for r, x in c1["pins"].items()):
                susp |= {c1["id"], c2["id"]}
        return susp

    def scope_applies(self, cert, oid):
        if not cert["scope"]:
            return True
        seg = self.M.obs[oid].seg
        relevant = {uc for (uc, _), lab in self.labs.items() if lab[seg].used}
        return all(self.inert(r, uc) for uc in relevant - set(cert["scope"]) for r in cert["pins"])

    def inert(self, rid, uc):
        """No run of use case uc makes this row match (patterns are upward-closed and inputs only
        grow, so a row matches in some pass exactly when it matches the settled input)."""
        M = self.M
        row = M.rows[rid]
        for (u, _), lab in self.labs.items():
            if u != uc:
                continue
            if row.kind in ("leak", "fp"):
                L = _port(M, lab, row.comp, "in")
                if not L.used:
                    continue
                if row.kind == "fp":
                    return False
                tg, tok = row.target, L.tok
                present = (effective(M, tok, tg["mode"]) >= tg["threshold"] if tg["kind"] == "mode" else
                           tok.t if tg["kind"] == "taint" else tok.c > tg["level"] if tg["kind"] == "conf" else
                           tok.a < tg["level"])
                if present:
                    return False
                continue
            if row.kind == "internal":
                return False
            comp = M.comps[row.comp]
            ins = {p: _port(M, lab, comp.id, p) for p in comp.ins}
            if _matches(M, row, ins)[0]:
                return False
        return True

    # -- verdicts (§15) ----------------------------------------------------------------------
    def verdicts(self):
        susp = self.suspended()
        out = {}
        for cell in self.cells:
            oid, cell_id = cell[0], cell[1]
            applicable = [c for c in self.certs
                          if c["state"] == "in force" and c["id"] not in susp and self.scope_applies(c, oid)]
            remaining = [cand for cand in self.candidates
                         if self.satisfies(cand, applicable) and all(self.consistent(cand, w) for w in self.wits)]
            seen = {self.status(cand, cell_id) for cand in remaining}
            out[cell_id] = {**verdict_of(seen if remaining else None), "remaining": len(remaining),
                            "suspended": sorted(susp)}
        return out


def verdict_of(seen):
    if seen is None:
        return {"verdict": "conflict", "statuses": []}
    if seen <= {"x"}:
        return {"verdict": "not exercised", "statuses": []}
    s = {"N" if x == "x" else x for x in seen}
    word = {frozenset("N"): "guarantee", frozenset("S"): "hope", frozenset("A"): "exposed"}.get(frozenset(s), "unchecked")
    return {"verdict": word, "statuses": [x for x in ORDER if x in s]}


def reference(doc, evidence=None):
    """{cell id: {"verdict", "statuses", "remaining", "suspended"}} for the whole model."""
    return Analysis(doc, evidence).verdicts()
