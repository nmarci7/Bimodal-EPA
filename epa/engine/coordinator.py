"""The coordinator: Figure 2's loop.

For every cone (one observation point, or a part of one):
  1. generate  - the epistemic layer fixes which rows certificates in force pin; only the firing
                 choices those pins allow are needed, so the rest is never explored;
  2. run       - the cone is translated to TLA+ and TLC explores the needed runs (cached by the
                 cone's behaviour hash, so repeated questions cost nothing);
  3. reconcile - for each cell, clingo grounds the candidates against the runs and the evidence and
                 reads off the statuses the remaining candidates give the failure;
  4. conflict  - if nothing remains, the remaining runs are explored, the minimal conflict sets are
                 found, their certificates suspended, and the cell is reconciled again;
  5. derive    - verdict, advice, reasons, root causes, candidate counts.
Then the certify-next ranking, the claims, the re-verify list and the unmatched failures.
"""
from __future__ import annotations

import itertools
import os
import time

import clingo

from ..alethic import runs as R
from ..alethic import tlc_runner
from ..epistemic import verdicts as V
from ..epistemic.reason import CellProblem, candidate_space
from ..intake import cert_import, log_import
from ..model import cone as C
from ..model import wellformed
from ..translate import to_tla
from .cache import RunCache, covers


COUNT_CAP = 5000   # remaining candidates are counted up to this many


