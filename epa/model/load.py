"""Read a model document (YAML or JSON), validate it, and normalise it.

The analyst writes a compact document (see docs/model-format.md). Normalising it:
  * resolves port references ("planner.plan", "sys.voice"),
  * splits every guarded edge into a chain of segments, one guard per cut,
  * adds the generated rows (LLM worst-case defaults, guard leak rows, false-positive rows),
  * computes lattices, mode fields and sub-kinds.
The result is a `Model` that every other part of the engine reads.
"""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass, field

import yaml

from . import defaults, wellformed

DEFAULT_MODES = ["omission", "commission", "early", "late", "value"]
DEFAULT_CONF = ["public", "internal", "confidential"]
DEFAULT_AUTH = ["none", "user", "admin"]
KINDS = {"llm", "deterministic", "tool", "store", "external", "user", "guard"}


class ModelError(Exception):
    def __init__(self, problems):
        self.problems = problems if isinstance(problems, list) else [problems]
        super().__init__("; ".join(self.problems))


@dataclass
class Component:
    id: str
    kind: str
    label: str = ""
    ins: list = field(default_factory=list)
    outs: list = field(default_factory=list)
    flow: dict = field(default_factory=dict)        # in port -> [out ports]
    passes: dict = field(default_factory=dict)      # in port -> mode fields passed unchanged where it forwards
    absorbs: list = field(default_factory=list)     # [{port, modes, reason}] declared absorptions
    trusted: bool = True
    authority: int = 0
    raises: bool = False
    clearance: int = 0
    requires: int = 0
    version: str | None = None
    # guards only
    targets: list = field(default_factory=list)
    learned: bool = False
    closed_output: bool = False
    fp_omission: int = 0
    on_edge: str | None = None
    on_cycle: bool = False
    pos: dict | None = None

    @property
    def llm(self):
        return self.kind == "llm"

    @property
    def is_guard(self):
        return self.kind == "guard"


@dataclass
class Edge:
    id: str
    src: tuple          # (component, port) or ("sys", name)
    dst: tuple
    label: str = ""
    origin: str = ""    # the edge id in the document this segment belongs to

    @property
    def src_comp(self):
        return self.src[0]

    @property
    def dst_comp(self):
        return self.dst[0]


@dataclass
class Row:
    id: str
    comp: str
    kind: str                     # row | fwd | sink | default | leak | fp
    when: dict                    # port -> {"any": True} | {"modes": {field: threshold}}; port "*" = any input;
                                  # {} for an internal fault (needs no incoming message)
    then: dict                    # port -> {field: (op, k)}  op in const | keep | plus | max
    open: bool = True             # part of the candidate space (False: fixed by structure)
    llm: bool = False             # can never be N (LLM rule; learned guards)
    decidable: bool = True        # for leak rows: may be certified N
    target: dict | None = None    # for leak rows
    label: str = ""
    reason: str = ""
    fixed: str | None = None      # N | S | A when the activation is fixed by structure (not a candidate choice)
    asis: list = field(default_factory=list)   # output ports the row sends the message on "as it is"

    @property
    def emits_failure(self):
        return any(self.then.get(p) for p in self.then)

    def to_json(self):
        return {"id": self.id, "comp": self.comp, "kind": self.kind, "when": self.when,
                "then": {p: {m: list(v) for m, v in d.items()} for p, d in self.then.items()},
                "asis": self.asis, "open": self.open, "fixed": self.fixed, "llm": self.llm,
                "decidable": self.decidable, "target": self.target, "label": self.label}


@dataclass
class ObsPoint:
    id: str
    edge: str            # the segment observed (after the guards on the document edge)
    doc_edge: str
    label: str = ""
    log: str = ""
    tolerate: dict = field(default_factory=dict)   # field -> lowest magnitude not accepted
    taint: str = "accept"                          # accept | reject
    clearance: int | None = None
    requires: int | None = None


@dataclass
class UseCase:
    id: str
    label: str
    entries: list        # [(edge_id, token dict)]


