"""Small random models with evidence, for the differential test.

    doc, evidence = random_case(seed, features=None)

A case has 1-3 components (LLM and deterministic) in a chain, optionally a second entry, a loop
and a fork-join; 0-2 guards; 1-2 use cases; 1-2 observation points; at most MAX_OPEN open rows in
total after the LLM defaults (most defaults are dropped to stay small); and random certificates
(some scoped, some stale or ill-formed) and witnesses. Witnesses are cut from real runs of the
reference (sometimes perturbed so that they conflict) and log only fields their point judges.

`features` switches off what the engine on `main` cannot load: see OLD_ENGINE.
"""
from __future__ import annotations

import itertools
import random

from . import semantics as S

MAX_OPEN = 6

FULL = {
    "absorbs": True,            # absorbs: structural absorption at an input port
    "forwarding": True,         # forwarding rows and "as it is" emissions
    "internal": True,           # internal-fault rows (when: {})
    "sinks": True,              # sink rows (no then)
    "scope": True,              # scoped certificates
    "implicit_receiver": True,  # obs naming neither clearance nor requires judge the receiver's
    "cycle": True,              # a loop (guards may sit on it)
    "guards": True,
    "learned": True,            # learned guards (fp row, no decidable target)
    "provenance": True,         # taint / conf / auth targets and cells
    "explicit_pass": False,     # write `pass: all` on every non-LLM component (the old format)
    "old_defaults": False,      # keep an LLM default only where no analyst row emits that mode
}
OLD_ENGINE = {**FULL, "absorbs": False, "forwarding": False, "internal": False, "sinks": False,
              "scope": False, "implicit_receiver": False, "explicit_pass": True, "old_defaults": True}

MODE_SETS = [
    ["omission", {"commission": ["oom"]}, "late"],
    ["omission", {"commission": ["oom", "dup"]}, "late", "value"],
    [{"commission": ["oom"]}, "late", "value"],
]
CONF_SETS = [["public", "personal"], ["public", "internal", "secret"]]
AUTH = ["none", "user", "admin"]


def _fields(modes):
    top, out = [], []
    for m in modes:
        if isinstance(m, str):
            top.append(m)
            out.append(m)
        else:
            for k, subs in m.items():
                top.append(k)
                out += [k] + list(subs)
    return top, out


