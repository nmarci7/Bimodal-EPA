"""The run cache: which switch vectors of a cone have been explored, and what each run produced.
A (use case, switch vector) can have several outcomes; each is one stored run with its own `variant`.

Runs are keyed by the cone's behaviour hash (rows, wiring, guard specs, use cases, tracked fields),
not by version strings, so a component version change that leaves its rows alone re-runs nothing.
A *pin set* {row: N|A} describes the switch vectors consistent with some certificates; coverage is the
list of pin sets already explored.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading

from ..alethic.runs import Run


def covers(cov, want):
    """Pin set `cov` covers `want` if every switch vector consistent with `want` is consistent with `cov`."""
    return all(want.get(r) == x for r, x in cov.items())


class RunCache:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS outcomes(cone TEXT, uc TEXT, fire TEXT, variant INTEGER, fired TEXT, labels TEXT,
                                              rounds INTEGER, variants INTEGER,
                                              PRIMARY KEY(cone, uc, fire, variant));
          CREATE TABLE IF NOT EXISTS coverage(cone TEXT, pins TEXT, tlc TEXT, PRIMARY KEY(cone, pins));
        """)
        self.mem = {}

    def coverage(self, cone_key):
        with self.lock:
            rows = self.db.execute("SELECT pins, tlc FROM coverage WHERE cone=?", (cone_key,)).fetchall()
        return [(json.loads(p), json.loads(t)) for p, t in rows]

    def covered(self, cone_key, want):
        return any(covers(c, want) for c, _ in self.coverage(cone_key))

    def add(self, cone_key, pin_sets, runs, tlc_info):
        with self.lock:
            for r in runs.values():
                self.db.execute("INSERT OR REPLACE INTO outcomes VALUES (?,?,?,?,?,?,?,?)",
                                (cone_key, r.uc, json.dumps(sorted(r.fire)), r.variant, json.dumps(sorted(r.fired)),
                                 json.dumps(r.labels), r.rounds, r.terminal_variants))
            for p in pin_sets:
                self.db.execute("INSERT OR REPLACE INTO coverage VALUES (?,?,?)",
                                (cone_key, json.dumps(p, sort_keys=True), json.dumps(tlc_info)))
            self.db.commit()
            self.mem.pop(cone_key, None)

    def runs(self, cone_key):
        if cone_key in self.mem:
            return self.mem[cone_key]
        with self.lock:
            rows = self.db.execute("SELECT uc, fire, variant, fired, labels, rounds, variants FROM outcomes "
                                   "WHERE cone=?", (cone_key,)).fetchall()
        out = {}
        for uc, fire, variant, fired, labels, rounds, variants in rows:
            r = Run(uc=uc, fire=frozenset(json.loads(fire)), fired=frozenset(json.loads(fired)),
                    labels=json.loads(labels), rounds=rounds, terminal_variants=variants, variant=variant)
            out[r.key()] = r
        self.mem[cone_key] = out
        return out