@dataclass
class Model:
    name: str
    description: str
    top_modes: list
    fields: list                 # every mode and sub-kind, in a stable order
    parent: dict                 # sub-kind -> parent mode
    conf_levels: list
    auth_levels: list
    components: dict
    edges: dict
    rows: dict
    obs: dict
    use_cases: list
    claims: list
    decisions: list
    doc: dict
    warnings: list = field(default_factory=list)

    # ---- lattice helpers -------------------------------------------------
    @property
    def auth_top(self):
        return len(self.auth_levels) - 1

    def children(self, m):
        return [f for f, p in self.parent.items() if p == m]

    def family(self, m):
        """A mode together with its sub-kinds: the fields its effective magnitude reads."""
        return [m] + self.children(m)

    def edges_into(self, comp, port):
        return [e for e in self.edges.values() if e.dst == (comp, port)]

    def edges_from(self, comp, port):
        return [e for e in self.edges.values() if e.src == (comp, port)]

    def comp_rows(self, comp):
        return [r for r in self.rows.values() if r.comp == comp]

    def doc_hash(self):
        return hashlib.sha256(json.dumps(self.doc, sort_keys=True, default=str).encode()).hexdigest()[:16]

    def summary(self):
        return {
            "name": self.name, "description": self.description,
            "fields": self.fields, "parent": self.parent,
            "conf_levels": self.conf_levels, "auth_levels": self.auth_levels,
            "components": {c.id: {"kind": c.kind, "label": c.label, "ins": c.ins, "outs": c.outs,
                                  "version": c.version, "on_edge": c.on_edge, "on_cycle": c.on_cycle,
                                  "learned": c.learned, "targets": c.targets}
                           for c in self.components.values()},
            "edges": {e.id: {"src": list(e.src), "dst": list(e.dst), "origin": e.origin, "label": e.label}
                      for e in self.edges.values()},
            "rows": {r.id: r.to_json() for r in self.rows.values()},
            "obs": {o.id: {"edge": o.edge, "doc_edge": o.doc_edge, "label": o.label, "log": o.log,
                           "tolerate": o.tolerate, "taint": o.taint,
                           "clearance": None if o.clearance is None else self.conf_levels[o.clearance],
                           "requires": None if o.requires is None else self.auth_levels[o.requires]}
                    for o in self.obs.values()},
            "use_cases": [{"id": u.id, "label": u.label, "entries": [e for e, _ in u.entries]} for u in self.use_cases],
            "warnings": self.warnings,
        }


# ---------------------------------------------------------------------------
# reading
# ---------------------------------------------------------------------------

def read_document(src) -> dict:
    """A path, a YAML/JSON string, or an already parsed dict."""
    if isinstance(src, dict):
        return copy.deepcopy(src)
    text = src
    if "\n" not in src and (src.endswith((".yaml", ".yml", ".json"))):
        with open(src, encoding="utf-8") as f:
            text = f.read()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return yaml.safe_load(text)


def load_model(src) -> Model:
    doc = read_document(src)
    problems = validate(doc)
    if problems:
        raise ModelError(problems)
    m = normalise(doc)
    problems = wellformed.check(m)
    if problems:
        raise ModelError(problems)
    return m


# ---------------------------------------------------------------------------
# validation of the document (before normalising)
# ---------------------------------------------------------------------------

def _mode_list(doc):
    """Top-level modes and sub-kinds from the `modes` key."""
    top, parent = [], {}
    for item in doc.get("modes", DEFAULT_MODES):
        if isinstance(item, str):
            top.append(item)
        elif isinstance(item, dict):
            if "name" in item:
                top.append(item["name"])
                for s in item.get("subkinds", []):
                    parent[s] = item["name"]
            else:
                for k, subs in item.items():
                    top.append(k)
                    for s in subs or []:
                        parent[s] = k
    return top, parent


def _parse_ref(ref):
    if not isinstance(ref, str) or "." not in ref:
        return None
    owner, port = ref.split(".", 1)
    return owner, port


