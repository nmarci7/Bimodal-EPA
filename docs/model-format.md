# The model document

A model is one YAML (or JSON) document. The reasoner reads and writes the same document as the
command line; `Export YAML` gives it back with the canvas positions. `cases/*/model.yaml` are
complete examples, and `tests/models/running_example.yaml` is the running example of the paper.

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
components: [...]
guards: [...]
edges: [...]
use_cases: [...]
observation_points: [...]
claims: [...]                # optional
layout: {sys: {...}}         # optional: canvas positions of the system ports
```

Every failure is a magnitude from 0 (none) to 10. A sub-kind is a failure of its parent mode: a
guard that catches `commission` catches `dup` too, and an observation point that tolerates
`commission` judges each sub-kind it lists.

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
  trusted: true              # an untrusted component taints what it touches (default: false for external and user)
  authority: principal       # the component's own authority
  raises: true               # acts on its own authority (signs, approves)
  clearance: personal        # the most confidential data it may receive
  rows: [...]
  drop_defaults: [...]       # LLM components only
  pos: {x: 70, y: 320}       # canvas position (optional)
```

### Ports

`in` and `out` are the component's input and output ports, In(c) and Out(c). An edge runs from an
output port (or a system input) to an input port (or a system output). One output port may feed
several edges, which then carry the same message; one input port may receive several edges, whose
tokens are merged. A port may stay unconnected. The reasoner draws inputs as hollow dots and
outputs as filled dots on the component's border, and lists the component's whole mapping table
(analyst rows, pass-through, LLM defaults, absorbed failures) under the canvas.

### Pass-through and absorption (assumption A6)

A message goes on where the component forwards it (its `flow`, or a forwarding row) carrying every
failure it brought: a non-LLM component passes every mode through unless the model says otherwise.
A failure stops only where the model says so, and every such place is a claim with a reason:

* `absorbs: [{port, modes, reason}]` - the component always absorbs these modes (and their sub-kinds)
  arriving on that port (`modes: all` for every mode); the reason is required and is reported;
* a sink row (below) - the component may absorb a failure; whether it does is an activation the
  candidates choose and a certificate can fix.

An LLM component passes nothing through: what it sends carries only the failures its rows emit (its
worst-case defaults cover every top-level mode). The old `pass:` key is rejected.

### Rows

A row says what a component does with a failure, which failure it starts, or where it forwards a
message. Four kinds, read off the row:

* a **failure row** - a condition and at least one failure emitted (the usual row);
* an **internal fault** - no `when` (or `when: {}`): it needs no incoming message and fires whenever it
  is switched on; it may only emit `const k`;
* a **forwarding row** - only `any` patterns and every output `as it is`: the message goes on with
  nothing added (a fork-join forwarding when it names several ports). Its activation is fixed
  (`always` unless given), and the messages it sends are normal ones, which a guard never drops;
* a **sink row** - no `then`: when it fires it absorbs the failures its patterns name on those ports.

`then: {port: as it is}` (or `{port: {}}`) on a failure row sends the message there as it arrived; it
exists because the failure row fired, so a guard that catches something in it may drop it.

```yaml
- id: p_dup
  label: re-plans on a stale account view and pays the invoice again
  when: {view: {late: 3}}            # an input port and a pattern: "any", or {mode: threshold}
  then: {request: {dup: const 9}}    # an output port and what it emits: const k | keep | +k | max
  activation: sometimes              # optional: always | sometimes | never fixes the row
```

A row without `activation` is open: the analysis treats never, sometimes and always as candidates
and lets the evidence choose. An LLM component's rows can only be sometimes or always (the LLM
rule). `when: {"*": any}` matches a message on any input port; "any input" takes only `any` and
stands alone, so a failure pattern names its port.

### Worst-case defaults of an LLM component

Every output port of an LLM component starts with one generated row per top-level mode: any
message in, that mode at 10 out. Only an analyst row with the same trigger - `when: {"*": any}`, or
the only input port with `any` - that emits the same top-level mode on the same port replaces it; a
magnitude below 10 is recorded as a calibration. Every other row emitting there (a failure pattern, a
fork-join, a sub-kind) is added beside the default, because a narrower trigger would say that the LLM
does not start the failure on its own. A row of an LLM component that emits a failure can never be
fixed to `never` (the LLM rule). Dropping a default needs a reason, and the reason is printed wherever
a verdict rests on it:

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
  fp_omission: 10            # learned guards: the omission a false positive causes
  targets:
    - {mode: oom, threshold: 1, decidable: true}   # or {taint: true}, {conf: pseudonymous}, {auth: agent}
```

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
    - {port: invoice, token: {taint: true, auth: none, conf: personal}}
    - {port: principal, token: {auth: principal, conf: personal, modes: {late: 2}}}
```

## Observation points

An observation point is an edge where a log exists. It judges what the receiver gets, after every
guard on the edge. Each tolerated mode, and each assessed provenance dimension, is a cell of the
verdict table.

```yaml
- id: o_statement
  edge: e_transfer
  label: bank statement
  log: the customer's bank statement (CSV export)
  tolerate: {commission: 1, oom: 1, dup: 1, late: 5}   # the lowest magnitude no longer accepted
  taint: reject              # optional: the receiver tolerates no taint
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
cases in which none of the certified rows can fire. No scope means every use case.

When a witness and some certificates leave no candidate, the subset-minimal such sets are found for
the whole model (each witness is checked over the cone of everything it logs), and every certificate
in one of them is suspended in every cell. A witness that no run of the model matches means the model
lacks a path: every cell is then in conflict until the model is fixed.

Recognisers (YAML) turn log lines into witnesses; see `cases/*/recognisers/` for CSV, JSON Lines,
JSON and regular-expression formats, lookups (the mandate CSV), grouping and aggregation. A
deployment manifest (`data/deployments.json`) dates the versions, so a witness from before a
change is stale.
