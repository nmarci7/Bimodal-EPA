# The model layer

Part of the [developer guide](../developer-guide.md). Files: `epa/model/load.py`,
`epa/model/defaults.py`, `epa/model/wellformed.py`, `epa/model/cone.py`, `epa/model/edit.py` (described
in [mcp.md](mcp.md)); `epa/model/__init__.py` is empty. Line numbers are left out on purpose:
`python tools/inventory.py` prints the current ones.

## 1. Purpose

### epa/model/load.py
The entry point of the model layer. It takes a model document (a path, YAML or JSON text, or a dict),
checks the raw document (`validate`), turns it into a `Model` (`normalise`) and runs the
well-formedness checks (`wellformed.check`). Its data structures are the dataclasses `Component`,
`Edge`, `Row`, `ObsPoint`, `UseCase` and `Model`, and `ModelError`, which carries a list of problem
strings. Every later stage reads the `Model`: `translate/to_tla.py`, `engine/coordinator.py`,
`epistemic/reason.py`, `intake/cert_import.py`, `intake/log_import.py`, `alethic/runs.py`,
`report/explain.py`. `load_model` is called by `epa/api/app.py`, `epa/cli.py`,
`epa/engine/scenario.py`, `epa/mcp/server.py`, `bench/bench.py` and the tests; `read_document` by
`app.py`, `scenario.py` and the MCP server; `validate` by `app.py` directly (parse, check, bootstrap),
the MCP server and `tests/test_ports.py`.

### epa/model/defaults.py
Creates the generated rows of the mapping tables: for LLM components the worst-case default rows
(`default.<comp>.<port>.<mode>`), for guards one leak row per target (`leak.<guard>.<key>`) and, for a
learned guard, a false-positive row (`fp.<guard>`). It also writes `calibrate-default` and
`drop-default` records into `m.decisions`. Its only caller is `load.normalise`, after the analyst rows
exist; it imports `Row` from `.load` inside each function (load already imports defaults).

### epa/model/wellformed.py
Checks that run on the normalised `Model` (`check`, called by `load_model`, which raises `ModelError`
on problems), and `absorbed(m)`, the review list of where failures stop (declared absorptions and sink
rows; assumption A6), used by `cli.py check`, `/api/model/check` and `Engine.analyse`.

### epa/model/cone.py
Turns observation points into verdict cells (`Cell`) and computes for each cell a cone (`Cone`): the
components, edges, use cases, rows and mode fields that can change that cell. Cones of one observation
point are merged so that one TLC run serves several cells. It also holds the reachability analyses used
to decide whether a row creates a message and to apply the certificate scope rule (`normal_edges`,
`possible`, `_trigger_possible`). `Cone.key` is the run-cache key, versioned by `SEMANTICS = 2`.
Consumers: the coordinator (`analyse`, `witness_cone`, `inert`, `applies`, `reasons`, `possibilities`,
`trace_of`), `translate/to_tla.py` (reads the `Cone`; `guard_strata` uses `upstream`, `normal_edges`,
`possible`; `_component` uses `forwarding`), `intake/log_import.classify_witness` (`upstream`),
`alethic/runs.py` (`cone.rel`), `api/app.py`, `cli.py` and the tests.

## 2. Definitions

### epa/model/load.py