def validate(doc) -> list:
    p = []
    if not isinstance(doc, dict):
        return ["the model must be a mapping"]
    for key in ("components", "edges"):
        if key not in doc:
            p.append(f"missing key '{key}'")
    if p:
        return p
    top, parent = _mode_list(doc)
    fields = set(top) | set(parent)
    if doc.get("worst_case_defaults", "llm") not in defaults.WORST_CASE:
        p.append(f"worst_case_defaults must be one of {', '.join(defaults.WORST_CASE)}, "
                 f"not {doc.get('worst_case_defaults')!r}")
    lat = doc.get("lattices", {})
    conf = lat.get("confidentiality", DEFAULT_CONF)
    auth = lat.get("authority", DEFAULT_AUTH)
    comps = {}
    for c in doc["components"]:
        cid = c.get("id")
        if not cid:
            p.append("a component without an id")
            continue
        if cid in comps or cid == "sys":
            p.append(f"duplicate or reserved component id '{cid}'")
        comps[cid] = c
        if c.get("kind") not in KINDS - {"guard"}:
            p.append(f"component {cid}: unknown kind {c.get('kind')!r}")
        for key, levels in (("authority", auth), ("requires", auth), ("clearance", conf)):
            if key in c and c[key] not in levels:
                p.append(f"component {cid}: {key} {c[key]!r} is not a level of its lattice")
        if "pass" in c:
            p.append(f"component {cid}: 'pass' is gone - every failure now passes through where the component "
                     f"forwards; declare what it absorbs with 'absorbs: [{{port, modes, reason}}]'")
        for a in c.get("absorbs", []):
            if a.get("port") not in c.get("in", []):
                p.append(f"component {cid}: absorbs on unknown input port {a.get('port')!r}")
            for mname in _absorbed_modes(a, []):
                if mname not in fields:
                    p.append(f"component {cid}: absorbs unknown mode {mname!r}")
            if not a.get("reason"):
                p.append(f"component {cid}: absorbing at {a.get('port')} needs a reason")
            if c.get("kind") == "llm":
                p.append(f"component {cid}: an LLM component passes nothing through, so it has nothing to absorb")
        for r in c.get("rows", []):
            rid = r.get("id")
            if not rid:
                p.append(f"component {cid}: a row without an id")
                continue
            when = r.get("when") or {}
            for port, pat in when.items():
                if port != "*" and port not in c.get("in", []):
                    p.append(f"row {rid}: unknown input port {cid}.{port}")
                if port == "*" and pat not in ("any", None, True):
                    p.append(f"row {rid}: 'any input' takes only 'any message'; "
                             f"name the input port to match a failure")
                if port == "*" and len(when) > 1:
                    p.append(f"row {rid}: 'any input' cannot be combined with named ports")
                if isinstance(pat, dict):
                    for mname in pat:
                        if mname not in fields:
                            p.append(f"row {rid}: unknown mode {mname!r}")
            then = r.get("then") or {}
            if not isinstance(then, dict):
                p.append(f"row {rid}: 'then' maps output ports to what is emitted there")
                continue
            for port, emits in then.items():
                if port not in c.get("out", []):
                    p.append(f"row {rid}: unknown output port {cid}.{port}")
                if _is_asis(emits):
                    continue
                if not isinstance(emits, dict):
                    p.append(f"row {rid}: emit on {port} must be a mapping of modes, or 'as it is'")
                    continue
                for mname, op in emits.items():
                    if mname not in fields:
                        p.append(f"row {rid}: unknown mode {mname!r}")
                    try:
                        _parse_op(op)
                    except ValueError as e:
                        p.append(f"row {rid}: {e}")
            failure_in = any(isinstance(pat, dict) for pat in when.values())
            failure_out = any(not _is_asis(e) and e for e in then.values())
            if not then and c.get("kind") == "llm":
                p.append(f"row {rid}: an LLM component passes nothing through, so a sink row has nothing to absorb")
            if not then and not failure_in:
                p.append(f"row {rid}: a row without an emission is a sink, and a sink names the failures it absorbs "
                         f"(e.g. when: {{port: {{late: 3}}}})")
            if not when and not failure_out:
                p.append(f"row {rid}: an internal fault (no condition) must emit a failure")
            if c.get("kind") == "llm" and failure_out and r.get("activation") == "never":
                p.append(f"row {rid}: an LLM row that emits a failure is never 'never' (the LLM rule); "
                         f"remove the row, or drop the default with a structural reason")
        for d in c.get("drop_defaults", []):
            if not d.get("reason"):
                p.append(f"component {cid}: dropping the default {d.get('port')}/{d.get('mode')} needs a reason")
    edge_ids = set()
    for e in doc["edges"]:
        eid = e.get("id")
        if not eid or eid in edge_ids:
            p.append(f"edge {eid!r}: missing or duplicate id")
        edge_ids.add(eid)
        for end, side in ((e.get("from"), "out"), (e.get("to"), "in")):
            ref = _parse_ref(end)
            if ref is None:
                p.append(f"edge {eid}: bad port reference {end!r}")
                continue
            owner, port = ref
            if owner == "sys":
                continue
            if owner not in comps:
                p.append(f"edge {eid}: unknown component {owner!r}")
            elif port not in comps[owner].get(side, []):
                p.append(f"edge {eid}: {owner} has no {side}put port {port!r}")
    gids = set()
    for g in doc.get("guards", []):
        _guard_edge(g)
        gid = g.get("id")
        if not gid or gid in comps or gid in gids:
            p.append(f"guard {gid!r}: missing or duplicate id")
        gids.add(gid)
        if g.get("edge") not in edge_ids:
            p.append(f"guard {gid}: unknown edge {g.get('edge')!r}")
        for t in g.get("targets", []):
            if "mode" in t and t["mode"] not in fields:
                p.append(f"guard {gid}: unknown target mode {t['mode']!r}")
            if "conf" in t and t["conf"] not in conf:
                p.append(f"guard {gid}: unknown confidentiality level {t['conf']!r}")
            if "auth" in t and t["auth"] not in auth:
                p.append(f"guard {gid}: unknown authority level {t['auth']!r}")
    for o in doc.get("observation_points", []):
        if o.get("edge") not in edge_ids:
            p.append(f"observation point {o.get('id')}: unknown edge {o.get('edge')!r}")
        for mname in (o.get("tolerate") or {}):
            if mname not in fields:
                p.append(f"observation point {o.get('id')}: unknown mode {mname!r}")
        into = next((e.get("to") for e in doc["edges"] if e.get("id") == o.get("edge")), None)
        receiver = _parse_ref(into)[0] if _parse_ref(into) else None
        for key, levels, what in (("clearance", conf, "clearance"), ("requires", auth, "authority")):
            if key not in o:
                continue
            if o[key] == "receiver":
                if receiver == "sys":
                    p.append(f"observation point {o.get('id')}: its receiver is outside the model "
                             f"({into}); name the {what} level instead of 'receiver'")
            elif o[key] not in levels:
                p.append(f"observation point {o.get('id')}: unknown {what} {o[key]!r}")
    sys_inputs = {_parse_ref(e["from"])[1] for e in doc["edges"]
                  if _parse_ref(e.get("from")) and _parse_ref(e["from"])[0] == "sys"}
    for u in doc.get("use_cases", []):
        for ent in _entries(u):
            if ent["port"] not in sys_inputs:
                p.append(f"use case {u.get('id')}: no edge leaves sys.{ent['port']}")
    if not doc.get("use_cases"):
        p.append("at least one use case is needed")
    return p