class Engine:
    def __init__(self, model, workroot, schedule="rounds", on_event=None, cache=None):
        self.m = model
        self.workroot = workroot
        os.makedirs(workroot, exist_ok=True)
        self.cache = cache or RunCache(os.path.join(workroot, "runs.sqlite"))
        self.schedule = schedule
        self.on_event = on_event or (lambda e: None)
        self.events = []
        self.tlc_calls = []
        self.t0 = time.time()

    # ------------------------------------------------------------------ events
    def emit(self, step, msg, **data):
        e = {"t": round(time.time() - self.t0, 3), "step": step, "msg": msg, **data}
        self.events.append(e)
        self.on_event(e)

    # ------------------------------------------------------------------ evidence register
    def register(self, evidence):
        m = self.m
        decisions = evidence.get("decisions", [])
        withdrawn = {d["certificate"] for d in decisions if d.get("kind") == "withdraw-cert"}
        rejected = {d["witness"] for d in decisions if d.get("kind") == "reject-witness" and d.get("second_reviewer")}
        certs = []
        for c in evidence.get("certificates", []):
            state, reason, rows = cert_import.classify(c, m, withdrawn)
            certs.append({**c, "state": state, "reason": reason, "resolved": rows,
                          "reverify": cert_import.reverify(c, m)})
        wits = []
        for w in evidence.get("witnesses", []):
            state, reason = log_import.classify_witness(w, m, rejected)
            wits.append({**w, "state": state, "reason": reason})
        return {"certificates": certs, "witnesses": wits, "decisions": decisions}

    # ------------------------------------------------------------------ runs
    def ensure(self, cone, want):
        """Make sure every firing choice consistent with some pin set in `want` has been explored."""
        key = cone.key(self.m)
        missing = [w for w in want if not self.cache.covered(key, w)]
        if not missing:
            return None
        done = [c for c, _ in self.cache.coverage(key)]
        module, cfg = to_tla.module_for(self.m, cone, want=missing, done=done, schedule=self.schedule)
        n_vec = _count_vectors(cone.rows, missing, done)
        self.emit("tlc", f"TLC explores {n_vec} firing choice(s) x {len(cone.use_cases)} use case(s) "
                         f"for {cone.obs} ({len(cone.rows)} open rows)", cone=key, obs=cone.obs,
                  vectors=n_vec, rows=cone.rows)
        dump, stats = tlc_runner.run(module, cfg, self.workroot)
        runs = R.runs_from_dump(dump, cone.edges)
        info = {k: stats.get(k) for k in ("hash", "generated", "distinct", "depth", "seconds", "cached", "tlc_version")}
        info["runs"] = len(runs)
        info["vectors"] = n_vec
        self.tlc_calls.append({"cone": key, "obs": cone.obs, **info})
        self.cache.add(key, missing, runs, info)
        bad = [r for r in runs.values() if r.terminal_variants > 1]
        self.emit("tlc-done", f"{stats.get('distinct', '?')} distinct states, depth {stats.get('depth', '?')}, "
                              f"{len(runs)} runs" + (" (cached)" if stats.get("cached") else f", {stats.get('seconds')} s"),
                  cone=key, module=stats["hash"], **{k: v for k, v in info.items() if k != "hash"},
                  nonconfluent=len(bad))
        return stats["hash"]

    # ------------------------------------------------------------------ evidence across cells
    def applies(self, cert, cone):
        """The scope rule: a certificate counts for a cell only if its scope covers every use case in which
        the cell's point can carry a message (no scope: every use case). A use case outside the scope does
        not stand in the way if none of the rows the certificate states can fire in it: then the statement
        changes none of that use case's runs."""
        scope = cert.get("scope")
        if not scope:
            return True
        ucs = cone.scope_ucs if cone.scope_ucs is not None else cone.use_cases
        return all(self.inert(r, u) for u in set(ucs) - set(scope) for r in cert["resolved"])

    def inert(self, rid, u):
        """No run of use case u can make this row fire (an over-approximation of what reaches it)."""
        m = self.m
        row = m.rows.get(rid)
        if row is None:
            return False
        if not hasattr(m, "_possible"):
            m._normal_edges = C.normal_edges(m)
            m._possible = C.possible(m)
        pos = m._possible[u]
        comp = m.components[row.comp]
        inp = {p: [e.id for e in m.edges_into(comp.id, p) if e.id in pos] for p in comp.ins}
        fields_at = {p: set().union(*[pos[e] for e in es]) if es else set() for p, es in inp.items()}
        if row.kind in ("leak", "fp"):
            if not inp.get("in"):
                return True
            t = row.target or {}
            return row.kind == "leak" and t.get("kind") == "mode" and not (set(m.family(t["mode"])) & fields_at["in"])
        return not C._trigger_possible(m, comp, row, inp, fields_at)

    def witness_cone(self, w):
        """One cone that computes every field a witness logs, at every point it logs: the union of the
        cones of those fields there. Its runs decide exactly whether a candidate allows a matching run."""
        m = self.m
        parts = []
        for obs_id, logged in w["at"].items():
            fs = [C.Cell("mode", f, obs_id) for f in (logged.get("modes") or {})]
            fs += [C.Cell(k, k, obs_id) for k in ("taint", "conf", "auth") if k in logged]
            if not fs:      # only `used` is logged: any cell's cone holds the rows that create the message
                fs = [C.Cell("mode", m.top_modes[0], obs_id)]
            parts += [C.cone_of_cell(m, c) for c in fs]
        u = lambda attr: sorted(set().union(*[set(getattr(k, attr)) for k in parts]))
        rel = set().union(*[k.rel for k in parts])
        fields = [f for f in m.fields if any(f in k.fields for k in parts)]
        return C.Cone(cells=[c for k in parts for c in k.cells], obs=parts[0].obs, components=u("components"),
                      edges=u("edges"), use_cases=u("use_cases"), rows=u("rows"), always=u("always"),
                      fields=fields, rel=rel)

    def suspension(self, reg):
        """The certificates the evidence refutes, for the whole model: every certificate in a subset-minimal
        set that, with one witness, leaves no candidate (Reiter), and any two certificates that pin one row
        to different activations. Witnesses alone leaving no candidate mean the model lacks a path."""
        m = self.m
        certs = [c for c in reg["certificates"] if c["state"] == "in force"]
        wits = [w for w in reg["witnesses"] if w["state"] == "in force"]
        susp, conflicts, lacking = set(), [], []
        pinned = {}
        for c in certs:
            for r, x in c["resolved"].items():
                pinned.setdefault(r, {}).setdefault(x, set()).add(c["id"])
        for r, by in pinned.items():
            if len(by) > 1:
                ids = set().union(*by.values())
                susp |= ids
                conflicts.append({"certificates": sorted(ids), "witness": None, "row": r})
            row = m.rows.get(r)
            if row is not None and not row.open:
                # the model fixes this row: a certificate stating another activation leaves no candidate
                for x, ids in by.items():
                    if x != row.fixed:
                        susp |= ids
                        conflicts.append({"certificates": sorted(ids), "witness": None, "row": r})
        for w in wits:
            cone = self.witness_cone(w)
            self.ensure(cone, [{}])
            runs = []
            for i, r in enumerate(self.cache.runs(cone.key(m)).values(), start=1):
                ok = R.matches(m, w["at"], r, w.get("use_case"))
                runs.append({"id": i, "uc": r.uc, "fires": set(r.fire), "uses": False, "reaches": False,
                             "matches": {w["id"]} if ok else set()})
            mine = [c for c in certs if not c.get("scope") or not w.get("use_case") or w["use_case"] in c["scope"]]
            cl = [(c["id"], c["resolved"]) for c in mine if set(c["resolved"]) & set(cone.rows)]
            prob = CellProblem(m, cone.rows, runs, cl, [w["id"]])
            if not prob.satisfiable(set(), {w["id"]}):
                lacking.append(w["id"])
                self.emit("conflict", f"witness {w['id']} matches no run of the model: the model lacks a path",
                          witness=w["id"])
                continue
            on = {k for k, _ in cl}
            if prob.satisfiable(on, {w["id"]}):
                continue
            for S in prob.minimal_conflicts(on, {w["id"]}):
                susp |= S
                conflicts.append({"certificates": sorted(S), "witness": w["id"]})
                self.emit("conflict", f"witness {w['id']} contradicts {sorted(S)}: suspended", witness=w["id"],
                          certificates=sorted(S))
        return {"suspended": susp, "conflicts": conflicts, "lacking": lacking}

    # ------------------------------------------------------------------ one cell
    def wcone(self, w):
        if not hasattr(self, "_wcones"):
            self._wcones = {}
        if w["id"] not in self._wcones:
            self._wcones[w["id"]] = self.witness_cone(w)
        return self._wcones[w["id"]]

    def witness_runs(self, w, cone):
        """The runs of a witness's own cone, each with whether it matches everything the witness logged."""
        self.ensure(cone, [{}])
        out = {}
        for r in self.cache.runs(cone.key(self.m)).values():
            k = (r.uc, frozenset(r.fire), R.matches(self.m, w["at"], r, w.get("use_case")))
            out[k] = k
        return list(out)

    def problem(self, cone, cell, certs, witnesses, extra_certs=()):
        m = self.m
        rows = cone.cell_rows[cell.id]
        certs = [c for c in certs if self.applies(c, cone)]
        key = cone.key(m)
        allruns = self.cache.runs(key)
        # A witness constrains this cell through the rows its own cone shares with the cell's, directly or
        # through other witnesses. Each linked witness brings the runs of its cone, so that a remaining
        # candidate is one the whole model's evidence leaves, projected onto this cell's rows.
        linked, reach = {}, set(rows)
        grew = True
        while grew:
            grew = False
            for w in witnesses:
                if w["id"] in linked:
                    continue
                wc = self.wcone(w)
                if set(wc.rows) & reach:
                    linked[w["id"]] = (w, wc)
                    reach |= set(wc.rows)
                    grew = True
        wruns = {wid: (set(wc.rows), self.witness_runs(w, wc)) for wid, (w, wc) in linked.items()}
        extra_rows = sorted(reach - set(rows))
        proj = {wid: (w["at"], w.get("use_case")) for wid, (w, _) in linked.items()}
        grouped = {}
        for r in allruns.values():
            k = (r.uc, frozenset(r.fire & set(rows)))
            out = (R.used(m, cell, r), R.reaches(m, cell, r), frozenset())
            g = grouped.setdefault(k, {"out": out, "fired": set(), "sev": 0, "example": r, "agree": True})
            if g["out"] != out:
                g["agree"] = False
            g["fired"] |= set(r.fired & set(rows))
            g["sev"] = max(g["sev"], R.severity(m, cell, r))
        runs = []
        for i, ((uc, F), g) in enumerate(sorted(grouped.items(), key=lambda kv: (kv[0][0], sorted(kv[0][1]))), start=1):
            uses, reaches, matched = g["out"]
            runs.append({"id": i, "uc": uc, "fires": set(F), "uses": uses, "reaches": reaches,
                         "matches": set(matched), "fired": g["fired"], "sev": g["sev"], "example": g["example"],
                         "agree": g["agree"]})
        cert_list = [(c["id"], c["resolved"]) for c in certs if set(c["resolved"]) & reach]
        cert_list += list(extra_certs)
        prob = CellProblem(m, rows, runs, cert_list, list(proj), extra_rows=extra_rows, wruns=wruns)
        return prob, runs, proj

    def decide(self, cone, cell, certs_on, wits_on, register):
        m = self.m
        in_force = [c for c in register["certificates"] if c["state"] == "in force"]
        witnesses = [w for w in register["witnesses"] if w["state"] == "in force"]
        rows = cone.cell_rows[cell.id]
        prob, runs, proj = self.problem(cone, cell, in_force, witnesses)
        cert_ids = {k for k in prob.cert_ids}
        gs = self.gsusp
        # the suspension is the whole model's (computed once per analysis); a cell reports the part of it
        # that concerns its own rows
        suspended = gs["suspended"] & cert_ids
        conflicts = [set(c["certificates"]) for c in gs["conflicts"] if set(c["certificates"]) & cert_ids]
        on = (set(certs_on) & cert_ids) - gs["suspended"]
        won = {w for w in wits_on if w in prob.wit_ids}
        lacks_path = bool(gs["lacking"])
        b = None if lacks_path else prob.brave(on, won)
        if b is None and not lacks_path:
            # not expected once the global suspension is applied; kept as a safety net: explore every
            # firing choice, then blame the witnesses or find this cell's own conflict sets
            self.ensure(cone, [{}])
            prob, runs, proj = self.problem(cone, cell, in_force, witnesses)
            if not prob.satisfiable(set(), won):
                lacks_path = True
                self.emit("conflict", f"{cell.id}: the witnesses alone leave no candidate - the model lacks a path",
                          cell=cell.id)
            else:
                extra = prob.minimal_conflicts(on, won)
                conflicts += extra
                more = set().union(*extra) if extra else set()
                suspended |= more
                self.extra_susp |= more
                self.emit("conflict", f"{cell.id}: evidence in conflict; minimal sets "
                                      f"{[sorted(c) for c in extra]}; suspending {sorted(more)}",
                          cell=cell.id, conflicts=[sorted(c) for c in extra])
                on = on - more
                b = prob.brave(on, won)
        verdict = "conflict" if lacks_path else V.verdict_of(b["seen"] if b else None)
        seen = b["seen"] if b else None
        res = {
            "cell": cell.id, "kind": cell.kind, "field": cell.field, "obs": cell.obs,
            "verdict": verdict, "statuses": V.statuses_for_display(seen), "raw": seen,
            "per_uc": b["per_uc"] if b else {}, "advice": V.advice(verdict, seen),
            "conflicts": sorted(sorted(c) for c in {frozenset(c) for c in conflicts}),
            "suspended": sorted(suspended), "lacks_path": lacks_path,
            "rows": rows, "cone": cone.key(m), "fields": cone.fields,
            "witnesses_used": sorted(won), "certs_used": sorted(on),
            "scope_withheld": [{"certificate": c["id"], "scope": c.get("scope"),
                                "uncovered": sorted(u for u in set(cone.scope_ucs or cone.use_cases) - set(c.get("scope") or [])
                                                    if not all(self.inert(r, u) for r in c["resolved"]))}
                               for c in in_force if set(c["resolved"]) & set(rows) and not self.applies(c, cone)],
            "witness_projection": {w: p for w, (p, _) in proj.items()},
        }
        space = candidate_space(m, rows)
        if b:
            n = prob.count(on, won, cap=COUNT_CAP + 1)
            res["candidates"] = {"space": space, "remaining": n if n <= COUNT_CAP else None,
                                 "at_least": None if n <= COUNT_CAP else COUNT_CAP}
        else:
            res["candidates"] = {"space": space, "remaining": 0, "at_least": None}
        res["severity"] = max([r["sev"] for r in runs] or [0])
        # root causes: minimal sets of firing rows behind reaching runs some remaining candidate admits
        if b:
            reach_sets = [frozenset(r["fired"]) for r in runs if r["reaches"] and r["id"] in b["admits"]]
            minimal = _minimal(reach_sets)
            res["root_causes"] = [sorted(s) for s in minimal]
            minimal = set(minimal)
            ex = next((r for r in runs if r["reaches"] and r["id"] in b["admits"]
                       and frozenset(r["fired"]) in minimal), None)
            res["example_run"] = {"uc": ex["uc"], "fire": sorted(ex["example"].fire)} if ex else None
        else:
            res["root_causes"], res["example_run"] = [], None
        # reasons
        res["reasons"] = self.reasons(cone, cell, prob, runs, on, won, verdict, register)
        res["nonconfluent"] = sum(1 for r in runs if not r["agree"])
        return res

    def reasons(self, cone, cell, prob, runs, on, won, verdict, register):
        m = self.m
        out = {"structural": False, "certificates": [], "decisions": []}
        if verdict not in ("guarantee", "exposed"):
            return out
        rows = cone.cell_rows[cell.id]
        if not [r for r in rows if m.rows[r].open]:
            out["structural"] = True
        elif all((r["reaches"] if verdict == "exposed" else not r["reaches"]) or not r["uses"] for r in runs) and \
                self.cache.covered(cone.key(m), {}):
            out["structural"] = True
        for k in sorted(on):
            others = on - {k}
            pins = self.pins(register, others, rows)
            if pins is not None:
                self.ensure(cone, [pins])
                prob2, _, _ = self.problem(cone, cell, [c for c in register["certificates"] if c["state"] == "in force"],
                                           [w for w in register["witnesses"] if w["state"] == "in force"])
                b2 = prob2.brave(others & set(prob2.cert_ids), won)
                if V.verdict_of(b2["seen"] if b2 else None) != verdict:
                    out["certificates"].append(k)
        # dropped defaults that could have put the failure here
        U = set(cone.components)
        crel = cone.cell_rel.get(cell.id, set())
        for d in m.decisions:
            if d.get("kind") == "drop-default" and d["component"] in U:
                if any((e.id, d["mode"]) in crel for e in m.edges_from(d["component"], d["port"])):
                    out["decisions"].append(d)
        if out["certificates"] or out["decisions"]:
            out["structural"] = False
        return out

    def pins(self, register, cert_ids, rows):
        """The pin set {row: N|A} the given certificates impose on these rows; None if they contradict."""
        pins = {}
        for c in register["certificates"]:
            if c["id"] not in cert_ids:
                continue
            for r, x in c["resolved"].items():
                if r in rows and x in ("N", "A"):
                    if pins.get(r, x) != x:
                        return None
                    pins[r] = x
        return pins

    # ------------------------------------------------------------------ the whole analysis
    def analyse(self, evidence=None, only_cells=None, rank=True):
        m = self.m
        evidence = evidence or {}
        n_g = sum(1 for c in m.components.values() if c.is_guard)
        self.emit("model", f"model {m.name}: {len(m.components) - n_g} components, {n_g} guards, "
                           f"{len(m.edges)} edge segments, {len(m.rows)} rows, {len(m.obs)} observation point(s), "
                           f"{len(m.use_cases)} use case(s)")
        reg = self.register(evidence)
        certs_on = {c["id"] for c in reg["certificates"] if c["state"] == "in force"}
        wits_on = {w["id"] for w in reg["witnesses"] if w["state"] == "in force"}
        self.emit("evidence", f"{len(certs_on)} certificate(s) in force, {len(wits_on)} witness(es) in force",
                  certificates={c["id"]: c["state"] for c in reg["certificates"]},
                  witnesses={w["id"]: w["state"] for w in reg["witnesses"]})
        cell_list = C.cells(m, only_cells)
        cone_list = C.cones(m, cell_list)
        self.emit("cells", f"{len(cell_list)} cells in {len(cone_list)} cone(s)",
                  cells=[c.id for c in cell_list])
        # which certificates the evidence refutes is a question about the whole model, settled before
        # any cell is decided, so that every cell sees the same suspension
        self.gsusp = self.suspension(reg)
        self.extra_susp = set()
        for _ in range(2):
            results = []
            for cone in cone_list:
                all_rows = cone.rows
                usable = {c["id"] for c in reg["certificates"]
                          if c["id"] in certs_on and self.applies(c, cone)} - self.gsusp["suspended"]
                pins = self.pins(reg, usable, all_rows)
                want = [pins] if pins is not None else [{}]
                pruned = _count_vectors(all_rows, [{}], []) - _count_vectors(all_rows, want, [])
                self.emit("cone", f"cone at {cone.obs}: {len(cone.cells)} cell(s), rows {', '.join(all_rows) or '(none)'}"
                                  + (f"; certificates prune {pruned} firing choice(s) before any run" if pruned else ""),
                          obs=cone.obs, cells=[c.id for c in cone.cells], rows=all_rows, fields=cone.fields,
                          components=cone.components, key=cone.key(m))
                self.ensure(cone, want)
                for cell in cone.cells:
                    res = self.decide(cone, cell, certs_on, wits_on, reg)
                    results.append(res)
                    self.emit("verdict", f"{cell.id}: {res['verdict']} {{{','.join(res['statuses'])}}}",
                              cell=cell.id, verdict=res["verdict"], statuses=res["statuses"])
            if not self.extra_susp - self.gsusp["suspended"]:
                break
            # a cell found a conflict the witness checks did not: suspend it everywhere and decide again
            self.gsusp["suspended"] |= self.extra_susp
        for c in reg["certificates"]:
            c["suspended"] = c["id"] in self.gsusp["suspended"]
        by_cell = {r["cell"]: r for r in results}
        report = {
            "model": m.summary(), "register": reg, "cells": results,
            "suspension": {"suspended": sorted(self.gsusp["suspended"]), "conflicts": self.gsusp["conflicts"],
                           "lacking": self.gsusp["lacking"]},
            "cones": [{"key": k.key(m), "obs": k.obs, "cells": [c.id for c in k.cells], "rows": k.rows,
                       "always": k.always, "fields": k.fields, "components": k.components,
                       "use_cases": k.use_cases} for k in cone_list],
            "tlc_calls": self.tlc_calls,
            "absorbed": wellformed.absorbed(m),
            "reverify": [{"certificate": c["id"], "changes": c["reverify"]} for c in reg["certificates"]
                         if c["reverify"] and c["state"] == "in force"],
            "claims": judge_claims(m.claims, by_cell),
            "engine": {"clingo": clingo.__version__, "tlc": next((c.get("tlc_version") for c in self.tlc_calls
                                                                  if c.get("tlc_version")), None),
                       "schedule": self.schedule},
        }
        if rank:
            report["ranking"] = self.rank(cone_list, reg, certs_on, wits_on, by_cell)
        report["log"] = self.events
        report["seconds"] = round(time.time() - self.t0, 2)
        self.emit("done", f"done in {report['seconds']} s: {len(self.tlc_calls)} TLC call(s)")
        return report

    # ------------------------------------------------------------------ ranking
    def rank(self, cone_list, reg, certs_on, wits_on, by_cell):
        """Certify-next: each guard (and each pair) as if certified; the key is the severity of the
        most severe failure it turns into a guarantee. Learned guards and undecidable targets score 0."""
        m = self.m
        guards = [g for g in m.components.values() if g.is_guard]
        actions = []
        certifiable = []
        pinned = set()
        for c in reg["certificates"]:
            if c["state"] == "in force" and c["id"] in certs_on and c["id"] not in self.gsusp["suspended"]:
                pinned |= {r for r, x in c["resolved"].items() if x == "N"}
        for g in guards:
            dec_rows = {t["row"] for t in g.targets if t["decidable"] and not g.learned}
            if dec_rows and dec_rows <= pinned:
                continue          # already certified
            dec = [t for t in g.targets if t["decidable"] and not g.learned]
            if g.learned:
                actions.append({"action": [g.id], "key": 0, "moved": [],
                                "note": "cannot be certified: learned guard, the LLM rule forbids never"})
            elif not dec:
                actions.append({"action": [g.id], "key": 0, "moved": [],
                                "note": "cannot be certified: no target is decidable from the edge"})
            else:
                certifiable.append(g)
        combos = [(g,) for g in certifiable] + list(itertools.combinations(certifiable, 2))
        self.emit("ranking", f"ranking {len(combos)} action(s) over {len(by_cell)} cells")
        wit = [w for w in reg["witnesses"] if w["state"] == "in force"]
        inf = [c for c in reg["certificates"] if c["state"] == "in force"]
        hyp_rows = {g.id: {t["row"]: "N" for t in g.targets if t["decidable"]} for g in certifiable}
        # one grounded problem per cell, with every hypothetical certificate switched off until used
        problems = {}
        for cone in cone_list:
            for cell in cone.cells:
                cur = by_cell[cell.id]
                rows = set(cone.cell_rows[cell.id])
                if cur["verdict"] == "guarantee":
                    continue
                hyps = [(f"hyp:{gid}", {r: x for r, x in hr.items() if r in rows})
                        for gid, hr in hyp_rows.items() if set(hr) & rows]
                if not hyps:
                    continue
                prob, _, _ = self.problem(cone, cell, inf, wit, extra_certs=hyps)
                base = (set(certs_on) - self.gsusp["suspended"]) & set(prob.cert_ids)
                problems[cell.id] = (prob, base, set(cur["witnesses_used"]), cur)
        for combo in combos:
            moved = []
            for cid, (prob, base, won, cur) in problems.items():
                on = {f"hyp:{g.id}" for g in combo} & set(prob.cert_ids)
                if not on:
                    continue
                b = prob.brave(base | on, won)
                if b and V.verdict_of(b["seen"]) == "guarantee":
                    moved.append({"cell": cid, "severity": cur["severity"], "from": cur["verdict"]})
            key = max([x["severity"] for x in moved] or [0])
            actions.append({"action": [g.id for g in combo], "key": key, "moved": moved,
                            "note": "" if moved else "moves no cell to guarantee"})
        # a pair is shown only if it moves more than each of its guards alone
        single = {a["action"][0]: {x["cell"] for x in a["moved"]} for a in actions if len(a["action"]) == 1}
        actions = [a for a in actions if len(a["action"]) == 1 or
                   {x["cell"] for x in a["moved"]} - single.get(a["action"][0], set()) - single.get(a["action"][1], set())
                   or not any(single.get(g) for g in a["action"])]
        actions = [a for a in actions if len(a["action"]) == 1 or len({x["cell"] for x in a["moved"]}) >
                   max(len(single.get(g, ())) for g in a["action"])]
        actions.sort(key=lambda a: (-a["key"], -len(a["moved"]), len(a["action"]), a["action"]))
        return actions

    # ------------------------------------------------------------------ table of possibilities (display)
    def possibilities(self, cell_id, evidence, cap=729):
        """Every candidate of a cell's cone with its status and what excludes it (computed from the
        runs in Python; a cross-check of the ASP result)."""
        m = self.m
        reg = self.register(evidence or {})
        cell = C.Cell.parse(cell_id)
        cone = next(k for k in C.cones(m, C.cells(m)) if cell_id in k.cell_rows)
        self.ensure(cone, [{}])
        inf = [c for c in reg["certificates"] if c["state"] == "in force"]
        wit = [w for w in reg["witnesses"] if w["state"] == "in force"]
        prob, runs, proj = self.problem(cone, cell, inf, wit)
        rows = [r for r in cone.cell_rows[cell_id] if m.rows[r].open]
        space = candidate_space(m, rows)
        # certificates the evidence refutes are suspended, as in the verdict
        gs = self.suspension(reg)
        suspended = gs["suspended"] & set(prob.cert_ids)
        on = set(prob.cert_ids) - gs["suspended"]
        won = set(prob.wit_ids)
        if space > cap:
            # too many to enumerate in Python: list the remaining ones with clingo instead
            listed = prob.listing(on, won, cap=240)
            return {"cell": cell_id, "rows": rows, "runs": len(runs), "space": space, "remaining_only": True,
                    "suspended": sorted(suspended),
                    "candidates": [{**c, "act": {r: x for r, x in c["act"].items() if r in rows}, "struck_by": []}
                                   for c in listed]}
        choices = []
        for r in rows:
            row = m.rows[r]
            choices.append(("S", "A") if (row.llm or (row.kind == "leak" and not row.decidable)) else ("N", "S", "A"))
        # a linked witness strikes a candidate if no run of the witness's own cone matches it and is
        # allowed by the candidate on this cell's rows and by the certificates in force on the others
        # (every other row may be sometimes, which allows any run)
        pinsx = {}
        for c in inf:
            if c["id"] in gs["suspended"] or not self.applies(c, cone):
                continue
            for q, x in c["resolved"].items():
                if q not in rows and x in ("N", "A"):
                    pinsx[q] = x
        wrs = {wid: self.witness_runs(next(w for w in wit if w["id"] == wid), self.wcone(next(w for w in wit if w["id"] == wid)))
               for wid in proj}

        def allows(act, fire):
            for q, x in list(act.items()) + list(pinsx.items()):
                if (x == "N" and q in fire) or (x == "A" and q not in fire):
                    return False
            return True
        out = []
        for combo in itertools.product(*choices):
            if len(out) >= cap:
                break
            act = dict(zip(rows, combo))
            adm = [r for r in runs if all((x != "N" or q not in r["fires"]) and (x != "A" or q in r["fires"])
                                          for q, x in act.items())]
            use = [r for r in adm if r["uses"]]
            reach = [r for r in adm if r["reaches"]]
            st = "x" if not use else ("N" if not reach else ("A" if all(r["reaches"] for r in use) else "S"))
            struck = []
            for c in inf:
                if c["id"] in suspended:
                    continue
                for q, x in c["resolved"].items():
                    if q in act and act[q] != x:
                        struck.append(c["id"])
                        break
            for wid, runs_w in wrs.items():
                if not any(ok and allows(act, fire) for _, fire, ok in runs_w):
                    struck.append(wid)
            out.append({"act": act, "status": st, "struck_by": struck})
        return {"cell": cell_id, "rows": rows, "candidates": out, "runs": len(runs), "space": space,
                "suspended": sorted(suspended)}

    def trace_of(self, cell_id, uc, fire):
        m = self.m
        cone = next(k for k in C.cones(m, C.cells(m)) if cell_id in k.cell_rows)
        key = cone.key(m)
        cov = self.cache.coverage(key)
        for _, info in cov:
            d = os.path.join(self.workroot, "tlc", info["hash"], "states.dump")
            if os.path.exists(d):
                steps = R.trace(d, uc, fire, cone.edges)
                if steps:
                    return {"cell": cell_id, "uc": uc, "fire": sorted(fire), "steps": steps}
        return None


