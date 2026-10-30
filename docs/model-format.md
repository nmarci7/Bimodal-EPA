# The model document

A model is one YAML (or JSON) document. The reasoner reads and writes the same document as the
command line; `Export YAML` gives it back with the canvas positions. `cases/*/model.yaml` are
complete examples, `tests/models/paper_listing.yaml` is the running example as the paper prints it, and
`tests/models/running_example.yaml` is its one-port form, which the reference implementation can read.

```yaml
name: wallet-agent
description: free text
modes:                       # the behavioural failure modes; a mapping adds sub-kinds
  - omission
  - commission: [oom, dup, over, revoked]
  - late
  - value
lattices:                    # low → high
  confidentiality: [public, pseudonymous, personal]
  authority: [none, agent, principal]
worst_case_defaults: all     # optional: every component starts with worst-case rows (FPTC style);
                             # llm (the default when absent): only LLM components do
severity: {oom: 9, dup: 9}   # optional: how much a mode weighs in the certify-next ranking (default 1)
components: [...]
guards: [...]
edges: [...]
use_cases: [...]
observation_points: [...]
claims: [...]                # optional
layout: {sys: {...}}         # optional: canvas positions of the system ports
```

A failure mode is present or absent. A sub-kind is a failure of its parent mode: a guard that catches
`commission` catches `dup` too, and an observation point that tolerates `commission` judges each
sub-kind it lists. An engineer may refine a mode into ordered levels when the analysis needs it: the tool
encodes such a scale as whole numbers 0 to 10, larger is worse, and rows, thresholds and tolerances may
then use numbers (`const k`, `keep`, `+k`, `threshold: k`). Everything below works the same on either scale.

`severity` only ranks: it says what the ranking weighs when a guard turns this failure into a guarantee.
It changes no verdict.

A new model (File → New model, or `new_model` over MCP) starts with the failure classes of FPTC
(Wallace 2005), from the HAZOP/SHARD guide words, which match the service, timing and value error
families of the AADL error library (SAE AS5506), and with `worst_case_defaults: all`:

```yaml
modes: [omission, {commission: []}, early, late, {value: [coarse, subtle]}]
worst_case_defaults: all
```

`omission` and `commission` are service failures (a message missing, a message that should not be),
`early` and `late` timing failures, `value` a wrong content: `coarse` detectable from the data (out of
range, malformed), `subtle` plausible but wrong (Bondavalli and Simoncini).

## Components

```yaml
- id: agent                  # an identifier, unique among components and guards
  kind: llm                  # llm | deterministic | tool | store | external | user
  label: "LLM · discretionary"
  version: gpt-x-2026-05     # certificates and witnesses name versions; a change makes them stale
  in: [invoice, view]        # input ports
  out: [request]             # output ports
  flow: {invoice: [request], view: []}   # the normal flow; default: every input to every output
  absorbs:                   # non-LLM components: failures that stop here (everything else passes through)
    - {port: invoice, modes: [late], reason: "the intake re-reads the invoice; a stale copy is discarded"}
  taint: clean               # the taint level it adds to what it sends: clean | internal | identified | open, or 0..3
                             # (default: internal for llm, external and user, clean otherwise);
                             # the old `trusted: true/false` is still read and means clean/internal
  authority: principal       # the component's own authority
  raises: true               # acts on its own authority (signs, approves)
  clearance: personal        # the most confidential data it may receive
  rows: [...]
  drop_defaults: [...]       # components with worst-case defaults: LLMs, or all with worst_case_defaults: all
  pos: {x: 70, y: 320}       # canvas position (optional)
```

### Ports

`in` and `out` are the component's input and output ports, In(c) and Out(c). An edge runs from an
output port (or a system input) to an input port (or a system output). One output port may feed
several edges, each of which delivers the same token; one input port may receive several edges, and has
one queue, in arrival order. A port may stay unconnected. The reasoner draws inputs as hollow dots and
outputs as filled dots on the component's border, and lists the component's whole mapping table
(analyst rows, pass-through, worst-case defaults, absorbed failures) under the canvas.

### Pass-through and absorption (assumption A6)

A message goes on where the component forwards it (its `flow`, or a forwarding row) carrying every
failure it brought: a non-LLM component passes every mode through unless the model says otherwise.
A failure stops only where the model says so, and every such place is a claim with a reason:

* `absorbs: [{port, modes, reason}]` - the component always absorbs these modes (and their sub-kinds)
  arriving on that port (`modes: all` for every mode); the reason is required and is reported;
* a sink row (below) - the component may absorb a failure; whether it does is a frequency the
  candidates choose and a certificate can fix.

An LLM component passes nothing through: what it sends carries only the failures its rows emit (its
worst-case defaults cover every top-level mode). The old `pass:` key is rejected.

### Firing