| Definition | What it does | Calls |
|---|---|---|
| `ModelError` | Exception carrying a list of problem strings in `problems`; raised by `load_model` when validation or the well-formedness checks fail. | — |
| `ModelError.__init__` | Stores `problems` as a list (a single value is wrapped); the message is the problems joined with `"; "`. | — |
| `Component` | Dataclass for one normalised component or guard (fields in part 3). | — |
| `Component.llm` | Property: `kind == "llm"`. | — |
| `Component.is_guard` | Property: `kind == "guard"`. | — |
| `Edge` | Dataclass for one edge segment after guard splitting. | — |
| `Edge.src_comp` | Property: `src[0]`, the sending component id or `"sys"`. | — |
| `Edge.dst_comp` | Property: `dst[0]`, the receiving component id or `"sys"`. | — |
| `Row` | Dataclass for one mapping-table row, written by the analyst or generated. | — |
| `Row.emits_failure` | Property: some output port in `then` has a non-empty emission (False for as-is-only rows, sinks and leak rows). | — |
| `Row.to_json` | A JSON-ready dict: id, comp, kind, when, then (tuples become lists), asis, open, fixed, llm, decidable, target, label; `reason` is left out. | — |
| `ObsPoint` | Dataclass for a normalised observation point. | — |
| `UseCase` | Dataclass for a use case whose entries are resolved to edge ids and tokens. | — |
| `Model` | Dataclass for the whole normalised model, which the rest of the engine reads. | — |
| `Model.auth_top` | Property: the index of the top authority level. | — |
| `Model.children` | The sub-kinds whose parent is mode `m`. | — |
| `Model.family` | `[m]` followed by its sub-kinds: the fields a mode's effective magnitude reads. | load.Model.children |
| `Model.edges_into` | Every segment whose `dst == (comp, port)` (linear scan). | — |
| `Model.edges_from` | Every segment whose `src == (comp, port)` (linear scan). | — |
| `Model.comp_rows` | Every row (analyst and generated) of a component, in insertion order. | — |
| `Model.doc_hash` | The first 16 hex characters of SHA-256 over the document as sorted JSON. | — |
| `Model.summary` | A JSON-ready overview: components (kind, label, ins, outs, version, on_edge, on_cycle, learned, targets), edge segments (src, dst, origin, label), rows (`to_json`), observation points (levels turned back into names), use cases (entry edge ids), name, description, fields, parent, lattices, warnings. | load.Row.to_json |
| `read_document` | A dict is deep-copied; a string with no newline ending in `.yaml`, `.yml` or `.json` is read as a file; text is parsed as JSON, falling back to YAML. | — |
| `load_model` | `read_document`, `validate` (raises `ModelError`), `normalise`, `wellformed.check` (raises `ModelError`); returns the `Model`. | load.read_document, load.validate, load.normalise, wellformed.check |
| `_mode_list` | Reads `doc["modes"]` and returns `(top, parent)`: a string is a top mode; `{name, subkinds}` or `{mode: [subs]}` adds the mode and maps each sub-kind to it; anything else is ignored. | — |
| `_parse_ref` | `"owner.port"` → `(owner, port)` (split at the first dot); None for a non-string or a string without a dot. | — |
| `validate` | Checks the raw document and returns problem strings (empty: valid); returns early if it is not a mapping or lacks `components`/`edges`. The rule families are in 4(d). Side effect: `_guard_edge` rewrites a guard's `on:` key into `edge:` in the document passed in. | load._mode_list, load._absorbed_modes, load._is_asis, load._parse_op, load._parse_ref, load._guard_edge, load._entries |
| `_guard_edge` | The document edge a guard cuts; moves `on` (or the boolean `True`, which YAML 1.1 reads a bare `on` as) to `edge`, in place. | — |
| `_entries` | A use case as `[{port, token}]` with `sys.` stripped; reads `entries`, or an older single `entry`/`token` pair. | — |
| `_is_asis` | True for an emission that adds nothing: None, `{}`, or `"as it is"`/`"as-is"`/`"asis"` (case-insensitive). | — |
| `_absorbed_modes` | The modes of an `absorbs` entry (`modes`, else `mode`); `"all"` gives every field. | — |
| `_parse_op` | An emit operator → `(op, k)`: an int is `const` (clamped 0–10); `keep` and `max` have k = 0; `+k` is `plus` (not clamped); `const k` is clamped; anything else raises ValueError. | — |
| `_parse_when` | `when` → `{port: {"any": True}}` for `any`/None/True, else `{port: {"modes": {mode: threshold}}}`; None gives `{}`. | — |
| `normalise` | Builds the `Model` from a valid document (4a): fields, lattices, components, edge segments split by guard chains, guard components, observation points, use-case entries, analyst rows, absorb decisions, generated rows, cycle flags. | load._mode_list, load._absorbed_modes, load._parse_ref, load._guard_edge, load._entries, load._token, load._is_asis, load._parse_op, load._parse_when, defaults.add_llm_defaults, defaults.add_guard_rows, load._mark_cycles |
| `_token` | A use-case token → `{"b": {field: magnitude}, "c": conf index, "a": auth index, "t": taint}`; fields default to 0, `c` to the bottom, `a` to the top, `t` to false. | — |
| `_mark_cycles` | Sets `on_cycle` on every component that can reach itself (DFS over the component graph, ignoring `sys`). | — |

