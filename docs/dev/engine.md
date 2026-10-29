# The epistemic layer and the engine

Part of the [developer guide](../developer-guide.md). Files: `epa/epistemic/asp/epistemic.lp`,
`epa/epistemic/reason.py`, `epa/epistemic/verdicts.py`, `epa/engine/coordinator.py`,
`epa/engine/cache.py`, `epa/engine/scenario.py`. Line numbers are left out on purpose: they drift;
`python tools/inventory.py` prints the current ones.

---

## 1. Purpose

### epa/epistemic/asp/epistemic.lp
- It is the answer-set program for one cell: one candidate per assignment of an activation to each open row, the runs each candidate admits, the status of the failure in that candidate, and the evidence constraints.
- Python supplies the runs that TLC explored as facts: use case, firing choice, whether the point is used, whether the failure reaches it, and witness matches. Certificates and witnesses are also facts, each guarded by an external atom (`cert_on/1`, `wit_on/1`), so evidence can be switched on and off without grounding again.
- The main derived data are `act/2` (the candidate), `admits/1`, `status/1` (over all use cases) and `status/2` (per use case).
- Only `epistemic/reason.py` loads it, through the `ASP` constant used in `CellProblem.__init__`. Its text is also shown to the analyst by `CellProblem.program_text()` through `GET /api/analyses/{aid}/cells/{cell}/asp`.

### epa/epistemic/reason.py
- It is the Python side of the epistemic layer. `CellProblem` turns one cell's open rows, grouped runs, certificates and linked witnesses into facts, grounds `epistemic.lp` once, and answers queries by switching externals: `brave`, `satisfiable`, `count`, `listing`, `minimal_conflicts`.
- Its main data structures are the fact string `facts`, the `clingo.Control` `ctl`, and the lists `rows` / `extra` / `cert_ids` / `wit_ids`.
- `candidate_space` gives the size of the candidate space before any evidence.
- Callers:
  - `CellProblem`: `Engine.suspension`, `Engine.problem`, and through those `decide`, `reasons`, `rank` and `possibilities` (all in `epa/engine/coordinator.py`).
  - `candidate_space`: `Engine.decide`, `Engine.possibilities`, `POST /api/model/check` (`epa/api/app.py`) and `epa check` (`epa/cli.py`).

### epa/epistemic/verdicts.py
- It turns the brave statuses of the remaining candidates (`seen`: a list over `N`, `S`, `A`, `x`, or `None` when no candidate remains) into one of six verdict words, into the status list shown to the user, and into a one-line advice text.
- It has no state. The module constant `WORDS` lists the six verdicts.
- The coordinator uses it: `Engine.decide` (verdict, statuses, advice), `Engine.reasons` and `Engine.rank` (comparing verdicts).

### epa/engine/coordinator.py
- It is the coordinator ("Figure 2's loop"). `Engine` holds the model, the work directory, a `RunCache`, the schedule, an event callback, the event list and the list of TLC calls.
- `Engine.analyse` does the full analysis:
  1. classifies the evidence (the register);
  2. builds cells and cones;
  3. suspends refuted certificates for the whole model;
  4. for each cone, prunes firing choices with certificate pins and makes sure the needed runs exist (TLC);
  5. decides every cell with clingo;
  6. derives reasons, root causes, an example run, claims and the certify-next ranking.
- `possibilities` and `trace_of` serve display endpoints. `judge_claims`, `_minimal` and `_count_vectors` are module helpers.
- Callers:
  - `epa/api/app.py`: `start_analysis`, `evidence_register`, `possibilities`, `cell_trace`, `cell_asp`.
  - `epa/cli.py`: `run` and `case` subcommands.
  - `tests/test_engine.py`, `tests/test_cases.py`, `tests/test_draft4.py`, `tests/test_manual_evidence.py`, `tests/test_differential.py`.
  - `bench/bench.py`.