def _guard_edge(g):
    """The edge a guard cuts: `edge:` (YAML reads a bare `on:` key as the boolean true)."""
    if "edge" not in g:
        for k in ("on", True):
            if k in g:
                g["edge"] = g.pop(k)
    return g.get("edge")


def _entries(u):
    if "entries" in u:
        return [{"port": e["port"].replace("sys.", ""), "token": e.get("token") or {}} for e in u["entries"]]
    return [{"port": str(u.get("entry", "")).replace("sys.", ""), "token": u.get("token") or {}}]


ASIS = ("as it is", "as-is", "asis")


def _is_asis(emits):
    """An emission that sends the message on with nothing added: {} or 'as it is'."""
    return emits in (None, {}) or (isinstance(emits, str) and emits.strip().lower() in ASIS)


def _absorbed_modes(a, fields):
    """The modes an `absorbs` entry names ('all' expands to every mode field)."""
    ms = a.get("modes", a.get("mode", []))
    if ms == "all":
        return list(fields)
    return [ms] if isinstance(ms, str) else list(ms or [])


def _parse_op(op):
    """'const 9' | 9 | 'keep' | '+2' | 'max'  ->  (op, k)"""
    if isinstance(op, int):
        return ("const", max(0, min(10, op)))
    s = str(op).strip()
    if s == "keep":
        return ("keep", 0)
    if s == "max":
        return ("max", 0)
    if s.startswith("+"):
        return ("plus", int(s[1:]))
    if s.startswith("const"):
        return ("const", max(0, min(10, int(s.split()[1]))))
    raise ValueError(f"unknown emit operator {op!r} (use const k, keep, +k or max)")