class _Gen:
    def __init__(self, seed, features):
        self.rng = random.Random(seed)
        self.f = {**FULL, **(features or {})}
        self.budget = MAX_OPEN
        self.n_fixed_s = 0

    def chance(self, p):
        return self.rng.random() < p

    # ------------------------------------------------------------------------------------
    def model(self):
        rng, f = self.rng, self.f
        self.modes = rng.choice(MODE_SETS)
        self.top, self.fields = _fields(self.modes)
        self.conf = rng.choice(CONF_SETS)
        n = rng.randint(1, 3)
        comps = []
        for i in range(n):
            kind = "llm" if self.chance(0.45) else "deterministic"
            comps.append({"id": "ABC"[i], "kind": kind, "version": "v1", "in": ["i"], "out": ["o"], "rows": []})
        edges = [{"id": "e_in", "from": "sys.in", "to": f"{comps[0]['id']}.i"}]
        for a, b in zip(comps, comps[1:]):
            edges.append({"id": f"e_{a['id']}{b['id']}", "from": f"{a['id']}.o", "to": f"{b['id']}.i"})
        edges.append({"id": "e_out", "from": f"{comps[-1]['id']}.o", "to": "sys.out"})
        second_entry = None
        if self.chance(0.3):
            c = rng.choice(comps)
            c["in"].append("b")
            second_entry = c
            edges.append({"id": "e_in2", "from": "sys.in2", "to": f"{c['id']}.b"})
        self.loop = None
        if f["cycle"] and self.chance(0.35):
            i = rng.randrange(n)
            j = rng.randrange(i, n)
            src, dst = comps[j], comps[i]
            src["out"].append("r")
            if "b" not in dst["in"]:
                dst["in"].append("b")
            edges.append({"id": "e_loop", "from": f"{src['id']}.r", "to": f"{dst['id']}.b"})
            self.loop = (src, dst)
        self.fork = None
        if f["forwarding"] and n >= 2 and self.chance(0.35):
            k = rng.randrange(n - 1)
            a, b = comps[k], comps[k + 1]
            a["out"].append("x")
            b["in"].append("y")
            edges.append({"id": "e_fork", "from": f"{a['id']}.x", "to": f"{b['id']}.y"})
            self.fork = (a, b)
        if self.chance(0.25):                               # a side output, observed or not
            c = rng.choice(comps)
            c["out"].append("s")
            edges.append({"id": "e_side", "from": f"{c['id']}.s", "to": "sys.side"})
        for c in comps:                                     # sometimes a narrower flow
            if self.chance(0.3) and (len(c["in"]) > 1 or len(c["out"]) > 1):
                c["flow"] = {p: [q for q in c["out"] if self.chance(0.6)] for p in c["in"]}
            elif self.chance(0.2):                          # its output exists only through its rows
                c["flow"] = {p: [] for p in c["in"]}
            if c["kind"] != "llm":
                if f["provenance"] and self.chance(0.15):
                    c["trusted"] = False
                if f["explicit_pass"]:
                    c["pass"] = "all"
            if f["provenance"]:
                if self.chance(0.25):
                    c["authority"] = rng.choice(AUTH)
                if self.chance(0.15):
                    c["raises"] = True
                if self.chance(0.15):
                    c["clearance"] = rng.choice(self.conf)
                if self.chance(0.15):
                    c["requires"] = rng.choice(AUTH)
        doc = {"name": "random", "modes": self.modes,
               "lattices": {"confidentiality": self.conf, "authority": AUTH},
               "components": comps, "guards": [], "edges": edges}
        self.comps, self.edges = comps, edges
        if f["guards"]:
            self.guards(doc)
        for c in comps:
            self.rows(c)
        if self.fork and self.chance(0.7):
            a, b = self.fork
            b.setdefault("flow", {p: list(b["out"]) for p in b["in"]})
            b["flow"]["i"] = []
            b["flow"]["y"] = []
            b["rows"].append({"id": f"{b['id']}_join", "when": {"i": "any", "y": "any"},
                              "then": {"o": "as it is"}})
        for c in comps:
            if c["kind"] == "llm":
                self.defaults(c)
            elif f["absorbs"] and self.chance(0.25):
                c["absorbs"] = [{"port": rng.choice(c["in"]),
                                 "modes": "all" if self.chance(0.3) else [rng.choice(self.top)],
                                 "reason": "absorbed by construction"}]
            if not c["rows"]:
                del c["rows"]
        doc["use_cases"] = self.ucs = self.use_cases(second_entry)
        self.doc_guards = doc["guards"]
        doc["observation_points"] = self.observation_points()
        if not doc["guards"]:
            del doc["guards"]
        return doc

    # ------------------------------------------------------------------------------------
    def guards(self, doc):
        rng = self.rng
        for gi in range(rng.choice([0, 1, 1, 2])):
            if self.budget <= 2:
                break
            learned = self.f["learned"] and self.chance(0.25)
            kinds = ["mode", "mode", "mode"] + (["taint", "conf", "auth"] if self.f["provenance"] else [])
            n_t = 2 if self.chance(0.2) else 1
            chosen = []
            for k in rng.sample(kinds, len(kinds)):
                if k not in chosen:
                    chosen.append(k)
                if len(chosen) == n_t:
                    break
            if len(chosen) + learned > self.budget - 1:
                chosen = chosen[:1]
            targets = []
            for k in chosen:
                if k == "mode":
                    t = {"mode": rng.choice(self.fields), "threshold": rng.randint(1, 4)}
                elif k == "taint":
                    t = {"taint": True}
                elif k == "conf":
                    t = {"conf": rng.choice(self.conf[:-1])}
                else:
                    t = {"auth": rng.choice(AUTH[1:])}
                t["decidable"] = (not learned) and self.chance(0.65)
                targets.append(t)
            edge = "e_out" if self.loop and self.chance(0.5) else rng.choice(self.edges)["id"]
            g = {"id": f"G{gi + 1}", "edge": edge, "version": "g1", "targets": targets}
            if learned:
                g["learned"] = True
                if self.chance(0.3):
                    g["fp_omission"] = rng.randint(3, 10)
            if any("taint" in t for t in targets):
                g["closed_output"] = True
            self.budget -= len(targets) + learned
            doc["guards"].append(g)

    def _open_or_fixed(self, row, llm_failure):
        """Spend budget on an open row, or fix its activation."""
        if self.budget > 0 and self.chance(0.85):
            self.budget -= 1
            return row
        choices = ["always", "sometimes"] + ([] if llm_failure else ["never"])
        if self.n_fixed_s >= 2:
            choices.remove("sometimes")
        row["activation"] = self.rng.choice(choices)
        self.n_fixed_s += row["activation"] == "sometimes"
        return row

    def rows(self, c):
        rng, f = self.rng, self.f
        llm = c["kind"] == "llm"
        n_rows = rng.randint(1, 2) if llm else rng.randint(0, 2)
        for k in range(n_rows):
            if self.budget <= 0 and self.chance(0.5):
                break
            rid = f"{c['id']}_r{k + 1}"
            pat_kind = rng.choice(["star", "any", "fail", "fail"] + (["fork"] if len(c["in"]) > 1 else []))
            if pat_kind == "star":
                when = {"*": "any"}
            elif pat_kind == "any":
                when = {rng.choice(c["in"]): "any"}
            elif pat_kind == "fail":
                when = {rng.choice(c["in"]): {rng.choice(self.fields): rng.randint(1, 5)}}
            else:
                p, q = rng.sample(c["in"], 2)
                when = {p: "any", q: {rng.choice(self.fields): rng.randint(1, 4)}}
            has_fail = any(isinstance(v, dict) for v in when.values())
            then = {}
            for q in rng.sample(c["out"], 2 if len(c["out"]) > 1 and self.chance(0.2) else 1):
                if f["forwarding"] and not llm and has_fail and self.chance(0.15):
                    then[q] = "as it is"
                    continue
                ops = ["const"] * 3 + (["keep", "plus"] if has_fail else [])
                op = rng.choice(ops)
                m = rng.choice(self.fields)
                then[q] = {m: f"const {rng.randint(1, 10)}" if op == "const"
                           else ("keep" if op == "keep" else f"+{rng.randint(1, 3)}")}
            if llm and pat_kind == "star" and self.chance(0.4):        # a refinement of one default
                then = {rng.choice(c["out"]): {rng.choice(self.top): f"const {rng.randint(1, 9)}"}}
            row = {"id": rid, "when": when, "then": then}
            emits = any(isinstance(e, dict) for e in then.values())
            c["rows"].append(self._open_or_fixed(row, llm and emits))
        if not llm and f["internal"] and self.chance(0.2):
            row = {"id": f"{c['id']}_fault", "when": {},
                   "then": {rng.choice(c["out"]): {rng.choice(self.fields): f"const {rng.randint(1, 10)}"}}}
            c["rows"].append(self._open_or_fixed(row, False))
        if not llm and f["sinks"] and self.chance(0.2):
            row = {"id": f"{c['id']}_sink", "when": {rng.choice(c["in"]): {rng.choice(self.fields): rng.randint(1, 4)}}}
            c["rows"].append(self._open_or_fixed(row, False))

    def defaults(self, c):
        """Keep a default only if the budget allows; drop the rest with a reason."""
        drops = []
        for q in c["out"]:
            for m in self.top:
                replaced = any(r.get("when") in ({"*": "any"},) + (({c["in"][0]: "any"},) if len(c["in"]) == 1 else ())
                               and (r.get("then") or {}) == {q: (r.get("then") or {}).get(q)}
                               and isinstance(r["then"].get(q), dict)
                               and list(r["then"][q]) == [m] and str(r["then"][q][m]).startswith("const")
                               for r in c["rows"])
                if replaced:
                    continue
                emitted = any(isinstance(r.get("then", {}).get(q), dict) and m in r["then"][q] for r in c["rows"])
                keep = self.budget > 0 and self.chance(0.12) and not (self.f["old_defaults"] and emitted)
                if keep:
                    self.budget -= 1
                else:
                    drops.append({"port": q, "mode": m, "reason": "outside this test"})
        if drops:
            c["drop_defaults"] = drops

    def hot_fields(self):
        """The fields some row, kept default or starting token can put on an edge."""
        hot = set()
        for c in self.comps:
            for r in c.get("rows", []):
                for e in (r.get("then") or {}).values():
                    if isinstance(e, dict):
                        hot |= set(e)
            if c["kind"] == "llm":
                dropped = {(d["port"], d["mode"]) for d in c.get("drop_defaults", [])}
                hot |= {m for q in c["out"] for m in self.top if (q, m) not in dropped}
        for u in self.ucs:
            for ent in u["entries"]:
                hot |= set((ent["token"].get("modes") or {}))
        if any(g.get("learned") for g in self.doc_guards):
            hot.add("omission")
        return hot & set(self.fields)

    def use_cases(self, second_entry):
        rng = self.rng
        ucs = []
        for k in range(rng.choice([1, 1, 2])):
            ports = ["in"] if second_entry is None else rng.choice([["in"], ["in", "in2"], ["in2"]] if k else [["in"], ["in", "in2"]])
            entries = []
            for p in ports:
                tok = {}
                if self.chance(0.3):
                    tok["modes"] = {rng.choice(self.fields): rng.randint(1, 6)}
                if self.f["provenance"]:
                    if self.chance(0.3):
                        tok["taint"] = True
                    if self.chance(0.4):
                        tok["conf"] = rng.choice(self.conf)
                    if self.chance(0.4):
                        tok["auth"] = rng.choice(AUTH)
                entries.append({"port": p, "token": tok})
            ucs.append({"id": f"u{k + 1}", "entries": entries})
        return ucs

    def observation_points(self):
        rng, f = self.rng, self.f
        obs = []
        edges = [e for e in self.edges if not e["from"].startswith("sys.")] or self.edges
        picks = rng.sample(edges, min(len(edges), rng.choice([1, 1, 2])))
        for k, e in enumerate(picks):
            o = {"id": f"o{k + 1}", "edge": e["id"]}
            tol = {}
            hot = sorted(self.hot_fields()) or self.fields
            for _ in range(rng.choice([1, 1, 2])):
                m = rng.choice(hot) if self.chance(0.75) else rng.choice(self.fields)
                tol[m] = rng.choice([1, 1, 2, 3, 5])
            o["tolerate"] = tol
            receiver = e["to"].split(".")[0]
            comp = next((c for c in self.comps if c["id"] == receiver), None)
            if f["provenance"]:
                if self.chance(0.3):
                    o["taint"] = "reject"
                if self.chance(0.3):
                    o["clearance"] = "receiver" if comp is not None and self.chance(0.3) else rng.choice(self.conf[:-1])
                if self.chance(0.3):
                    o["requires"] = "receiver" if comp is not None and self.chance(0.3) else rng.choice(AUTH[1:])
            if comp is not None and "clearance" not in o and "requires" not in o and not f["implicit_receiver"]:
                comp.pop("clearance", None)                 # the old engine has no implicit judgement
                comp.pop("requires", None)
            obs.append(o)
        return obs