### epa/engine/cache.py
- It is the persistent run cache. A SQLite database holds every explored run of a cone (keyed by the cone's behaviour hash, use case and firing choice) and the pin sets already covered, with their TLC info. Runs read back are memoised in memory per cone.
- `covers` decides whether one pin set's firing choices include another's.
- `Engine` uses it (`ensure`, `suspension`, `witness_runs`, `problem`, `reasons`, `trace_of`). `epa/api/app.py` makes one shared `CACHE = RunCache(WORK/runs.sqlite)` for all engines. The CLI and tests let `Engine.__init__` create one in their work directory.

### epa/engine/scenario.py
- It reads a demo case folder (`cases/<case>/case.yaml`) and assembles, for one stage, the model document (with redeployed versions applied) and the evidence dict `{certificates, witnesses, decisions}` accumulated over the stages up to it.
- It loads recognisers and lookup files and turns log files into witnesses through `log_import.recognise_all`.
- Callers:
  - `stage_inputs`: `epa/cli.py` (`case`), `GET /api/cases/{case}/stages/{stage}`, `tests/test_cases.py`, `tests/test_manual_evidence.py`, `bench/bench.py`.
  - `load_case`: `epa/cli.py`, `GET /api/cases/{case}/bundle`, `bench/bench.py`.

---

## 2. Definitions

### epa/epistemic/reason.py

| Definition | What it does | Calls |
|---|---|---|
| `_q(s)` | Quotes a value as an ASP string term: `str(s)` in double quotes, with any inner `"` replaced by `'`. | — |
| `class CellProblem` | One grounded clingo program for one cell, or one witness cone in `Engine.suspension`. Attributes: `m`, `rows` (open cell rows), `extra` (open rows only linked witness cones bring), `free` (non-open cell rows), `cert_ids`, `wit_ids`, `facts`, `ctl`, `ground_atoms`. | — |
| `CellProblem.__init__(m, cell_rows, runs, certs, witnesses, extra_rows=(), wruns=None)` | Builds the facts and grounds once (`clingo.Control(["--warn=none"])`, load `epistemic.lp`, add facts, ground `base`), then stores the number of symbolic atoms in `ground_atoms`. Facts: `val/1`; for open rows `row/1`, `crow/1`, `llm/1`, `leak/1`, `decidable/1`; per run `run/1`, `uc/2`, `fires/2` (cell rows only), `uses/1`, `reaches/1`, `match/2`; per linked witness `wrow/2`, `wrun/2`, `wfires/3`, `wmatch/2` (restricted to open rows of `rows`+`extra`); `cert/3` for stated open rows plus `cert_meta/1`; `wit/1`. | reason._q |
| `CellProblem.program_text()` | Returns the text of `epistemic.lp`, a `% ---- facts for this cell ----` line and `self.facts`. | — |
| `CellProblem._set(certs_on, wits_on)` | Assigns each `cert_on(K)` external true iff K is in `certs_on`, and each `wit_on(W)` true iff W is in `wits_on`. Assigning an atom that was never grounded as external (a certificate with no `cert/3` fact) does nothing in clingo; I checked this with clingo 5.8.2. | — |
| `CellProblem.brave(certs_on=(), wits_on=())` | Switches the evidence, sets `enum_mode="brave"` and `models=0`, keeps the last model (the brave consequences) and resets `enum_mode` to `"auto"`. Returns `None` if there is no model. Otherwise returns `{"seen": sorted status letters of status/1, "per_uc": {uc: sorted letters of status/2}, "admits": set of admitted run ids}`. | CellProblem._set |
| `CellProblem.satisfiable(certs_on=(), wits_on=())` | Switches the evidence, sets `models=1` and returns `solve().satisfiable`. | CellProblem._set |
| `CellProblem.count(certs_on=(), wits_on=(), cap=20000)` | Number of remaining candidates. Without extra rows it counts answer sets up to `cap`. With extra rows it enumerates all answer sets and counts distinct `act/2` sets projected onto the cell's rows, stopping at `cap`. Resets `models=0` afterwards. | CellProblem._set |
| `CellProblem.listing(certs_on=(), wits_on=(), cap=400)` | Lists the remaining candidates as `{"act": {row: N/S/A} on cell rows, "status": N/S/A/x}`, deduplicated on the projected `act`, at most `cap`. The model limit is `cap` only when there are no extra rows. Sorted by the per-row index in "NSA". | CellProblem._set |
| `CellProblem.minimal_conflicts(certs_on, wits_on)` | For k = 1…n, tries every k-subset of the sorted `certs_on`, skipping supersets of sets already found, and records those that are unsatisfiable with `wits_on` on. Returns the subset-minimal conflict sets as a list of sets. | CellProblem.satisfiable |
| `candidate_space(m, rows)` | Product over the open rows of 2 (an LLM row, or a leak row whose target is not decidable) or 3. Non-open rows contribute 1. | — |

### epa/epistemic/verdicts.py

| Definition | What it does | Calls |
|---|---|---|
| `verdict_of(seen)` | `None` → "conflict". A subset of `{"x"}` → "not exercised". Otherwise maps `x` to `N`; then `{N}` → "guarantee", `{S}` → "hope", `{A}` → "exposed", anything else → "unchecked". | — |
| `statuses_for_display(seen)` | `None`, or only `x`, → `[]`. Otherwise maps `x` to `N` and returns the letters present, in N, S, A order. | — |
| `advice(verdict, seen)` | Returns a fixed sentence per verdict. For "unchecked" it depends on the display statuses: {N,S} → certify the guard; {S,A} → collect a clean run; otherwise both. "guarantee" gives `""`. | verdicts.statuses_for_display |

(`WORDS`, a module constant, lists the six verdict words.)

### epa/engine/coordinator.py

| Definition | What it does | Calls |
|---|---|---|
| `class Engine` | The coordinator. State: `m`, `workroot`, `cache`, `schedule`, `on_event`, `events`, `tlc_calls`, `t0`. Set lazily: `gsusp`, `extra_susp`, `_wcones`. | — |
| `Engine.__init__(model, workroot, schedule="rounds", on_event=None, cache=None)` | Creates `workroot`, uses the given cache or a new `RunCache(workroot/runs.sqlite)`, and initialises the event list, the TLC call list and the start time. | cache.RunCache |
| `Engine.emit(step, msg, **data)` | Builds `{"t": seconds since engine creation (3 decimals), "step", "msg", **data}`, appends it to `self.events` and passes it to `on_event`. | — |
| `Engine.register(evidence)` | Collects the withdrawn certificates (`withdraw-cert` decisions) and the rejected witnesses (`reject-witness` decisions with a `second_reviewer`). Each certificate gets `state`, `reason`, `resolved` (row → N/S/A) and `reverify`; each witness gets `state` and `reason`. Returns `{"certificates", "witnesses", "decisions"}`. Emits nothing. | cert_import.classify, cert_import.reverify, log_import.classify_witness |
| `Engine.ensure(cone, want)` | Finds the pin sets in `want` the cache does not cover; returns `None` if there are none. Otherwise it generates a TLA+ module whose firing choices fit some missing pin set and no covered one, emits "tlc", runs TLC, parses the runs, records the call in `tlc_calls`, stores runs and coverage in the cache, emits "tlc-done" (including the count of nonconfluent runs) and returns the module hash. | cone.Cone.key, cache.RunCache.covered, cache.RunCache.coverage, to_tla.module_for, coordinator._count_vectors, Engine.emit, tlc_runner.run, runs.runs_from_dump, cache.RunCache.add |
| `Engine.applies(cert, cone)` | The scope rule. With no `scope`, True. Otherwise True iff, for every use case in `cone.scope_ucs` (or `cone.use_cases` when that is `None`) outside the scope, every row the certificate states is `inert` there. | Engine.inert |
| `Engine.inert(rid, u)` | True if no run of use case u can make row `rid` fire; this is an over-approximation. It uses `C.possible` (cached on the model as `m._possible` / `m._normal_edges`). Unknown row → False. Leak or fp row: True if nothing can arrive on `in`; a leak with a mode target is also True if no field of that mode's family can be non-zero there. Other rows: `not _trigger_possible`. | cone.normal_edges, cone.possible, cone._trigger_possible, load.Model.edges_into, load.Model.family |
| `Engine.witness_cone(w)` | Builds one cone covering everything a witness logs. For each logged point it takes the cones of the logged mode fields and provenance kinds, or of `m.top_modes[0]` when only `used` is logged. It returns their union (components, edges, use cases, rows, always rows, rel, fields in model order) as a `Cone` with `obs` set to the first part's point. | cone.Cell, cone.cone_of_cell, cone.Cone |
| `Engine.suspension(reg)` | Model-wide refutation. Certificates in force that pin one row to different activations, or a non-open row to an activation other than its `fixed` one, are suspended. Then, per witness in force: build its cone, explore it fully, build a `CellProblem` over the cone's rows. If the witness alone is unsatisfiable, add it to `lacking` and emit "conflict". If it is unsatisfiable with all relevant certificates on, suspend every minimal conflict set and emit "conflict" per set. Returns `{"suspended", "conflicts", "lacking"}`. | Engine.witness_cone, Engine.ensure, cone.Cone.key, cache.RunCache.runs, runs.matches, reason.CellProblem, CellProblem.satisfiable, CellProblem.minimal_conflicts, Engine.emit |
| `Engine.wcone(w)` | Memoised `witness_cone` per witness id, kept in `self._wcones`. | Engine.witness_cone |
| `Engine.vacuous(w)` | True for a witness whose use case reaches none of the points it logs (it is not among the witness cone's use cases) and which logs them unused and clean (no `used: true`, no mode range above 0). Every run of that use case shows exactly that, so the witness constrains no candidate. Without this the witness cone has no run of its use case and the witness would wrongly make every cell a conflict ("the model lacks a path"); a witness of such a use case that logs a message or a failure there still lacks a path. Found by the differential test (seed 220 of 400). | Engine.wcone |
| `Engine.witnesses_on(reg)` | The witnesses in force that bear on the analysis: all but the `vacuous` ones. `suspension`, `decide`, `reasons`, `possibilities` and `rank` take their witnesses from it. | Engine.vacuous |
| `Engine.witness_runs(w, cone)` | Explores the witness cone fully, then returns the distinct triples `(uc, frozenset(fire), matches-everything-logged)` over its cached runs. | Engine.ensure, cone.Cone.key, cache.RunCache.runs, runs.matches |
| `Engine.problem(cone, cell, certs, witnesses, extra_certs=())` | Builds the `CellProblem` for one cell: (1) keeps the certificates that `applies`; (2) links witnesses by fixpoint (a witness whose cone shares rows with the reach joins it, and its cone rows grow the reach); (3) collects each linked witness's runs; (4) groups the cone's cached runs by `(uc, fire ∩ cell rows)`, recording used/reaches (from the first run), fired rows, maximal severity, an example run and whether the group agrees; (5) passes the certificates touching the reach plus `extra_certs`. Returns `(prob, runs, proj)`, where `proj` maps each witness id to `(w["at"], use_case)`. | Engine.applies, cone.Cone.key, cache.RunCache.runs, Engine.wcone, Engine.witness_runs, runs.used, runs.reaches, runs.severity, reason.CellProblem |
| `Engine.decide(cone, cell, certs_on, wits_on, register)` | Decides one cell. It builds the problem, intersects it with the global suspension, and runs brave reasoning unless some witness lacks a path. A safety net handles an unsatisfiable result (full exploration, then "lacks a path" or this cell's own minimal conflict sets, which go into `extra_susp`, with a "conflict" event). It then derives verdict, statuses, advice, candidate counts, severity, root causes, example run, reasons and the nonconfluent count. Returns the per-cell result dict (§4). | Engine.problem, CellProblem.brave, Engine.ensure, CellProblem.satisfiable, CellProblem.minimal_conflicts, Engine.emit, verdicts.verdict_of, verdicts.statuses_for_display, verdicts.advice, Engine.applies, Engine.inert, cone.Cone.key, reason.candidate_space, CellProblem.count, coordinator._minimal, Engine.reasons |
| `Engine.reasons(cone, cell, prob, runs, on, won, verdict, register)` | What a guarantee or an exposed verdict rests on; other verdicts return empty reasons. "structural": the cell has no open rows, or every grouped run agrees with the verdict and the cone is fully explored. "certificates": each certificate whose removal changes the verdict; this re-ensures the pins of the others (possible TLC call) and rebuilds the problem. "decisions": `drop-default` decisions on cone components whose (edge, mode) is in the cell's `cell_rel`. `structural` is cleared when either of the other two lists is non-empty. | cache.RunCache.covered, cone.Cone.key, Engine.pins, Engine.ensure, Engine.problem, CellProblem.brave, verdicts.verdict_of, load.Model.edges_from |
| `Engine.pins(register, cert_ids, rows)` | The pin set `{row: N or A}` that the named certificates impose on `rows`. S statements are ignored. Returns `None` if two certificates pin one row differently. | — |
| `Engine.analyse(evidence=None, only_cells=None, rank=True)` | The whole analysis (step by step in §4). Returns the report dict and emits model, evidence, cells, cone, verdict, ranking and done (plus tlc, tlc-done and conflict from the methods it calls). | Engine.emit, Engine.register, cone.cells, cone.cones, Engine.suspension, Engine.applies, Engine.pins, coordinator._count_vectors, cone.Cone.key, Engine.ensure, Engine.decide, load.Model.summary, wellformed.absorbed, coordinator.judge_claims, Engine.rank |
| `Engine.rank(cone_list, reg, certs_on, wits_on, by_cell)` | Certify-next. Each guard not already certified becomes a hypothetical certificate `hyp:<gid>` (N on its decidable targets); learned guards and guards with no decidable target get key 0 with a note. For every single guard and pair it counts the non-guarantee cells that turn into guarantee; the key is the highest severity among them. Pairs are dropped unless they move more cells than each guard alone. Sorted by (−key, −moved, size, ids). Emits "ranking". | Engine.emit, Engine.problem, CellProblem.brave, verdicts.verdict_of |
| `Engine.possibilities(cell_id, evidence, cap=729)` | Builds the display table of one cell's candidates (details in §6b). It registers the evidence, finds the merged cone among all cells' cones, explores it fully, builds the problem and recomputes the suspension. If the space exceeds `cap`, clingo lists up to 240 remaining candidates (`remaining_only: True`). Otherwise Python enumerates every candidate with its status and `struck_by` (certificates and linked witnesses). | Engine.register, cone.Cell.parse, cone.cones, cone.cells, Engine.ensure, Engine.problem, reason.candidate_space, Engine.suspension, CellProblem.listing, Engine.applies, Engine.witness_runs, Engine.wcone, allows |
| `allows(act, fire)` (nested in `possibilities`) | True iff firing choice `fire` respects every N/A in `act` and in the out-of-cell pins `pinsx`. | — |
| `Engine.trace_of(cell_id, uc, fire)` | Finds the cell's merged cone. For each coverage entry of its key, reads `workroot/tlc/<hash>/states.dump` if it exists. Returns the first non-empty `R.trace` as `{"cell", "uc", "fire", "steps"}`, else `None`. | cone.cones, cone.cells, cone.Cone.key, cache.RunCache.coverage, runs.trace |
| `_minimal(sets)` | The subset-minimal sets among `sets` (deduplicated, sorted by size, each kept if no kept set is its subset). | — |
| `_count_vectors(rows, want, done)` | Number of firing choices over `rows` that fit some pin set in `want` and none in `done`, by brute force over 2^n. Returns −1 when there are more than 16 rows. | ok |
| `ok(p)` (nested in `_count_vectors`) | True iff the current firing choice F has every A-row of p in F and no N-row of p in F (only rows in `rows` count). | — |
| `judge_claims(claims, by_cell)` | Per claim: "unknown cell"; "vacuous" if not exercised; "supported" if the verdict equals the asserted one (default "guarantee"); "unsupported" if unchecked or conflict; else "refuted". Adds `judgement` and `verdict_now`. | — |

### epa/engine/cache.py

| Definition | What it does | Calls |
|---|---|---|
| `covers(cov, want)` | True iff every pin in `cov` appears with the same value in `want`, so the firing choices of `want` are a subset of those of `cov`. `{}` covers everything. | — |
| `class RunCache` | SQLite run cache with a `threading.Lock`, a `check_same_thread=False` connection and an in-memory `mem` dict (cone key → runs). | — |
| `RunCache.__init__(path)` | Creates the directory, opens the database and creates the `runs` and `coverage` tables if missing (§5). | — |
| `RunCache.coverage(cone_key)` | Under the lock, returns `[(pins dict, tlc info dict)]` for the cone. | — |
| `RunCache.covered(cone_key, want)` | True iff some single stored pin set `covers` `want`. | cache.covers, RunCache.coverage |
| `RunCache.add(cone_key, pin_sets, runs, tlc_info)` | Under the lock, does `INSERT OR REPLACE` for every run and for every pin set (with `tlc_info`), commits, and drops the cone from `mem`. | — |
| `RunCache.runs(cone_key)` | Returns `{(uc, fire): Run}` for the cone, memoised in `mem` until the next `add` for that cone. | runs.Run, runs.Run.key |

### epa/engine/scenario.py

| Definition | What it does | Calls |
|---|---|---|
| `load_case(case_dir)` | `yaml.safe_load` of `case_dir/case.yaml`. | — |
| `recognisers(case_dir, meta)` | Loads every recogniser matching the `meta["recognisers"]` globs (default `recognisers/*.yaml`), in sorted order. | log_import.load_recogniser |
| `lookup_files(case_dir, meta)` | `{basename: text}` for every file matching the `meta["lookup_files"]` globs (default `data/*.csv`, `data/*.json`). | — |
| `apply_versions(doc, versions)` | Returns a shallow copy of the model document in which components and guards listed in `versions` get the new `version`; rows are unchanged. | — |
| `stage_inputs(case_dir, stage_id=None)` | Walks the stages in order, accumulating certificates, witnesses (recognised from the logs against that stage's model) and decisions; `carry: false` resets them. It follows `model` and `versions` changes and stops at `stage_id`. Returns `(model document with versions applied, {"certificates", "witnesses", "decisions"}, chosen stage meta)`. | scenario.load_case, log_import.load_deployments, scenario.recognisers, scenario.lookup_files, load.read_document, scenario.apply_versions, load.load_model, cert_import.load, log_import.recognise_all |

---

## 3. The ASP encoding

### Predicates in `epistemic.lp`

**Inputs (facts from `CellProblem.__init__`):**

| Predicate | Meaning |
|---|---|
| `row(R)` | An open row the candidates range over: an open row of the cell's own cone, or one that only a linked witness's cone brings (`extra`). |
| `crow(R)` | An open row of the cell's own cone. The "always" violation and the counts are projected onto these. |
| `llm(R)` | `Row.llm`: an LLM row, or a learned guard's leak/fp row. It can never be N. |
| `leak(R)`, `decidable(R)` | A guard's leak row; `decidable` when `Row.decidable` (decidable target and the guard is not learned). |
| `run(F)`, `uc(F,U)` | A grouped run of the cell (`Engine.problem` numbers the `(uc, fire ∩ cell rows)` groups 1..n) and its use case. |
| `fires(F,R)` | Row R is in the run's firing choice. Only cell rows are emitted. |
| `uses(F)` | The run sends a message over the observation point (`runs.used`). |
| `reaches(F)` | The failure reaches the point in that run (`runs.reaches`: magnitude ≥ tolerate, taint, conf above clearance, auth below requires). |
| `match(F,W)` | The run matches witness W. Only non-empty in the problems built by `Engine.suspension`, where the witness cone's own runs are the runs. `Engine.problem` always passes an empty `matches`. |
| `wrun(W,I)`, `wrow(W,R)`, `wfires(W,I,R)`, `wmatch(W,I)` | Witness W's cone run I; the open rows of W's cone; R fires in run I; run I matches everything W logged. |
| `cert(K,R,X)` | Certificate K states activation X (`n`, `s` or `a`) for open row R. |
| `wit(W)` | A linked witness. |
| `val/1`, `cert_meta/1` | Emitted, but the program never uses them. |

**Externals:**
- `#external cert_on(K) : cert(K,_,_).`
- `#external wit_on(W) : wit(W).`

Both default to false. `_set` switches them per query.

**Choice and constraints:**
- `1 { act(R,n); act(R,s); act(R,a) } 1 :- row(R).` gives one activation per open row: n = never fires, s = sometimes, a = always.
- `:- act(R,n), llm(R).` is the LLM rule.
- `:- act(R,n), leak(R), not decidable(R).` means a leak row may be never only on a decidable target.
- `:- cert_on(K), cert(K,R,X), row(R), not act(R,X).` means a certificate in force fixes the row.

**Admitted runs:**
- `violates(F)` holds if a row with `act(R,n)` fires in F, or a cell row (`crow`) with `act(R,a)` does not fire in F.
- `admits(F) :- run(F), not violates(F).`
- An `s` row admits both choices.

**Status over all use cases** (box/diamond over the admitted runs):
- `some_use`: some admitted run uses the point. `some_reach`: some admitted run reaches it. `use_clean`: some admitted run uses the point without reaching.
- `status(x)`: no admitted run uses the point.
- `status(n)`: used, never reaches.
- `status(a)`: reaches, and no clean use exists.
- `status(s)`: reaches, and a clean use exists.
- Exactly one holds per answer set (`runs.reaches` implies used).
- `usecase/1`, `some_use/1`, `some_reach/1`, `use_clean/1` and `status/2` repeat this per use case.

**Witnesses:**
- `matched(W)` holds if some admitted run matches W (`match/2`), or if some run of W's own cone matches (`wmatch`) and does not `wviolates` the candidate. `wviolates` is the same never/always test, over `wfires` and `wrow`, so the "always" check covers all rows of the witness cone.
- `:- wit_on(W), not matched(W).` makes every witness in force require a matching run the candidate allows.

### Shown and optimised
- `#show act/2. #show status/1. #show status/2. #show admits/1.`
- Nothing is optimised: there is no `#minimize`, `#maximize` or weak constraint.

### Brave reasoning
- `CellProblem.brave` sets `enum_mode="brave"` with `models=0`. The last model clingo reports is the set of brave consequences: every shown atom true in some remaining candidate. That gives:
  - `seen`: every status that some remaining candidate gives the failure;
  - `per_uc`: the same per use case;
  - `admits`: every run some remaining candidate admits.
- An unsatisfiable program gives `None`, meaning no candidate remains.
- Where it is used:
  - `Engine.decide`: the verdict;
  - `Engine.reasons`: the verdict with one certificate removed;
  - `Engine.rank`: the verdict with hypothetical certificates on.
- `count` and `listing` enumerate full answer sets and project `act/2` onto the cell's rows whenever `extra` rows exist, so answer sets that differ only in witness-linked rows count once.

### Minimal conflict sets (`reason.py`)
- `minimal_conflicts(certs_on, wits_on)` enumerates subsets of the certificates in force by increasing size. It skips any superset of an already found set and calls `satisfiable(S, wits_on)` (`models=1`).
- Every unsatisfiable S found this way is subset-minimal, so the result is Reiter's conflict sets with respect to the witnesses.
- In the worst case it makes 2^n solver calls. The coordinator calls it only after checking that the witnesses alone are satisfiable and that all the certificates together are not (in `suspension`, and in the safety net of `decide`).

### From the answer to a verdict
1. `Engine.decide` sets `lacks_path = bool(self.gsusp["lacking"])`. If any witness in force matches no run of the model, every cell gets verdict "conflict" and brave reasoning is skipped.
2. Otherwise, `b = prob.brave(on, won)`:
   - `on` = certificates in force that apply to the cone and touch the reach, minus the global suspension;
   - `won` = the linked witnesses in force.
3. If `b` is `None` (safety net): the cone is explored fully and the problem rebuilt. If `satisfiable(∅, won)` fails, `lacks_path = True`. Otherwise the cell's own `minimal_conflicts` are suspended (and added to `self.extra_susp`) and brave is run again.
4. `verdict = "conflict"` if `lacks_path`, else `verdicts.verdict_of(b["seen"])`:
   - `None` → conflict;
   - only `x` → not exercised;
   - with `x` read as N: {N} → guarantee, {S} → hope, {A} → exposed;
   - anything mixed → unchecked.
5. `statuses` = `statuses_for_display(seen)`; `raw` = `seen`; `advice` = `verdicts.advice(verdict, seen)`; `per_uc` comes from `b`.
6. Certificates refuted by a witness do not make a cell "conflict". They are suspended model-wide, so the cell gets an ordinary verdict and lists them in `conflicts` / `suspended`. For example, `tests/test_cases.py` expects wallet S2 `oom@o_statement` to be "hope" with `conflicts == [["c_gm"]]`.

---

## 4. Engine.analyse, step by step

### Events emitted through `emit()`
Every event is `{t, step, msg, ...}`. The UI groups them in `web/analysis.js`: Input = model, evidence; Relevance = cells, cone; Alethic = tlc, tlc-done; Epistemic = verdict, conflict; Output = ranking, done.

| step | emitted by | extra data |
|---|---|---|
| `model` | analyse | — (message: component, guard, edge, row, point and use case counts) |
| `evidence` | analyse | `certificates` {id: state}, `witnesses` {id: state} |
| `cells` | analyse | `cells` [ids] |
| `tlc` | ensure | `cone` (key), `obs`, `vectors`, `rows` |
| `tlc-done` | ensure | `cone`, `module` (hash), `generated`, `distinct`, `depth`, `seconds`, `cached`, `tlc_version`, `runs`, `vectors`, `nonconfluent` |
| `conflict` | suspension | `witness`; plus `certificates` for a conflict set (none for "model lacks a path") |
| `conflict` | decide (safety net) | `cell`; plus `conflicts` for conflict sets |
| `cone` | analyse | `obs`, `cells`, `rows`, `fields`, `components`, `key` |
| `verdict` | analyse | `cell`, `verdict`, `statuses` |
| `ranking` | rank | — |
| `done` | analyse | — |
| `error` | `app.start_analysis` on an exception (not by the engine; no `t`) | — |

### The flow

**1. Model event.** Counts guards and emits `model`.

**2. Register (classification of evidence).** `register(evidence)` reads `evidence["decisions"]`:
- `withdraw-cert` decisions give the withdrawn certificate ids;
- `reject-witness` decisions with `second_reviewer` give the rejected witness ids.

Certificates go through `cert_import.classify(c, m, withdrawn)`:
- `withdrawn` if listed;
- `rejected` for an unknown component, a certificate that states no row, an unknown row, a row of another component, an unknown activation, never on an LLM row or learned guard (the LLM rule), or never on an undecidable target;
- `stale` if the certificate's version is not the component's;
- otherwise `in force`.

Each certificate also gets `resolved` (row id → N/S/A; guard targets become `leak.<comp>.<key>`) and `reverify` (context components whose version changed).

Witnesses go through `log_import.classify_witness(w, m, rejected)`:
- `rejected` if listed, or if they name an unknown point or use case;
- `stale` if a component upstream of a logged point has a version different from the one the witness recorded;
- otherwise `in force`.

`certs_on` / `wits_on` = the ids in force; emits `evidence`. Only "in force" evidence is used from here on.

**3. Cells and cones.**
- `C.cells(m, only_cells)` makes one cell per tolerated mode field at each point, plus taint (if `taint: reject`), conf (if `clearance`) and auth (if `requires`), optionally filtered to `only_cells`.
- `C.cones(m, cell_list)` makes one cone per cell, then merges the cones of one observation point while the union stays at 10 rows or fewer, or when one cone's rows are a subset of the other's.
- Each merged cone keeps `cell_rows`, `cell_fields`, `cell_rel` per cell, and `scope_ucs` (the use cases in which the point's edge can carry a message).
- Emits `cells`.

**4. Conflict detection across the whole model (witness cones) → suspension.** `self.gsusp = self.suspension(reg)`; `self.extra_susp = set()`.
- **Certificate against certificate:** if two in-force certificates pin one row to different activations, all of them are suspended (`{"certificates", "witness": None, "row"}`). If a row is not open, certificates stating an activation other than its `fixed` one are suspended.
- **Per in-force witness:**
  1. `witness_cone(w)` builds the union of the cones of every field it logs at every point.
  2. `ensure(cone, [{}])` explores every firing choice (TLC if not cached).
  3. Each cached run becomes a run fact with `match` set iff `runs.matches(m, w["at"], run, w.use_case)`.
  4. The certificates considered are those with no scope, a witness with no use case, or the witness's use case in the scope, and only if their rows meet the cone's rows. They go into a `CellProblem` over `cone.rows`.
  5. If the witness alone is unsatisfiable, the witness goes into `lacking` and a `conflict` event "the model lacks a path" is emitted.
  6. If it is unsatisfiable with all those certificates on, each set from `minimal_conflicts` is suspended, recorded as `{"certificates", "witness"}`, and a `conflict` event is emitted.
- Result: `{"suspended", "conflicts", "lacking"}`. Every cell then sees the same suspension.

**5. Per-cone loop.** This runs at most twice (`for _ in range(2)`). For each cone:
- **Which evidence applies to the cone (scope rule):** `usable` = in-force certificates with `applies(c, cone)`, minus `gsusp["suspended"]`.
  - `applies`: no `scope` → applies. Otherwise every use case of `cone.scope_ucs` outside the scope must be one in which every stated row is `inert`.
  - `inert(r, u)` over-approximates whether row r can fire in use case u, using `cone.possible(m)[u]` (which edges can carry a message and which mode fields can be non-zero). A leak or fp row is inert if nothing can arrive at the guard; a leak row with a mode target is also inert if that mode's family cannot be non-zero at the input. Other rows are inert iff their trigger is impossible (`cone._trigger_possible`).
- **Pin set:** `pins = self.pins(reg, usable, cone.rows)` gives the N/A pins (S ignored). `want = [pins]`, or `[{}]` if the certificates contradict.
- `pruned` = 2^n − (firing choices that fit the pins); emits `cone` (with "certificates prune k firing choice(s) before any run" when k > 0).
- **`ensure(cone, want)` (TLC call):**
  1. Missing pin sets = those no cached pin set `covers`.
  2. `to_tla.module_for(m, cone, want=missing, done=<cached pin sets>, schedule)` generates a module whose `Vectors == {F ∈ SUBSET VecRows : Want(F) ∧ ¬Done(F)}`.
  3. Emits `tlc`.
  4. `tlc_runner.run` runs it (cached on disk under `workroot/tlc/<module hash>`).
  5. `runs.runs_from_dump(dump, cone.edges)` gives one `Run` per (uc, fire), with `terminal_variants` > 1 if interleavings disagree.
  6. Appends to `tlc_calls`, writes runs and coverage to the cache, emits `tlc-done`.
- **For each cell of the cone, `decide(...)`:**
  - **Problem building (`problem`):**
    1. Certificates are filtered by `applies`.
    2. Linked witnesses are found by fixpoint: a witness whose cone's rows meet the reach (initially the cell's rows) joins, and its rows extend the reach.
    3. Each linked witness brings `witness_runs` (its cone explored fully; triples `(uc, fire, matches)`).
    4. The cone's cached runs are grouped by `(uc, fire ∩ cell rows)`. Each group records `uses`/`reaches` (from the first run), `fired` (cell rows that fired), `sev` (max severity), `example` (first run) and `agree` (all runs in the group give the same uses/reaches).
    5. Certificates whose resolved rows meet the reach go into `CellProblem(m, rows, runs, certs, linked ids, extra_rows=reach − rows, wruns)`.
  - **ASP solving:**
    - `suspended` = global suspension ∩ the problem's certificates;
    - `conflicts` = global conflict sets touching them;
    - `on` = (`certs_on` ∩ the problem's certificates) − global suspension;
    - `won` = the linked witnesses in force;
    - `b = prob.brave(on, won)`, unless `gsusp["lacking"]` is non-empty;
    - if `b` is `None`, the safety net from §3 runs (this cell's conflict sets, a `conflict` event, `extra_susp`).
  - **Verdict** as in §3. `scope_withheld` lists the in-force certificates touching the cell's rows that fail `applies`, with the uncovered use cases in which a stated row is not inert.
  - **Candidates:**
    - `space = candidate_space(m, rows)`;
    - `remaining = prob.count(on, won, cap=5001)`, reported as `remaining`, or as `remaining: None, at_least: 5000` above the cap (`COUNT_CAP`);
    - with no answer, `remaining = 0`.
  - **Severity:** the maximum `sev` over all grouped runs.
  - **Root causes and example run:** `root_causes` = the minimal `fired` sets among reaching runs that some remaining candidate admits (`b["admits"]`). `example_run` = the first such run whose fired set is minimal, reported as `{uc, fire: sorted(example.fire)}`; `fire` is the full firing choice of the raw run, over the merged cone's rows.
  - **Reasons (what a verdict rests on), for guarantee and exposed only:**
    - `structural`: the cell has no open rows, or every grouped run that uses the point reaches (exposed) / does not reach (guarantee) and `cache.covered(key, {})`.
    - `certificates`: each k in `on` such that, with `others = on − {k}`, `pins(others)` is consistent; then `ensure(cone, [pins])` (possibly a TLC call), the problem is rebuilt, and `brave(others, won)` gives a different verdict.
    - `decisions`: model decisions of kind `drop-default` (from `drop_defaults`) on a cone component where some edge from that port, paired with the dropped mode, is in the cell's `cell_rel`.
    - `structural` becomes False if either list is non-empty.
  - `nonconfluent` = the number of grouped runs with `agree == False`.
  - Emits `verdict`.
- After the pass: if `extra_susp` contains certificates not yet in `gsusp["suspended"]`, they are added and the loop runs a second time; otherwise it stops.

**6. Report assembly.**
- Each register certificate gets `suspended: bool`; `by_cell` = cell id → result.
- `claims` = `judge_claims(m.claims, by_cell)`.

**7. Ranking (certify-next)** if `rank`: `rank(cone_list, reg, certs_on, wits_on, by_cell)`.
1. Rows pinned N by non-suspended in-force certificates count as certified. Guards whose decidable targets are all pinned are skipped.
2. Learned guards and guards with no decidable target get `key 0` with a "cannot be certified" note. The remaining guards are certifiable.
3. For every non-guarantee cell whose rows meet some certifiable guard's decidable leak rows, one problem is built with hypothetical certificates `hyp:<gid>` (N on those rows, restricted to the cell's rows) passed as `extra_certs`. The base is (`certs_on` − suspended) ∩ the problem's certificates; the witnesses are the cell's `witnesses_used`.
4. For each single guard and each pair, brave is run with base plus the hypotheses. Cells now at "guarantee" are recorded in `moved` as `{cell, severity, from}`; `key` = max severity moved.
5. Pairs survive only if they move more cells than each of their guards alone. Sorting is by (−key, −len(moved), len(action), action).
6. Emits `ranking`. TLC events can also appear here, because `problem` → `witness_runs` → `ensure`.

**8. Finish.** `report["log"] = self.events`, `report["seconds"]`; emits `done` (it is appended to the same list, so it appears in `log`).

### Shape of the returned report

Top level (the API adds `id` and `label`):

| key | content |
|---|---|
| `model` | `m.summary()`: name, description, fields, parent, levels, components, edges, rows, obs, use_cases, warnings |
| `register` | `{certificates: [cert + state, reason, resolved, reverify, suspended], witnesses: [w + state, reason], decisions}` |
| `cells` | list of per-cell results (below) |
| `suspension` | `{suspended: sorted ids, conflicts: [{certificates, witness, row?}], lacking: [witness ids]}` |
| `cones` | `[{key, obs, cells, rows, always, fields, components, use_cases}]` |
| `tlc_calls` | `[{cone, obs, hash, generated, distinct, depth, seconds, cached, tlc_version, runs, vectors}]` |
| `absorbed` | `wellformed.absorbed(m)`: declared absorptions and sink rows |
| `reverify` | `[{certificate, changes}]` for in-force certificates with upstream version changes |
| `claims` | claims plus `judgement`, `verdict_now` |
| `engine` | `{clingo, tlc, schedule}` |
| `ranking` | (if `rank`) `[{action: [guard ids], key, moved: [{cell, severity, from}], note}]` |
| `log` | all events |
| `seconds` | elapsed seconds since the Engine was created |

Per cell (`decide`):

| key | content |
|---|---|
| `cell`, `kind`, `field`, `obs` | the cell |
| `verdict`, `statuses`, `raw`, `per_uc`, `advice` | the verdict, display statuses, brave `seen`, per-use-case statuses, advice text |
| `conflicts`, `suspended`, `lacks_path` | the conflict sets touching the cell's certificates, suspended ids, whether the model lacks a path |
| `rows`, `cone`, `fields` | the cell's rows, the merged cone's key, the merged cone's fields |
| `witnesses_used`, `certs_used` | `won`, `on` |
| `scope_withheld` | `[{certificate, scope, uncovered}]` |
| `witness_projection` | `{witness id: w["at"]}` |
| `candidates` | `{space, remaining, at_least}` |
| `severity` | maximum severity over the runs |
| `root_causes` | list of minimal fired row sets |
| `example_run` | `{uc, fire}` or `None` |
| `reasons` | `{structural, certificates, decisions}` |
| `nonconfluent` | number of grouped runs that disagree |

---

## 5. RunCache and Scenario

### RunCache (`epa/engine/cache.py`)

```sql
CREATE TABLE IF NOT EXISTS runs(cone TEXT, uc TEXT, fire TEXT, fired TEXT, labels TEXT,
                                rounds INTEGER, variants INTEGER, PRIMARY KEY(cone, uc, fire));
CREATE TABLE IF NOT EXISTS coverage(cone TEXT, pins TEXT, tlc TEXT, PRIMARY KEY(cone, pins));
```

- **Columns:**
  - `cone` is `Cone.key(m)`: a 16-hex SHA-256 over the semantics version, rows (`to_json` of rows and always rows), component signatures, edge endpoints, use-case entries and tracked fields. Version strings are not part of it.
  - `fire` and `fired` are JSON sorted lists.
  - `labels` is JSON edge → `{u, n, k}`.
  - `variants` is `Run.terminal_variants`.
  - `pins` is JSON (`sort_keys=True`) of a pin set.
  - `tlc` is the JSON TLC info (hash, generated, distinct, depth, seconds, cached, tlc_version, runs, vectors).
- **`coverage(key)`** returns `[(pins, info)]` for the cone.
- **`covered(key, want)`** asks whether any one stored pin set `covers` `want` (every pin it has, `want` has with the same value). Full exploration is stored as `{}`, which covers everything.
- **`add(key, pin_sets, runs, info)`** upserts every run and every pin set of the call (all with the same info), commits, and invalidates `mem[key]`.
  - Runs accumulate across calls, because each TLC call explores only Want ∧ ¬Done.
  - `trace_of` therefore looks through every coverage entry's dump.
- **`runs(key)`** rebuilds `Run` objects keyed `(uc, fire)` and memoises them.
- The API shares one `RunCache` across threads and engines, guarded by its lock (and by `RUN_LOCK` in `app.py`).

### Scenario (`epa/engine/scenario.py`)

- `case.yaml` gives `model`, `deployments`, `recognisers`, `lookup_files` and `stages` (`id`, `label`, optional `model`, `versions`, `certificates`, `logs`, `decisions`, `carry`).
- **`stage_inputs(case_dir, stage_id)`:**
  1. Loads `meta`, the deployments manifest (if any), the recognisers (`recognisers/*.yaml` by default) and the lookup files (`data/*.csv`, `data/*.json` by default).
  2. For each stage in order:
     - `carry: false` empties certificates, witnesses and decisions; versions and the model path are kept;
     - a stage `model` replaces the model path;
     - `versions` are merged into the running versions map;
     - the stage model is loaded (`load_model(apply_versions(read_document(path), versions))`);
     - every certificate file is appended (`cert_import.load`);
     - every log file is read and passed to `log_import.recognise_all(text, path, recs, m, deps, case_dir, files)`, and its witnesses are appended;
     - the stage's `decisions` are appended;
     - if the stage is the requested one, it is remembered and the loop stops; with `stage_id=None` all stages run and the last one is remembered.
  3. Returns `apply_versions(read_document(model_path), versions)`, the evidence dict and the stage meta.
- No classification happens here. `Engine.register` classifies against the final model later, which is how earlier witnesses become stale after a redeployment.
- **`apply_versions`** changes only the `version` of the listed components and guards.
- **`recognisers` / `lookup_files`** glob relative to the case directory. `lookup_files` keys by basename.

---

## 6. Workflow notes

### (a) `POST /api/analyses` → `Engine.analyse` → report
1. Browser (`web/analysis.js` `run()`) → `POST /api/analyses` with `{doc, evidence: {certificates, witnesses, decisions}, label}` (optional `cells`, `rank`).
2. `app.start_analysis` → `_model(doc)` → `load.load_model` (HTTP 422 on `ModelError`).
3. `start_analysis` creates `aid` and the record `ANALYSES[aid] = {status: "running", events: [], ...}`, starts a daemon thread `work()`, and returns `{id}`.
4. Browser → `GET /api/analyses/{aid}/events` (an EventSource). `analysis_events.gen()` polls `st["events"]` every 0.1 s and sends each as `data: {...}`.
5. `work()` takes `RUN_LOCK`, then `Engine(m, WORK, on_event, cache=CACHE)` → `eng.analyse(evidence, only_cells=cells, rank=rank)`.
6. `analyse` → `emit("model")` → `register` (`cert_import.classify`, `cert_import.reverify`, `log_import.classify_witness`) → `emit("evidence")` → `cone.cells`, `cone.cones` → `emit("cells")`.
7. `analyse` → `suspension`:
   - per witness: `witness_cone` → `ensure` (`RunCache.covered` → `to_tla.module_for` → `emit("tlc")` → `tlc_runner.run` → `runs.runs_from_dump` → `RunCache.add` → `emit("tlc-done")`);
   - then `RunCache.runs` → `runs.matches` → `CellProblem` → `satisfiable` / `minimal_conflicts` → `emit("conflict")`.
8. For each cone: `applies` / `inert` → `pins` → `_count_vectors` → `emit("cone")` → `ensure(cone, want)` (TLC as in step 7).
9. For each cell: `decide`:
   - `problem` → `wcone` / `witness_runs` / `ensure` → `runs.used`, `runs.reaches`, `runs.severity` → `CellProblem` (ground);
   - `CellProblem.brave` (safety net: `ensure` → `satisfiable` → `minimal_conflicts` → `emit("conflict")`);
   - `verdicts.verdict_of`, `statuses_for_display`, `advice` → `CellProblem.count` → `_minimal`;
   - `reasons` → `pins` → `ensure` → `problem` → `brave`;
   - then `emit("verdict")`.
10. Second pass of steps 8–9 only if `extra_susp` grew.
11. `m.summary()`, `wellformed.absorbed`, `judge_claims` → `rank` (`emit("ranking")`, `problem` with hypotheses, `brave`) → `emit("done")` → return the report.
12. Each `emit` → `on_event` → `st["events"].append` → streamed by step 4.
13. `work()` sets `rep["id"]`, `rep["label"]`, `st["report"]` and `status = "done"`. On an exception it sets `status = "error"` and the error text, and appends `{"step": "error"}`.
14. The SSE generator sees status ≠ running and sends `event: end` with `{status, error}`.
15. Browser → `GET /api/analyses/{aid}` → `{id, status, error, report, events}`.

### (b) Per-cell endpoints (all use `_engine(aid)`)
- `_engine(aid)` returns 404 unless the analysis status is "done".
- It returns `(st, Engine(st["model"], WORK, cache=CACHE))`: a fresh engine with no event callback, sharing the run cache.

**`GET /api/analyses/{aid}/cells/{cell}/possibilities`**
1. Browser (`web/verdicts.js` `rooms()`) → endpoint → `_engine` → `RUN_LOCK`.
2. `Engine.possibilities(cell, st["evidence"])` → `register` → `Cell.parse` → `cone.cones(m, cone.cells(m))` → pick the cone whose `cell_rows` holds the cell.
3. `ensure(cone, [{}])` (full exploration, TLC if not cached) → `problem` (in-force certificates and witnesses) → `candidate_space(m, open cell rows)`.
4. `suspension(reg)` is recomputed (witness cones, possible TLC, `satisfiable`, `minimal_conflicts`). `on` = the problem's certificates − suspended; `won` = all linked witnesses.
5. If `space > 729`: `CellProblem.listing(on, won, cap=240)` → `{cell, rows, runs, space, remaining_only: True, suspended, candidates: [{act, status, struck_by: []}]}`.
6. Otherwise Python enumerates the product of activations (S/A for LLM or undecidable-leak rows, N/S/A for others), at most 729:
   - admitted runs → status (x / N / A if every using run reaches / S);
   - `struck_by` = certificates (in-force, not suspended) stating another activation for a row in `act`, plus linked witnesses with no matching witness-cone run that `allows(act, fire)`, where `pinsx` holds the out-of-cell N/A pins of applicable non-suspended certificates;
   - returns `{cell, rows, candidates, runs, space, suspended}`.

**`GET /api/analyses/{aid}/cells/{cell}/trace`**
1. Browser (`trace()`) → endpoint → `_engine`.
2. The cell's `example_run` is looked up in `st["report"]["cells"]`. If there is none, the response is `{cell, story: [], note}`.
3. `RUN_LOCK` → `Engine.trace_of(cell, uc, frozenset(fire))` → merged cone of all cells → `RunCache.coverage(key)` → for each `info["hash"]`, `workroot/tlc/<hash>/states.dump` → `runs.trace(dump, uc, fire, cone.edges)`. This returns the per-round `{round, fired, labels}`, deduplicated where labels did not change.
4. `explain.trace_story(model, trace, res["fields"])` → `{cell, run, story}`.

**`GET /api/analyses/{aid}/cells/{cell}/asp`**
1. Browser (`asp()`) → endpoint → `_engine`.
2. `cone.cones(m, cone.cells(m))` → the cell's cone → `eng.register(st["evidence"])` (outside the lock).
3. `RUN_LOCK` → `eng.ensure(cone, [{}])` → `eng.problem(cone, Cell.parse(cell), in-force certificates, in-force witnesses)` (grounds a `CellProblem`).
4. `prob.program_text()` → `PlainTextResponse`: the encoding plus the facts.

---

## 7. Observations

### Dead or unused code
I grepped `epa/`, `tests/`, `bench/`, `tools/` and `web/` for each of these.
- `covers` is imported in `coordinator.py` (`from .cache import RunCache, covers`) but never used there. Only `RunCache.covered` uses it.
- `verdicts.WORDS` is never referenced. The `WORDS` in `web/evidencedialogs.js` is an unrelated JS constant.
- `CellProblem.free` and `CellProblem.ground_atoms` are computed but never read.
- The facts `val(n). val(s). val(a).` and `cert_meta/1` are emitted, but `epistemic.lp` never uses `val/1` or `cert_meta/1`.
- In `Engine.reasons`, the parameter `prob` is unused (it rebuilds `prob2`). In `Engine.rank`, `wits_on` is unused (it uses each cell's `witnesses_used`). The return value of `Engine.ensure` (the module hash) is ignored by every caller.
- Outside the six files: `runs.witness_fields_for_cell` and `cone.exact_points` are defined and never called. The per-cell `witness_projection` holds the witness's full `w["at"]`, not a projection.

### Surprising behaviour
- **The "conflict" verdict comes almost only from a missing path.** A witness that contradicts certificates leads to suspension and an ordinary verdict, with `conflicts` / `suspended` filled in. The README's verdict table reads as if conflicting evidence gives "conflict". On top of that, `lacks_path` is global: one witness that matches no run makes every cell "conflict", even cells it has no rows in common with.
- **Safety-net conflict sets are lost.** Sets found in `decide`'s safety net go only into `extra_susp`. They are never added to `gsusp["conflicts"]`, so `report.suspension.conflicts` never lists them. In the second pass the cell has them suspended but no longer lists them in `conflicts`. Also, the loop runs at most twice: if pass 2 finds new conflicts, they are added to the reported suspension, but no cell is decided again with them.
- **"nonconfluent" means two different things.** In `tlc-done` it counts TLC runs whose interleavings reached different fixpoints (`terminal_variants > 1`). In a cell result it counts grouped runs whose outcome differs once the firing choice is projected onto the cell's rows (`agree == False`).
- **Firing-choice counts for large cones.** `_count_vectors` returns −1 for cones with more than 16 rows. The `tlc` event then says "TLC explores -1 firing choice(s)", `vectors` is −1, and the pruning note is never shown.
- **`covered` only checks single pin sets.** Explored pin sets that together cover a request (for example `{r: N}` and `{r: A}` against `{}`) are not recognised, so `ensure` still calls TLC, with no firing choices left to explore.
- **Two scope rules.** `applies` uses the use cases in which the point can carry a message, together with `inert`. `suspension` uses a different filter: the witness's use case must be in the certificate's scope. Also, certificates already suspended for contradicting each other stay in the witness checks, so the same pair can be reported again as a witness conflict set for every witness whose cone holds that row.
- **`possibilities` disagrees with the ASP in two ways.**
  - Certificate striking loops over all in-force certificates and skips only those suspended within `prob.cert_ids`. A certificate withheld by the scope rule (not in `prob.cert_ids`) therefore strikes candidates in the table even though the verdict does not use it.
  - Witness striking checks each linked witness on its own and leaves unpinned rows outside the cell free. The ASP chooses those extra rows jointly for all witnesses, so with several linked witnesses the table can leave a candidate the ASP excludes.
- **Per-cell endpoints rebuild cones from all cells.** `possibilities`, `trace_of` and `/asp` use `C.cones(m, C.cells(m))`. If the analysis ran with `only_cells`, the merged cone (and its key) can differ: `trace_of` may then find no coverage and return an empty story, and `possibilities` / `/asp` may start new TLC runs.
- **The `/asp` text records no evidence switches.** It holds `cert/3` and `wit/1` facts but not which externals were on, and externals default to false. Solved as is with clingo, it gives the result with no certificate or witness in force, and it does not show the suspension.
- **Witness cones are built twice.** `suspension` calls `witness_cone` directly instead of the memoised `wcone`, so each witness cone is computed once there and once more in `problem`.
- **Smaller points.**
  - The cell's `fields` is the merged cone's `fields`, not `cell_fields[cell.id]`, and it is what the trace story receives.
  - `inert` and `cone.py` cache `_possible` / `_normal_edges` as attributes added to the `Model` object.
  - In `stage_inputs`, an unknown `stage_id` silently runs all stages and returns `None` as the stage meta. The model is loaded once per stage even for stages with no logs. `lookup_files` also picks up the deployments JSON, which `app.case_bundle` deliberately leaves out.