### epa/model/defaults.py

| Definition | What it does | Calls |
|---|---|---|
| `replaces_default` | True if analyst row `r` replaces the default for `(port, mode)`: kind `row`, `mode` (a top-level mode exactly) in `r.then[port]`, and `r.when` is `{"*": any}` or, on a single-input component, `{that input: any}`. | — |
| `add_llm_defaults` | For each LLM component, output port and top mode: a replacing analyst row wins (a `const k < 10` is recorded as a `calibrate-default` decision); else a `drop_defaults` entry is recorded as a `drop-default` decision; else the row `default.<cid>.<port>.<mode>` is added (kind `default`, `{"*": any}` ⇒ mode const 10, open, llm). | load.Model.comp_rows, defaults.replaces_default |
| `add_guard_rows` | For each guard target adds `leak.<gid>.<key>` (key: the mode name, else the target kind; `when {"in": any}`, empty `then`, open, llm if learned, decidable if the target is decidable and the guard is not learned); a learned guard also gets `fp.<gid>`, which emits omission at `fp_omission` (or 10) on `out`. | load.Component.is_guard |

### epa/model/wellformed.py

| Definition | What it does | Calls |
|---|---|---|
| `check` | Problems in the normalised model: a learned guard with a decidable target; a taint target on a guard without `closed_output`; a row using `keep`, `+k` or `max` while no `when` pattern names a mode; an observation point whose segment does not exist. | load.Component.is_guard |
| `absorbed` | The places where failures stop: each declared absorption (`kind: declared`) and each sink row per `when` port (`kind: sink`). | — |

### epa/model/cone.py

| Definition | What it does | Calls |
|---|---|---|
| `Cell` | Frozen dataclass for one verdict cell: (kind, field, obs). | — |
| `Cell.id` | `"{field}@{obs}"`, e.g. `oom@o_statement`. | — |
| `Cell.parse` | The inverse of `id`: the field `taint`, `conf` or `auth` is also the kind, otherwise the kind is `mode`. | — |
| `Cone` | Dataclass for the sub-model one TLC run explores, covering cells of one observation point. | — |
| `Cone.key` | The cache key: SHA-256 (16 hex) over the semantics version, the rows (`to_json`), the component signatures, the edges, the use cases' entries and the fields. | load.Row.to_json, cone._comp_sig |
| `_comp_sig` | The component attributes that affect runs: kind, flow, passes, trusted, authority, raises, targets (without `row`), learned, closed_output, fp_omission, on_cycle. | — |
| `cells` | The cells, point by point: one mode cell per tolerated field (in `m.fields` order), then `taint` (if `taint: reject`), `conf` (if a clearance resolved), `auth` (if a requirement resolved); `only` filters by id. | — |
| `upstream` | The components from which a message can reach an edge (backward DFS over the component graph, ignoring `sys`, including the source). | — |
| `_when_ports` | The input ports a row reads (every input for `"*"`). | — |
| `forwarding` | Every way a component forwards a message: each `flow` pair `([p], q, None, "all")`, and each non-N `fwd`/`row` row with as-is outputs (join `any` for `"*"`, `all` otherwise). | load.Model.comp_rows |
| `normal_edges` | Per use case, the edges that carry a normal message (fixpoint from the entry edges through flows and forwarding rows; guards pass normal messages). | load.Model.edges_into, load.Model.edges_from, cone.forwarding |
| `possible` | Per use case, an over-approximation of which edges can carry a message and which fields can be non-zero there (fixpoint through forwarding, emitting rows whose trigger is possible, and false-positive rows; sinks, drops and activations are ignored). | load.Model.edges_into, load.Model.edges_from, load.Model.comp_rows, cone.forwarding, cone._trigger_possible |
| `_trigger_possible` | Whether a row's `when` can match given the reachable incoming edges and fields. | load.Model.family |
| `_creates_message` | Whether, in some use case where the row's trigger is possible, the edges leaving the port are not all normal (the row would create a message); caches `normal_edges`/`possible` on the model. | cone.normal_edges, cone.possible, cone._trigger_possible |
| `downstream_guards` | The guards reachable forwards from the edges leaving a port (every output port of each visited component is followed). | load.Model.edges_from, load.Component.is_guard |
| `_trigger_fields` | The union of the families of the modes named in a row's `when`. | load.Model.family |
| `cone_of_cell` | The path-sensitive cone of one cell (4b). | cone.upstream, cone.forwarding, cone._creates_message, cone.downstream_guards, cone.normal_edges, cone.possible |
| `cones` | One cone per cell, grouped by point and merged greedily (largest first) while the union of rows has at most `merge_limit` (10) members or one is a subset of the other. | cone.cone_of_cell |
| `exact_points` | The observation points on a cone's edges whose fields the cone's runs compute exactly. | cone.upstream, cone._creates_message |

