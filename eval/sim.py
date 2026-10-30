"""A second reading of the firing rule: a brute-force simulator in Python, compared with what TLC finds, per
use case and switch vector. It walks every firing order itself and shares no code with the generated module,
but it takes the loaded model, the cones and the tracked fields from the engine, so it tests the firing
translator and not those. Only the present/absent scale: every emission is `present`.

    python eval/sim.py [CASE ...] [--vectors N]

The exit code is 1 if any pair differs."""
import argparse, os, random, sys, tempfile, shutil
sys.setrecursionlimit(100000)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from epa.alethic import runs as R, tlc_runner
from epa.model import cone as C
from epa.model.load import load_model
from epa.translate import to_tla

CASES = ("wallet", "mcp-coding-agent", "smart-home")


def worst(a, b):
    return (frozenset(a[0]) | frozenset(b[0]), max(a[1], b[1]), min(a[2], b[2]), max(a[3], b[3]))


class Sim:
    def __init__(self, m, cone, F):
        self.m, self.k, self.F = m, cone, F
        self.fields = set(cone.fields)
        self.inc = set(cone.rows) | set(cone.always)
        self.track = to_tla._tracked(m, cone, self.inc)
        self.comps = cone.components
        self.top = m.auth_top

    def on(self, rid):
        return rid in self.k.always or rid in self.F

    def tok(self, t):
        return (frozenset(f for f, v in t["b"].items() if v and f in self.fields), t["c"] if self.track["c"] else 0,
                t["a"] if self.track["a"] else self.top, t["t"] if self.track["t"] else 0)

    def start(self, u):
        q, seen, lab = {}, {}, {}
        for eid, t in u.entries:
            if eid not in self.k.edges:
                continue
            msg = (True, self.tok(t))
            seen[eid] = {msg}
            lab[eid] = (True, msg[1])
            d = self.m.edges[eid].dst
            if d[0] in self.comps:
                q.setdefault(d, []).append(msg)
        return q, seen, lab

    def internal(self, c):
        return [r for r in self.m.comp_rows(c) if r.id in self.inc and not r.when and r.kind == "row"]

    def ready(self, st, c):
        q, _, _, _, spent = st
        return any(p[0] == c and v for p, v in q) or any(self.on(r.id) and r.id not in spent for r in self.internal(c))

    def transform(self, c, heads, spent):
        """heads: {port: msg}. Returns ({out port: (n, tok)}, rows applied, faults applied)."""
        m, comp = self.m, self.m.components[c]
        fired, faults, out = set(), set(), {}
        if comp.is_guard:
            n, (b, cc, a, t) = heads["in"]
            b, caught = set(b), False
            for tg in comp.targets:
                rid = tg["row"]
                if rid not in self.inc:
                    continue
                if tg["kind"] == "mode":
                    present = set(m.family(tg["mode"])) & b
                elif tg["kind"] == "taint":
                    present = t >= tg["level"]
                elif tg["kind"] == "conf":
                    present = cc > tg["level"]
                else:
                    present = a < tg["level"]
                if not present:
                    continue
                if self.on(rid):
                    if rid not in self.k.always:
                        fired.add(rid)
                    continue
                caught = True
                if tg["kind"] == "mode":
                    b -= set(m.family(tg["mode"]))
                elif tg["kind"] == "taint":
                    t = tg["level"] - 1
                elif tg["kind"] == "conf":
                    cc = tg["level"]
                else:
                    a = tg["level"]
            fp = f"fp.{c}"
            if fp in self.inc:
                if self.on(fp):
                    if fp not in self.k.always:
                        fired.add(fp)
                    if "omission" in self.fields:
                        b.add("omission")
            if not (caught and not n and not comp.on_cycle):
                out["out"] = (n, (frozenset(b), cc, a, t))
            return out, fired, faults
        rows = [r for r in m.comp_rows(c) if r.id in self.inc]
        applied = []
        for r in rows:
            if not r.when:
                ok = r.kind == "row" and r.id not in spent
            elif "*" in r.when:
                ok = bool(heads)
            else:
                ok = all(p in heads and all(set(m.family(g)) & set(heads[p][1][0]) for g in pat.get("modes", {}))
                         for p, pat in r.when.items())
            if ok and self.on(r.id):
                applied.append(r)
                if r.id not in self.k.always:
                    fired.add(r.id)
                if not r.when:
                    faults.add(r.id)
        sunk = {(p, f) for r in applied if r.kind == "sink" for p, pat in r.when.items()
                for g in pat.get("modes", {}) for f in m.family(g)}
        cs = [h[1] for h in heads.values()]
        conf = max([x[1] for x in cs] or [0])
        taint = max([x[3] for x in cs] + [comp.taint])
        auth = comp.authority if comp.raises else min([x[2] for x in cs] + [comp.authority])
        if not self.track["c"]:
            conf = 0
        if not self.track["t"]:
            taint = 0
        if not self.track["a"]:
            auth = self.top
        for qp in comp.outs:
            if not any(e.id in self.k.edges for e in m.edges_from(c, qp)):
                continue
            b, send, n = set(), False, False
            for p in comp.ins:
                if p in heads and qp in comp.flow.get(p, []):
                    send = True
                    n = n or heads[p][0]
                    b |= {f for f in heads[p][1][0] if f in comp.passes.get(p, []) and (p, f) not in sunk}
            for r in applied:
                if qp in r.asis:
                    ports = [p for p in comp.ins if p in heads] if "*" in r.when else list(r.when)
                    send = True
                    if r.kind == "fwd":
                        n = n or (any if "*" in r.when else all)(heads[p][0] for p in ports)
                    b |= {f for p in ports for f in heads[p][1][0] if f in comp.passes.get(p, []) and (p, f) not in sunk}
                if r.kind in ("row", "default") and qp in r.then and r.then[qp]:
                    send = True
                    b |= set(r.then[qp]) & self.fields
            if send:
                out[qp] = (n if self.track["n"] else True, (frozenset(b), conf, auth, taint))
        return out, fired, faults

    def step(self, st, c):
        q, seen, lab, fired, spent = st
        q2, seen2, lab2 = dict(q), dict(seen), dict(lab)
        heads = {}
        for (cc, p), v in q:
            if cc == c and v:
                heads[p] = v[0]
        q2 = {k: list(v) for k, v in q}
        for p in heads:
            q2[(c, p)] = q2[(c, p)][1:]
        out, f, faults = self.transform(c, heads, spent)
        seen2 = {k: set(v) for k, v in seen}
        lab2 = dict(lab)
        for e in self.k.edges:
            ed = self.m.edges[e]
            if ed.src[0] != c or ed.src[1] not in out:
                continue
            msg = out[ed.src[1]]
            if msg in seen2.get(e, set()):
                continue
            seen2.setdefault(e, set()).add(msg)
            lab2[e] = (lab2[e][0] or msg[0], worst(lab2[e][1], msg[1])) if e in lab2 else (msg[0], msg[1])
            if ed.dst[0] in self.comps:
                q2.setdefault(ed.dst, []).append(msg)
        return (freeze(q2), freeze_sets(seen2), tuple(sorted(lab2.items(), key=repr)), fired | frozenset(f), spent | frozenset(faults))

    def terminal(self, u):
        q, seen, lab = self.start(u)
        st = (freeze(q), freeze_sets(seen), tuple(sorted(lab.items(), key=repr)), frozenset(), frozenset())
        seen_st, stack, ends = {st}, [st], set()
        while stack:
            s = stack.pop()
            ready = [c for c in self.comps if self.ready(s, c)]
            if not ready:
                ends.add((s[3], s[2]))
            for c in ready:
                t = self.step(s, c)
                if t not in seen_st:
                    seen_st.add(t)
                    stack.append(t)
        return ends, len(seen_st)


