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

    # ------------------------------------------------------------------ one cell
    def problem(self, cone, cell, certs, witnesses, extra_certs=()):
        m = self.m
        rows = cone.cell_rows[cell.id]
        key = cone.key(m)
        allruns = self.cache.runs(key)
        exact = set(C.exact_points(m, cone))
        proj = {}
        crel = cone.cell_rel.get(cell.id, cone.rel)
        for w in witnesses:
            p = R.witness_fields_for_cell(m, cone, cell, w, crel)
            p = {o: f for o, f in p.items() if o in exact}
            if p:
                proj[w["id"]] = (p, w.get("use_case"))
        grouped = {}
        for r in allruns.values():
            k = (r.uc, frozenset(r.fire & set(rows)))
            out = (R.used(m, cell, r), R.reaches(m, cell, r),
                   frozenset(wid for wid, (p, uc) in proj.items() if R.matches(m, p, r, uc)))
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
        cert_list = [(c["id"], c["resolved"]) for c in certs if set(c["resolved"]) & set(rows)]
        cert_list += list(extra_certs)
        prob = CellProblem(m, rows, runs, cert_list, list(proj))
        return prob, runs, proj

    def decide(self, cone, cell, certs_on, wits_on, register):
        m = self.m
        in_force = [c for c in register["certificates"] if c["state"] == "in force"]
        witnesses = [w for w in register["witnesses"] if w["state"] == "in force"]
        rows = cone.cell_rows[cell.id]
        prob, runs, proj = self.problem(cone, cell, in_force, witnesses)
        cert_ids = {k for k in prob.cert_ids}
        on = set(certs_on) & cert_ids
        won = {w for w in wits_on if w in prob.wit_ids}
        b = prob.brave(on, won)
        conflicts, suspended, lacks_path = [], set(), False
        if b is None:
            if not prob.satisfiable(set(), won):
                lacks_path = True
                self.emit("conflict", f"{cell.id}: the witnesses alone leave no candidate - the model lacks a path",
                          cell=cell.id)
            else:
                self.ensure(cone, [{}])
                prob, runs, proj = self.problem(cone, cell, in_force, witnesses)
                conflicts = prob.minimal_conflicts(on, won)
                suspended = set().union(*conflicts) if conflicts else set()
                self.emit("conflict", f"{cell.id}: evidence in conflict; minimal sets "
                                      f"{[sorted(c) for c in conflicts]}; suspending {sorted(suspended)}",
                          cell=cell.id, conflicts=[sorted(c) for c in conflicts])
                on = on - suspended
                b = prob.brave(on, won)
        verdict = "conflict" if lacks_path else V.verdict_of(b["seen"] if b else None)
        seen = b["seen"] if b else None
        res = {
            "cell": cell.id, "kind": cell.kind, "field": cell.field, "obs": cell.obs,
            "verdict": verdict, "statuses": V.statuses_for_display(seen), "raw": seen,
            "per_uc": b["per_uc"] if b else {}, "advice": V.advice(verdict, seen),
            "conflicts": [sorted(c) for c in conflicts], "suspended": sorted(suspended), "lacks_path": lacks_path,
            "rows": rows, "cone": cone.key(m), "fields": cone.fields,
            "witnesses_used": sorted(won), "certs_used": sorted(on),
            "witness_projection": {w: p for w, (p, _) in proj.items()},
        }
        space = candidate_space(m, rows)
        res["candidates"] = {"space": space,
                             "remaining": prob.count(on, won) if (b and space <= 20000) else (None if b else 0)}
        res["severity"] = max([r["sev"] for r in runs] or [0])
        # root causes: minimal sets of firing rows behind reaching runs some remaining candidate admits
        if b:
            reach_sets = [frozenset(r["fired"]) for r in runs if r["reaches"] and r["id"] in b["admits"]]
            res["root_causes"] = [sorted(s) for s in _minimal(reach_sets)]
            ex = next((r for r in runs if r["reaches"] and r["id"] in b["admits"]
                       and frozenset(r["fired"]) in set(_minimal(reach_sets))), None)
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
        self.emit("model", f"model {m.name}: {len(m.components)} components, {len(m.edges)} edges, "
                           f"{len(m.rows)} rows, {len(m.obs)} observation points, {len(m.use_cases)} use cases")
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
        results = []
        for cone in cone_list:
            all_rows = cone.rows
            pins = self.pins(reg, certs_on, all_rows)
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
        by_cell = {r["cell"]: r for r in results}
        report = {
            "model": m.summary(), "register": reg, "cells": results,
            "cones": [{"key": k.key(m), "obs": k.obs, "cells": [c.id for c in k.cells], "rows": k.rows,
                       "always": k.always, "fields": k.fields, "components": k.components,
                       "use_cases": k.use_cases} for k in cone_list],
            "tlc_calls": self.tlc_calls,
            "unmatched": wellformed.unmatched_failures(m),
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
            if c["state"] == "in force" and c["id"] in certs_on:
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
                base = (set(certs_on) - set(cur["suspended"])) & set(prob.cert_ids)
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
        choices = []
        for r in rows:
            row = m.rows[r]
            choices.append(("S", "A") if (row.llm or (row.kind == "leak" and not row.decidable)) else ("N", "S", "A"))
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
                for q, x in c["resolved"].items():
                    if q in act and act[q] != x:
                        struck.append(c["id"])
                        break
            for wid in proj:
                if not any(wid in r["matches"] for r in adm):
                    struck.append(wid)
            out.append({"act": act, "status": st, "struck_by": struck})
        return {"cell": cell_id, "rows": rows, "candidates": out, "runs": len(runs)}

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
