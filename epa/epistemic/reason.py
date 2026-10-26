"""The Python side of the epistemic layer: build the facts for one cell, ground the program once,
and answer questions by switching evidence on and off.

* `brave(...)`  - the union of what the remaining candidates say (statuses, admitted runs), or None
                  when no candidate remains (a conflict);
* `count(...)`  - how many candidates remain;
* `listing(...)`- the remaining candidates themselves, for the table of possibilities;
* `minimal_conflicts(...)` - the subset-minimal sets of certificates that, with the witnesses,
                  leave no candidate (Reiter's conflict sets).
"""
from __future__ import annotations

import itertools
import os

import clingo

ASP = os.path.join(os.path.dirname(__file__), "asp", "epistemic.lp")
X = {"n": "N", "s": "S", "a": "A", "x": "x"}


def _q(s):
    return '"' + str(s).replace('"', "'") + '"'


class CellProblem:
    def __init__(self, m, cell_rows, runs, certs, witnesses, extra_rows=(), wruns=None):
        """cell_rows: the open rows of the cell's cone; runs: list of dicts with keys
        id, uc, fires (set of rows), uses, reaches, matches (set of witness ids);
        certs: list of (id, {row: 'N'|'S'|'A'}); witnesses: list of ids;
        extra_rows: rows only the cones of linked witnesses bring (candidates range over them too, and
        counts are projected onto the cell's rows); wruns: witness id -> (rows of its cone,
        [(use case, firing choice, matches)]) - the runs of each linked witness's own cone."""
        self.m = m
        self.rows = [r for r in cell_rows if m.rows[r].open]
        self.extra = [r for r in extra_rows if m.rows[r].open and r not in self.rows]
        self.free = [r for r in cell_rows if not m.rows[r].open]
        self.cert_ids = [k for k, _ in certs]
        self.wit_ids = list(witnesses)
        every = set(self.rows) | set(self.extra)
        facts = ["val(n). val(s). val(a)."]
        for r in self.rows + self.extra:
            row = m.rows[r]
            facts.append(f"row({_q(r)}).")
            if r in self.rows:
                facts.append(f"crow({_q(r)}).")
            if row.llm:
                facts.append(f"llm({_q(r)}).")
            if row.kind == "leak":
                facts.append(f"leak({_q(r)}).")
                if row.decidable:
                    facts.append(f"decidable({_q(r)}).")
        for run in runs:
            F = run["id"]
            facts.append(f"run({F}). uc({F},{_q(run['uc'])}).")
            for r in run["fires"]:
                if r in self.rows:
                    facts.append(f"fires({F},{_q(r)}).")
            if run["uses"]:
                facts.append(f"uses({F}).")
            if run["reaches"]:
                facts.append(f"reaches({F}).")
            for w in run["matches"]:
                facts.append(f"match({F},{_q(w)}).")
        for w, (wrows, wrs) in (wruns or {}).items():
            W = _q(w)
            for r in sorted(set(wrows) & every):
                facts.append(f"wrow({W},{_q(r)}).")
            for i, (_, fire, ok) in enumerate(wrs, start=1):
                facts.append(f"wrun({W},{i}).")
                for r in fire:
                    if r in every:
                        facts.append(f"wfires({W},{i},{_q(r)}).")
                if ok:
                    facts.append(f"wmatch({W},{i}).")
        for k, rows in certs:
            for r, x in rows.items():
                if r in every:
                    facts.append(f"cert({_q(k)},{_q(r)},{x.lower()}).")
            facts.append(f"cert_meta({_q(k)}).")
        for w in self.wit_ids:
            facts.append(f"wit({_q(w)}).")
        self.facts = "\n".join(facts)
        self.ctl = clingo.Control(["--warn=none"])
        self.ctl.load(ASP)
        self.ctl.add("base", [], self.facts)
        self.ctl.ground([("base", [])])
        self.ground_atoms = sum(1 for _ in self.ctl.symbolic_atoms)

    def program_text(self):
        return open(ASP).read() + "\n% ---- facts for this cell ----\n" + self.facts

    def _set(self, certs_on, wits_on):
        for k in self.cert_ids:
            self.ctl.assign_external(clingo.Function("cert_on", [clingo.String(k)]), k in certs_on)
        for w in self.wit_ids:
            self.ctl.assign_external(clingo.Function("wit_on", [clingo.String(w)]), w in wits_on)

    def brave(self, certs_on=(), wits_on=()):
        self._set(certs_on, wits_on)
        self.ctl.configuration.solve.enum_mode = "brave"
        self.ctl.configuration.solve.models = 0
        last = None
        with self.ctl.solve(yield_=True) as h:
            for model in h:
                last = model.symbols(shown=True)
        self.ctl.configuration.solve.enum_mode = "auto"
        if last is None:
            return None
        seen = sorted({X[str(s.arguments[0])] for s in last if s.name == "status" and len(s.arguments) == 1})
        per_uc = {}
        for s in last:
            if s.name == "status" and len(s.arguments) == 2:
                per_uc.setdefault(s.arguments[0].string, set()).add(X[str(s.arguments[1])])
        admits = {s.arguments[0].number for s in last if s.name == "admits"}
        return {"seen": seen, "per_uc": {u: sorted(v) for u, v in per_uc.items()}, "admits": admits}

    def satisfiable(self, certs_on=(), wits_on=()):
        self._set(certs_on, wits_on)
        self.ctl.configuration.solve.models = 1
        return self.ctl.solve().satisfiable

    def count(self, certs_on=(), wits_on=(), cap=20000):
        """How many candidates remain, counted on the cell's own rows: answer sets that differ only in
        the rows a linked witness brings are one candidate of this cell."""
        self._set(certs_on, wits_on)
        if not self.extra:          # every answer set is one candidate of this cell: just count them
            self.ctl.configuration.solve.models = cap
            n = 0
            with self.ctl.solve(yield_=True) as h:
                for _ in h:
                    n += 1
            self.ctl.configuration.solve.models = 0
            return n
        self.ctl.configuration.solve.models = 0
        seen = set()
        with self.ctl.solve(yield_=True) as h:
            for model in h:
                seen.add(frozenset((s.arguments[0].string, str(s.arguments[1])) for s in model.symbols(shown=True)
                                   if s.name == "act" and s.arguments[0].string in self.rows))
                if len(seen) >= cap:
                    break
        self.ctl.configuration.solve.models = 0
        return len(seen)

    def listing(self, certs_on=(), wits_on=(), cap=400):
        self._set(certs_on, wits_on)
        self.ctl.configuration.solve.models = 0 if self.extra else cap
        out, seen = [], set()
        with self.ctl.solve(yield_=True) as h:
            for model in h:
                syms = model.symbols(shown=True)
                act = {s.arguments[0].string: X[str(s.arguments[1])] for s in syms
                       if s.name == "act" and s.arguments[0].string in self.rows}
                st = next(X[str(s.arguments[0])] for s in syms if s.name == "status" and len(s.arguments) == 1)
                key = tuple(sorted(act.items()))
                if key in seen:
                    continue
                seen.add(key)
                out.append({"act": act, "status": st})
                if len(out) >= cap:
                    break
        self.ctl.configuration.solve.models = 0
        out.sort(key=lambda c: tuple("NSA".index(c["act"][r]) for r in self.rows))
        return out

    def minimal_conflicts(self, certs_on, wits_on):
        on = sorted(certs_on)
        found = []
        for k in range(1, len(on) + 1):
            for S in itertools.combinations(on, k):
                if any(set(c) <= set(S) for c in found):
                    continue
                if not self.satisfiable(set(S), wits_on):
                    found.append(S)
        return [set(S) for S in found]


def candidate_space(m, rows):
    """How many candidates the rules allow before any evidence: 2 for an LLM row or an undecidable
    leak row, 3 otherwise."""
    n = 1
    for r in rows:
        row = m.rows[r]
        if not row.open:
            continue
        n *= 2 if (row.llm or (row.kind == "leak" and not row.decidable)) else 3
    return n