def freeze(d):
    return tuple(sorted(((k, tuple(v)) for k, v in d.items() if v), key=repr))


def freeze_sets(d):
    return tuple(sorted(((k, frozenset(v)) for k, v in d.items()), key=repr))


def read_tlc(run, edges):
    lab = {}
    for e in edges:
        x = run.labels[e]
        if x["u"]:
            k = x["k"]
            b = k["b"] if isinstance(k["b"], dict) else {}
            lab[e] = (bool(x["n"]), (frozenset(f for f, v in b.items() if v), k["c"], k["a"], k["t"]))
    return (run.fired, tuple(sorted(lab.items(), key=repr)))


def compare(case, sample):
    m = load_model(f"{ROOT}/cases/{case}/model.yaml")
    m.schedule = "fifo"
    rnd = random.Random(7)
    bad = total = 0
    for k in C.cones(m, C.cells(m)):
        w = tempfile.mkdtemp(prefix="epa-sim-")
        dump, _ = tlc_runner.run(*to_tla.module_for(m, k, schedule="fifo"), w)
        runs = R.runs_from_dump(dump, k.edges)
        vecs = sorted({r.fire for r in runs.values()}, key=sorted)
        for F in rnd.sample(vecs, min(sample, len(vecs))):
            for u in (x for x in m.use_cases if x.id in k.use_cases):
                got = {read_tlc(r, k.edges) for r in runs.values() if r.uc == u.id and r.fire == F}
                ends, n = Sim(m, k, F).terminal(u)
                total += 1
                if got != ends:
                    bad += 1
                    print("DIFFERENT", case, k.obs, u.id, sorted(F), "tlc", len(got), "sim", len(ends))
                    for x in list(got ^ ends)[:2]:
                        print("   ", "tlc" if x in got else "sim", str(x)[:300])
        print(case, k.obs, "vectors sampled", min(sample, len(vecs)), "of", len(vecs), flush=True)
        shutil.rmtree(w, ignore_errors=True)
    print(case, "compared", total, "(use case, vector) pairs;", bad, "different")
    return total, bad


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cases", nargs="*", default=CASES)
    ap.add_argument("--vectors", type=int, default=30, help="switch vectors sampled per cone")
    a = ap.parse_args()
    res = [compare(c, a.vectors) for c in a.cases]
    print("all:", sum(t for t, _ in res), "pairs,", sum(b for _, b in res), "different")
    sys.exit(1 if any(b for _, b in res) else 0)