def _parse_when(when):
    out = {}
    for port, pat in (when or {}).items():
        if pat in ("any", None, True):
            out[port] = {"any": True}
        else:
            out[port] = {"modes": {m: int(v) for m, v in pat.items()}}
    return out


# ---------------------------------------------------------------------------
# normalising
# ---------------------------------------------------------------------------

def normalise(doc) -> Model:
    top, parent = _mode_list(doc)
    fields = []
    for t in top:
        fields.append(t)
        fields += [s for s, p in parent.items() if p == t]
    lat = doc.get("lattices", {})
    conf = list(lat.get("confidentiality", DEFAULT_CONF))
    auth = list(lat.get("authority", DEFAULT_AUTH))

    comps = {}
    for c in doc["components"]:
        kind = c["kind"]
        ins, outs = list(c.get("in", [])), list(c.get("out", []))
        flow = c.get("flow")
        if flow is None:
            flow = {p: list(outs) for p in ins}
        # every failure passes through where a non-LLM component forwards, unless it is declared absorbed
        # (A6, pessimistic); an LLM component's failures come from its rows alone
        absorbs, passes = [], {}
        for a in c.get("absorbs", []):
            ms = _absorbed_modes(a, fields)
            absorbs.append({"port": a["port"], "modes": ms, "reason": a["reason"]})
        for p in ins:
            gone = set()
            for a in absorbs:
                if a["port"] == p:
                    for mname in a["modes"]:
                        gone |= {mname} | {s for s, q in parent.items() if q == mname}
            passes[p] = [] if kind == "llm" else [f for f in fields if f not in gone]
        comps[c["id"]] = Component(
            id=c["id"], kind=kind, label=c.get("label", ""), ins=ins, outs=outs,
            flow={p: list(v) for p, v in flow.items()}, passes=passes, absorbs=absorbs,
            trusted=c.get("trusted", kind not in ("external", "user")),
            authority=auth.index(c.get("authority", auth[-1])),
            raises=bool(c.get("raises", False)),
            clearance=conf.index(c.get("clearance", conf[-1])),
            requires=auth.index(c.get("requires", auth[0])),
            version=c.get("version"), pos=c.get("pos"))

    edges = {}
    for e in doc["edges"]:
        s, d = _parse_ref(e["from"]), _parse_ref(e["to"])
        edges[e["id"]] = Edge(id=e["id"], src=s, dst=d, label=e.get("label", ""), origin=e["id"])

    # guards: split their edge into a chain
    by_edge = {}
    for g in doc.get("guards", []):
        by_edge.setdefault(_guard_edge(g), []).append(g)
    seg_of = {}       # document edge -> last segment (what the receiver sees)
    for eid, gs in by_edge.items():
        e = edges[eid]
        final_dst = e.dst
        prev = e
        for i, g in enumerate(gs):
            prev.dst = (g["id"], "in")
            targets = []
            for t in g.get("targets", []):
                tt = {"decidable": bool(t.get("decidable", False))}
                if "mode" in t:
                    tt.update(kind="mode", mode=t["mode"], threshold=int(t.get("threshold", 1)))
                elif "taint" in t:
                    tt.update(kind="taint")
                elif "conf" in t:
                    tt.update(kind="conf", level=conf.index(t["conf"]))
                elif "auth" in t:
                    tt.update(kind="auth", level=auth.index(t["auth"]))
                targets.append(tt)
            comps[g["id"]] = Component(
                id=g["id"], kind="guard", label=g.get("label", g["id"]), ins=["in"], outs=["out"],
                flow={"in": ["out"]}, passes={"in": list(fields)}, trusted=True, authority=len(auth) - 1, raises=False,
                clearance=len(conf) - 1, requires=0, version=g.get("version"), targets=targets,
                learned=bool(g.get("learned", False)), closed_output=bool(g.get("closed_output", False)),
                fp_omission=int(g.get("fp_omission", 10 if g.get("learned") else 0)),
                on_edge=eid, pos=g.get("pos"))
            seg = Edge(id=f"{eid}__{g['id']}", src=(g["id"], "out"), dst=final_dst, label=e.label, origin=eid)
            edges[seg.id] = seg
            prev = seg
        seg_of[eid] = prev.id

    obs = {}
    doc_edges = {e["id"]: e for e in doc["edges"]}
    for o in doc.get("observation_points", []):
        tol = {m: int(v) for m, v in (o.get("tolerate") or {}).items()}
        # 'receiver': judge against the receiving component's own clearance / required authority. A point
        # that names neither is judged against a receiving component whose levels can be violated at all.
        recv = comps.get(_parse_ref(doc_edges[o["edge"]]["to"])[0])
        clr = o.get("clearance")
        req = o.get("requires")
        if clr is None and req is None and recv is not None:
            if recv.clearance < len(conf) - 1:
                clr = "receiver"
            if recv.requires > 0:
                req = "receiver"
        obs[o["id"]] = ObsPoint(
            id=o["id"], edge=seg_of.get(o["edge"], o["edge"]), doc_edge=o["edge"], label=o.get("label", ""),
            log=o.get("log", ""), tolerate=tol, taint=o.get("taint", "accept"),
            clearance=None if clr is None else (recv.clearance if clr == "receiver" else conf.index(clr)),
            requires=None if req is None else (recv.requires if req == "receiver" else auth.index(req)))

    ucs = []
    for u in doc.get("use_cases", []):
        entries = []
        for ent in _entries(u):
            tok = ent["token"]
            for e in edges.values():
                if e.src == ("sys", ent["port"]):
                    entries.append((e.id, _token(tok, fields, conf, auth)))
        ucs.append(UseCase(id=u["id"], label=u.get("label", u["id"]), entries=entries))

    rows = {}
    for c in doc["components"]:
        comp = comps[c["id"]]
        for r in c.get("rows", []):
            raw_then = r.get("then") or {}
            asis = [port for port, emits in raw_then.items() if _is_asis(emits)]
            then = {port: ({} if port in asis else {mname: _parse_op(op) for mname, op in emits.items()})
                    for port, emits in raw_then.items()}
            when = _parse_when(r.get("when"))
            failure_in = any("modes" in pat for pat in when.values())
            if not then:
                kind = "sink"           # consumes the failures it matches
            elif not failure_in and when and all(port in asis for port in then):
                kind = "fwd"            # plain forwarding: the message goes on, nothing is added
            else:
                kind = "row"            # a failure row (an internal fault when `when` is empty)
            act = r.get("activation", "always" if kind == "fwd" else "open")
            fixed = {"always": "A", "sometimes": "S", "never": "N"}.get(act)
            rows[r["id"]] = Row(id=r["id"], comp=c["id"], kind=kind, when=when, then=then, asis=asis,
                                open=fixed is None, llm=comp.llm and any(then.get(p) for p in then), fixed=fixed,
                                label=r.get("label", ""), reason=r.get("reason", ""))

    m = Model(name=doc.get("name", "model"), description=doc.get("description", ""), top_modes=top,
              fields=fields, parent=parent, conf_levels=conf, auth_levels=auth, components=comps,
              edges=edges, rows=rows, obs=obs, use_cases=ucs, claims=list(doc.get("claims", [])),
              decisions=list(doc.get("decisions", [])), doc=doc)
    for c in comps.values():
        for a in c.absorbs:
            m.decisions.append({"kind": "absorb", "component": c.id, "port": a["port"], "modes": a["modes"],
                                "reason": a["reason"]})
    defaults.add_worst_case_defaults(m)
    defaults.add_guard_rows(m)
    _mark_cycles(m)
    return m


def _token(tok, fields, conf, auth):
    b = {f: 0 for f in fields}
    for mname, v in (tok.get("modes") or {}).items():
        b[mname] = int(v)
    return {"b": b, "c": conf.index(tok["conf"]) if "conf" in tok else 0,
            "a": auth.index(tok["auth"]) if "auth" in tok else len(auth) - 1,
            "t": bool(tok.get("taint", False))}


def _mark_cycles(m):
    """A guard lies on a cycle if its output can reach its input (drops are then not allowed)."""
    succ = {}
    for e in m.edges.values():
        if e.src[0] != "sys" and e.dst[0] != "sys":
            succ.setdefault(e.src[0], set()).add(e.dst[0])
    for c in m.components.values():
        seen, stack = set(), list(succ.get(c.id, ()))
        while stack:
            x = stack.pop()
            if x == c.id:
                c.on_cycle = True
                break
            if x in seen:
                continue
            seen.add(x)
            stack += list(succ.get(x, ()))