# ----------------------------------------------------------------------------------------------
# evidence
# ----------------------------------------------------------------------------------------------

def _evidence(rng, doc, features):
    M = S.Model(doc)
    open_rows = [r for r in M.rows.values() if r.fixed is None]
    certs = []
    by_comp = {}
    for r in open_rows:
        by_comp.setdefault(r.comp, []).append(r)
    for k in range(rng.choice([0, 1, 1, 2, 3])):
        if not by_comp:
            break
        cid = rng.choice(sorted(by_comp))
        rows = rng.sample(by_comp[cid], min(len(by_comp[cid]), rng.choice([1, 1, 2])))
        cert = {"id": f"c{k + 1}", "component": cid}
        for r in rows:
            dom = list(r.domain)
            x = rng.choice(dom) if rng.random() < 0.85 else rng.choice("NSA")   # sometimes ill-formed
            if r.kind == "leak" and rng.random() < 0.5:
                cert.setdefault("targets", {})[r.target["key"]] = {"N": "never", "S": "sometimes", "A": "always"}[x]
            else:
                cert.setdefault("rows", {})[r.id] = x
        comp = M.comps[cid]
        if comp.version is not None:
            cert["version"] = comp.version if rng.random() < 0.9 else comp.version + "-old"
        if features["scope"] and rng.random() < 0.35:
            ucs = sorted(M.use_cases)
            cert["scope"] = rng.sample(ucs, rng.randint(1, len(ucs)))
        certs.append(cert)
    wits = []
    judged = {}
    for oid, cid, kind, fld, thr in M.cells():
        judged.setdefault(oid, []).append((kind, fld))
    for k in range(rng.choice([0, 1, 1, 2])):
        uc = rng.choice(sorted(M.use_cases))
        on = set()
        for r in M.rows.values():
            act = r.fixed or rng.choice(r.domain)
            if act == "A" or (act == "S" and rng.random() < 0.5):
                on.add(r.id)
        lab = S.propagate(M, uc, on)
        at = {}
        for oid in rng.sample(sorted(M.obs), rng.randint(1, len(M.obs))):
            L = lab[M.obs[oid].seg]
            entry = {}
            if rng.random() < 0.3 or (not L.used and rng.random() < 0.5):
                entry["used"] = L.used
            for kind, fld in judged[oid]:
                if kind == "mode":
                    v = S.effective(M, L.tok, fld) if L.used else 0
                    if rng.random() < 0.45:
                        entry.setdefault("modes", {})[fld] = [v, v]
                    else:
                        entry.setdefault("modes", {})[fld] = [1, 10] if v >= 1 else [0, 0]
                elif kind == "taint" and L.used:
                    entry["taint"] = L.tok.t
                elif kind == "conf" and L.used:
                    entry["conf"] = [L.tok.c, L.tok.c] if rng.random() < 0.6 else [L.tok.c, len(M.conf) - 1]
                elif kind == "auth" and L.used:
                    entry["auth"] = [L.tok.a, L.tok.a] if rng.random() < 0.6 else [0, L.tok.a]
            if entry:
                at[oid] = entry
        if at and rng.random() < 0.12:                      # a perturbed reading of one field
            oid = rng.choice(sorted(at))
            entry = at[oid]
            if entry.get("modes"):
                fld = rng.choice(sorted(entry["modes"]))
                lo, hi = entry["modes"][fld]
                entry["modes"][fld] = [0, 0] if lo >= 1 else [1, 10]
            elif "taint" in entry:
                entry["taint"] = not entry["taint"]
            elif "used" in entry:
                entry["used"] = not entry["used"]
        if not at:
            continue
        w = {"id": f"w{k + 1}", "at": at}
        if rng.random() < 0.85:
            w["use_case"] = uc
        wits.append(w)
    return {"certificates": certs, "witnesses": wits}


def random_case(seed, features=None):
    """A small valid model in the target format (or the old format, with OLD_ENGINE) and evidence."""
    feats = {**FULL, **(features or {})}
    for attempt in itertools.count():
        g = _Gen(seed * 1009 + attempt, feats)
        doc = g.model()
        try:
            M = S.Model(doc)
        except S.IllFormed:
            continue
        n_open = sum(1 for r in M.rows.values() if r.fixed is None)
        if n_open > MAX_OPEN or not M.cells():
            continue
        rng = random.Random(seed * 7919 + attempt)
        return doc, _evidence(rng, doc, feats)