Every input port has a FIFO queue, and arrival only appends to it. A component is ready when one of its
queues is non-empty, or when it has a switched-on internal fault not yet applied. In each step of a run
one ready component fires; which one is free, and the analysis covers every choice. A firing takes the
head of every non-empty queue and applies the table to those heads. A component remembers nothing of
earlier firings. A run ends when no component is ready, and an edge never delivers a token value it has
already carried in the run, so every run ends. Tokens that stand at the heads together are combined in
one firing; tokens taken in different firings are not.

### Rows

A row (a table entry) says what a component does with a failure, which failure it starts, or where it
forwards a message. Four kinds, read off the row:

* a **failure row** - a condition and at least one failure emitted (the usual row);
* an **internal fault** - no `when` (or `when: {}`): it needs no incoming message, makes its component
  ready while it is switched on and not yet applied, and applies once per run, in the component's first
  firing; it may only emit the mode present or `const k`;
* a **forwarding row** - only `any` patterns and every output `as it is`: the message goes on with
  nothing added (a fork-join forwarding when it names several ports, which applies only when all of them
  have a head in one firing). Its frequency is fixed (`always` unless given), and the messages it sends
  are normal ones, which a guard never drops;
* a **sink row** - no `then`: when it applies it absorbs the failures its patterns name on those ports,
  in that firing. A sink naming a second port holds a failure back only when both stand at the heads
  together: this is how a reading holds a command back, and why that is a race.

A row applies in every firing whose heads match it, if it is switched on for the run. A row naming
several ports matches only if all of them have a head that matches, in one firing: nothing is remembered
between firings. `then: {port: as it is}` (or `{port: {}}`) on a failure row sends the message there as it
arrived; it exists because the failure row applied, so a guard that catches something in it may drop it.

```yaml
- id: p_dup
  label: re-plans on a stale account view and pays the invoice again
  when: {view: {late: present}}      # an input port and a pattern: "any", or {mode: present}
  then: {request: {dup: present}}    # an output port and what it emits: the mode present, or as it is;
                                     # on a refined scale also const k | keep | +k | max, and a number in `when`
  frequency: sometimes               # optional: always | sometimes | never fixes the row
```

`frequency` is how often the row applies when its heads match, never, sometimes or always; its old name
`activation` is still read. A row without `frequency` is open: the analysis treats never, sometimes and
always as candidates and lets the evidence choose. The choice holds for the whole run: there is no
counting, so a run cannot say that only the second retry goes wrong. An LLM component's rows can only be sometimes or always (the LLM
rule). `when: {"*": any}` matches a message on any input port; "any input" takes only `any` and
stands alone, so a failure pattern names its port.

### Worst-case defaults

Every output port of an LLM component - and of every component, when the model says
`worst_case_defaults: all` - starts with one generated row per top-level mode: any message in, that
mode present out, open. Only an analyst row with the same trigger - `when: {"*": any}`, or
the only input port with `any` - that emits the same top-level mode on the same port replaces it; a
magnitude on a refined scale is recorded as a calibration. Every other row emitting there (a failure pattern, a
fork-join, a sub-kind) is added beside the default, because a narrower trigger would say that the
component does not start the failure on its own. A row of an LLM component that emits a failure can
never be fixed to `never` (the LLM rule); the default of any other component can be, by a certificate
(`rows: {"<port>.<mode>": never}`), which is how evidence earns a guarantee for a component nobody
modelled. Dropping a default needs a reason, and the reason is printed wherever a verdict rests on
it:

```yaml
drop_defaults:
  - {port: request, mode: late, reason: "lateness is modelled at the bank"}
```

## Guards

A guard sits on an edge and cuts it in two. For each target it gets a leak row (the target gets
through); a learned guard also gets a false-positive row (it blocks a good message).

```yaml
- id: gm
  label: mandate
  edge: e_instruction
  version: mandate-v2
  learned: false             # a classifier or an LLM judge: no target can be certified never
  closed_output: false       # emits only from a closed set (enumerations): may wash taint
  targets:
    - {mode: oom, decidable: true}   # or {taint: open}, {conf: pseudonymous}, {auth: agent}
```

A guard judges each token it takes. A target present with its leak row off is caught: the mode is
removed, `{taint: k}` lowers taint to just below k (present if the level is at least k; `{taint: true}`
means any taint), `{conf: l}` lowers confidentiality to l and `{auth: l}` raises authority to l. A caught
message that exists only because a failure row made it is dropped, unless the guard lies on a cycle.
`threshold: k` (default 1) and `fp_omission: k` (the omission a learned guard's false positive causes,
default present) belong to a refined scale.

`decidable: true` says the target can be decided from the data on the edge, so a certificate may
say never. A taint target needs `closed_output`.

## Edges