def _minimal(sets):
    sets = sorted(set(sets), key=len)
    out = []
    for s in sets:
        if not any(t <= s for t in out):
            out.append(s)
    return out


def _count_vectors(rows, want, done):
    if len(rows) > 16:
        return -1
    n = 0
    for bits in itertools.product((0, 1), repeat=len(rows)):
        F = {r for r, b in zip(rows, bits) if b}

        def ok(p):
            return all((x == "A" and r in F) or (x == "N" and r not in F) for r, x in p.items() if r in rows)
        if any(ok(p) for p in want) and not any(ok(p) for p in done):
            n += 1
    return n


def judge_claims(claims, by_cell):
    """A claim states the verdict a team asserts for a cell: supported if the verdict matches,
    refuted if it contradicts, unsupported if the cell is unchecked, vacuous if it is not exercised."""
    out = []
    for cl in claims:
        cell = cl.get("cell")
        res = by_cell.get(cell)
        if res is None:
            out.append({**cl, "judgement": "unknown cell"})
            continue
        v, asserted = res["verdict"], cl.get("verdict", "guarantee")
        if v == "not exercised":
            j = "vacuous"
        elif v == asserted:
            j = "supported"
        elif v in ("unchecked", "conflict"):
            j = "unsupported"
        else:
            j = "refuted"
        out.append({**cl, "judgement": j, "verdict_now": v})
    return out