## 3. Dataclasses

**Component**: `id`; `kind` (llm, deterministic, tool, store, external, user, guard); `label`; `ins`/`outs`
(a guard has `in`/`out`); `flow` (input → outputs; default every input to every output); `passes`
(input → the fields passed through unchanged: every field minus the absorbed ones for a non-LLM
component, none for an LLM, all for a guard); `absorbs` (`[{port, modes, reason}]`); `trusted`
(default false for external and user); `authority`, `clearance` (indices; default the top),
`requires` (default the bottom); `raises`; `version`; for guards `targets` (`{decidable, kind,
mode+threshold | level}`, plus `row`, the leak row id), `learned`, `closed_output`, `fp_omission`,
`on_edge`; `on_cycle`; `pos`.

**Edge**: `id` (the document edge id for the first segment, `"{eid}__{gid}"` after guard `gid`), `src`
and `dst` (`(component, port)` or `("sys", name)`), `label`, `origin` (the document edge).

**Row**: `id`, `comp`; `kind` (`row` for a failure row or internal fault, `fwd`, `sink`, `default`,
`leak`, `fp`); `when` (port → `{"any": True}` or `{"modes": {field: threshold}}`; `"*"` is any input;
`{}` an internal fault); `then` (output port → `{field: (op, k)}`); `open`; `llm` (can never be N);
`decidable`; `target` (leak rows); `label`, `reason`; `fixed` (`A`, `S`, `N` or None); `asis`.

**ObsPoint**: `id`; `edge` (the last segment of the document edge: what the receiver gets after every
guard); `doc_edge`; `label`, `log`; `tolerate` (field → the lowest magnitude no longer accepted);
`taint` (accept | reject); `clearance`, `requires` (indices or None).

**UseCase**: `id`, `label`, `entries` (`[(edge id, token)]`, one per edge leaving `sys.<port>`).

**Model**: `name`, `description`, `top_modes`, `fields` (each top mode then its sub-kinds), `parent`,
`conf_levels`, `auth_levels`, `components` (guards included), `edges` (segments), `rows` (analyst and
generated), `obs`, `use_cases`, `claims`, `decisions` (the document's plus generated `absorb`,
`calibrate-default`, `drop-default` records), `doc`, `warnings` (always empty). `_normal_edges` and
`_possible` are attached at runtime by cone.py, to_tla.py and the coordinator.

**Cell** (frozen): `kind` (mode, taint, conf, auth), `field`, `obs`.

**Cone**: `cells`, `obs`, `components` (the upstream components, sorted), `edges` (the sub-edges),
`use_cases`, `rows` (rows whose activation varies: open or fixed S), `always` (rows fixed A), `fields`,
`cell_rows`, `cell_fields`, `rel` (the `(edge, field)` pairs the runs compute exactly), `cell_rel`,
`scope_ucs` (the use cases in which the observed segment can carry a message; for the scope rule).

## 4. Algorithms

### (a) load_model