```yaml
- {id: e_instruction, from: wallet.instruction, to: bank.instruction, label: payment instruction}
- {id: e_invoice, from: sys.invoice, to: agent.invoice}      # sys.<name> is a system input or output
```

## Use cases

A use case is where messages enter and what they carry.

```yaml
- id: pay
  label: pay an incoming invoice under the mandate
  entries:
    - {port: invoice, token: {taint: open, auth: none, conf: personal}}
    - {port: principal, token: {taint: identified, auth: principal, conf: personal, modes: {late: present}}}
```

`taint` says who could have written the content, not which channel it came through, with four levels from
good to bad: `clean` (0) only trusted components and inputs touched it; `internal` (1) a component inside
the system, typically an LLM, produced or changed it; `identified` (2) an outside party the system
authenticates could have shaped it; `open` (3) anyone could have. What a component sends carries the
worse of the taint of the heads it took and its own level. `taint: true` is still read and means `open`.

## Observation points

An observation point is an edge where a log exists. It judges what the receiver gets, after every
guard on the edge. Each tolerated mode, and each assessed provenance dimension, is a cell of the
verdict table.

```yaml
- id: o_statement
  edge: e_transfer
  label: bank statement
  log: the customer's bank statement (CSV export)
  tolerate: {commission: 1, oom: 1, dup: 1}   # what it judges; 1 for a present mode, on a refined scale
                             # the lowest magnitude no longer accepted
  tolerate_taint: identified # optional: the highest taint level the receiver accepts (see use cases);
                             # the old `taint: reject` still works and means clean
  clearance: pseudonymous    # optional: the most confidential data the receiver may get
  requires: principal        # optional: the authority the receiver requires
```

`clearance: receiver` and `requires: receiver` judge against the receiving component's own
`clearance` and `requires`; a point that names neither is judged against a receiving component whose
clearance is below the top level or whose required authority is above the bottom one. A receiver
outside the model (a system output) has neither, so the levels must be named there. A new observation
point in the reasoner judges every mode at 1.

## Claims

```yaml
- {cell: oom@o_statement, verdict: guarantee, by: wallet team, note: "the mandate check rules it out"}
```

The verdicts judge each claim: supported, refuted, unsupported (unchecked or in conflict) or
vacuous (not exercised).

## Evidence

Certificates (JSON or YAML; one record, a list, or `{certificates: [...]}`):

```json
{"id": "c_gm", "component": "gm", "targets": {"oom": "never"}, "version": "mandate-v2",
 "issuer": "wallet team", "date": "2026-10-01", "method": "exhaustive mandate-scope test",
 "scope": ["pay"], "context": {"agent": "gpt-x-2026-05"}}
```

`targets` names guard targets (`never` or `always`); `rows` names rows directly. A certificate is
rejected if it would make an LLM row or an undecidable target never, and stale if its version is
not the component's. `context` lists the upstream versions it was signed against; a change there
asks for re-verification without voiding it.

`scope` names the use cases the certificate was established for. It counts for a cell only if the
scope covers every use case in which the cell's observation point can carry a message, apart from use
cases in which none of the certified rows can apply. No scope means every use case.

A certificate that says `"table": "confirmed"` (with or without `targets` or `rows`) states that a fault
injection campaign fed the real component every reachable combination of error tokens and that every
output is covered by its table:

```json
{"id": "c_table_gm", "component": "gm", "table": "confirmed", "version": "mandate-v2",
 "issuer": "wallet team", "date": "2026-10-01", "method": "fault injection campaign", "scope": ["pay"]}
```

It follows the same rules for version, withdrawal and scope, and it changes no verdict. It is rejected on
an LLM component or a learned guard, whose tables are the worst case.

Every cell also says whether the model is consistent, complete and correct for it (`fidelity` in the
report). Only components with a row kept in the cell's cone count; a component that only forwards through
its `flow` stays out, though the search goes through it. *Consistent*: the evidence leaves a candidate.
*Complete*: every combination of tokens that stands at a component's heads in some state explored carries
only failures its table names, by a row's pattern or a declared absorption. A row that says only `any`
names nothing; an LLM component's table is the worst case and a guard's table is total by its definition,
so neither is checked. What is not covered is listed under `uncovered`. *Correct*: every component that
is not an LLM or a learned guard has a confirmed table in force, and no witness contradicts the model.

When a witness and some certificates leave no candidate, the subset-minimal such sets are found for
the whole model (each witness is checked over the cone of everything it logs), and every certificate
in one of them is suspended in every cell. A witness that no run of the model matches means the model
lacks a path: every cell is then in conflict until the model is fixed.

Recognisers (YAML) turn log lines into witnesses; see `cases/*/recognisers/` for CSV, JSON Lines,
JSON and regular-expression formats, lookups (the mandate CSV), grouping and aggregation. A
deployment manifest (`data/deployments.json`) dates the versions, so a witness from before a
change is stale.