1. `read_document` (a dict is deep-copied; a path is read; JSON, else YAML).
2. `validate(doc)`; problems raise `ModelError`.
3. `normalise(doc)`:
   1. **Fields**: `_mode_list` gives the top modes and parents; `fields` lists each mode then its
      sub-kinds. Levels default to `public < internal < confidential` and `none < user < admin`.
   2. **Components**: ports, flow (default every input to every output), absorptions; `passes[p]` is
      empty for an LLM, otherwise every field minus the modes absorbed at `p` and their sub-kinds
      (pessimistic pass-through, A6). Defaults: trusted unless external or user, top authority, top
      clearance, bottom requirement.
   3. **Edges**: one `Edge` per document edge.
   4. **Guards as components on edges**: the guards of an edge, in document order, cut it into
      segments: `e: A→g1.in`, `e__g1: g1.out→g2.in`, `e__g2: g2.out→B` (the first guard listed is
      nearest the sender). Each guard is a `Component` of kind `guard` with ports `in`/`out`, flow
      `in→out`, passing every field, trusted.
   5. **Observation points** sit on the last segment: what the receiver gets after every guard. If a
      point names neither clearance nor requirement and the receiver is a component, the receiver's
      own levels apply when they are not the extreme ones; `receiver` resolves to the receiver's index.
   6. **Use cases**: every edge leaving `sys.<port>` gets the token (`_token`).
   7. **Analyst rows**: as-is ports get `{}`; emissions are parsed by `_parse_op`; `when` by
      `_parse_when`. The kind is `sink` with no `then`; `fwd` with only `any` patterns, a non-empty
      `when` and every output as-is; `row` otherwise. The activation defaults to `always` for `fwd`
      and open otherwise; `fixed` maps always/sometimes/never to A/S/N.
   8. **Model**, with an `absorb` decision per declared absorption.
   9. **Generated rows**: `add_llm_defaults`, then `add_guard_rows` (c).
   10. **Cycles**: `_mark_cycles` (only guards' flags change behaviour: a guard on a cycle never drops).
4. `wellformed.check(m)`; problems raise `ModelError`.

### (b) Cells and cones

**Cells**: one mode cell per tolerated field at each point, plus `taint`, `conf` and `auth` cells when
the point judges them. The id is `field@obs`.

**`cone_of_cell(m, cell)`**, with `o` the point:
1. **Scope**: `U = upstream(m, o.edge)`, the sub-edges (edges into U, plus `o.edge`), and the use cases
   with an entry edge among them. These depend only on the point.
2. **Seed**: for a mode cell, `rel = {(o.edge, f) for f in family(cell.field)}`; provenance cells start
   empty (rows never write those values).
3. **Existence phase**: every row in U of kind row/default/fp, not fixed N, that creates a message on
   a path to the point (`_creates_message`) is included; every non-cycle guard downstream of it, in U,
   brings all its targets' leak rows (catching any target can drop the created message).
4. **Provenance phase** (taint, conf, auth cells): every guard in U with a target of that kind.
5. **Backward worklist** over `(edge, field)`: a guard passes the field to its input and brings its
   matching mode targets (and its fp row for `omission`); a component brings the rows that write the
   field on that port, the forwarding rows feeding it, the field on the inputs whose `passes` contain
   it, and the sink rows that can absorb it there. Nothing propagates through an LLM except what its
   own rows write.
6. **Forwarding rows** in U, not fixed N, are included as structure.
7. **Result**: `rows` (open or fixed S), `always` (fixed A), `fields`, `components`, `scope_ucs`.

The cone is *path-sensitive*: relevance is tracked per `(edge, field)`, so a row is pulled in only if
it writes a field that matters on that edge, or creates a message on a path to the point.

**`cones(m, cells, merge_limit=10)`** groups the per-cell cones by point and merges them (union of
rows, always rows, fields, `rel`) while the union stays within the limit or one is a subset of the
other.

### (c) Generated rows

* **LLM worst case**: for each LLM output port and top mode, a replacing analyst row (same trigger, same
  mode, same port) wins and a magnitude below 10 is recorded as a calibration; otherwise a dropped
  default is recorded with its reason; otherwise `default.<cid>.<port>.<mode>` is added. Every other
  analyst row stays beside the default.
* **Guards**: one leak row per target (`leak.<gid>.<key>`: when it fires, the target gets through;
  otherwise the target is caught: mode fields capped at threshold − 1, conf or auth set to the level,
  taint cleared, and a non-normal message dropped unless the guard is on a cycle); a learned guard's
  `fp.<gid>` emits omission.

### (d) The rules of `validate`

1. Shape: a mapping with `components` and `edges`.
2. Components: unique id (not `sys`), a known kind, known levels; the old `pass:` key is rejected.
3. Absorptions: an input port, known modes, a reason; never on an LLM.
4. Rows (syntax): an id; `when` ports are inputs or `"*"` (which takes only `any` and stands alone);
   known modes; `then` maps outputs to as-is or known modes with valid operators.
5. Rows (structure): no sink on an LLM; a sink names a failure; an internal fault emits a failure; an
   LLM row that emits a failure is never `never`.
6. `drop_defaults` entries need a reason.
7. Edges: unique ids; `from` an output port, `to` an input port, or `sys.*`.
8. Guards: an id unique among components and guards; a document edge; known target modes and levels.
9. Observation points: a document edge; known modes; levels or `receiver` (not for a system output).
10. Use cases: every entry port has an edge leaving `sys.<port>`; at least one use case.

After normalisation `wellformed.check` adds: a learned guard has no decidable target; a taint target
needs `closed_output`; `keep`, `+k` and `max` need a mode pattern; the observed segment exists.

## 5. Workflow notes

**A model document is checked** (`POST /api/model/check`): `validate` → `load_model` (which reads,
validates again, normalises, adds the generated rows and checks) → `cells` → for each cell
`cone_of_cell` (the first call fills `normal_edges`/`possible`) and `candidate_space` → the response
`{ok, summary, cells, absorbed, decisions}`. A `ModelError` gives `{ok: false, problems}`.

**A cell's cone in an analysis**: `Engine.analyse` → `cells` → `cones` (→ `cone_of_cell` per cell, then
merging) → per merged cone: `applies` (scope rule), `pins`, `Cone.key`, `ensure` (cache, then
`to_tla.module_for`, `tlc_runner.run`, `runs.runs_from_dump`), `decide` per cell.

## 6. Observations

These come from reading the code; none changes a verdict of the demo cases (the test suite passes).

* **Never called**: `cone.exact_points`, `cone._when_ports`, `cone._trigger_fields`, `Edge.src_comp`,
  `Edge.dst_comp`, `Row.emits_failure`, `Model.doc_hash`; `Model.warnings` is never appended to;
  `api/app.py` imports `normalise` without using it.
* **`fp_omission: 0`** on a learned guard becomes 10 in the fp row (`or 10`) but 0 in the TLA+
  (`to_tla` uses the attribute directly): the two disagree for that value.
* **`drop_defaults`** entries on a non-LLM component, or naming an unknown port or a sub-kind, are
  ignored silently; an entry without `port` or `mode` passes `validate` and fails later with KeyError.
* **Inputs that crash instead of giving a problem** (`/api/model/check` answers HTTP 500): `const`
  without a number; a guard target with none of mode, taint, conf, auth; a use-case token with an
  unknown level; a `when` pattern that is neither `any` nor a mapping; an observation point without an
  id. Component `flow` is not checked against the ports. The MCP server catches these and reports them
  as problems (`epa/mcp/server.py`, `check`).
* **Ids not checked for uniqueness**: rows, observation points and use cases (a duplicate silently
  overwrites in the model's dictionaries).
* **Leak row ids collide** when one guard has two targets of the same key (two `conf` targets, or one
  mode twice): both point to one row, coupling their activations.
* **`validate` changes its input** (`on` → `edge`), and `/api/model/check` runs it twice.
* **Hard-coded `omission`** in fp rows, `cone_of_cell` and `to_tla`: a model without that mode has fp
  rows that emit nothing.
* **Undocumented in model-format.md**: `{name, subkinds}` mode items, the guard key `on:`, single
  `entry`/`token` use cases, the absorb key `mode:`, `as-is`/`asis`, unclamped `+k`, several guards on
  one edge forming a chain in document order, and the defaults of tokens and components.
