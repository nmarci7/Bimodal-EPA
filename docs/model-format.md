# The model document

A model is one YAML (or JSON) document. The workbench reads and writes the same document as the
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
  pass: [commission, late]   # modes passed through unchanged ("all" for every mode)
  trusted: true              # an untrusted component taints what it touches (default: false for external and user)
  authority: principal       # the component's own authority
  raises: true               # acts on its own authority (signs, approves)
  clearance: personal        # the most confidential data it may receive
  rows: [...]
  drop_defaults: [...]       # LLM components only
  pos: {x: 70, y: 320}       # canvas position (optional)
```

### Rows

A row says what a component does with a failure, or which failure it starts.

```yaml
- id: p_dup
  label: re-plans on a stale account view and pays the invoice again
  when: {view: {late: 3}}            # an input port and a pattern: "any", or {mode: threshold}
  then: {request: {dup: const 9}}    # an output port and what it emits: const k | keep | +k | max
  activation: sometimes              # optional: always | sometimes | never fixes the row
```

A row without `activation` is open: the analysis treats never, sometimes and always as candidates
and lets the evidence choose. An LLM component's rows can only be sometimes or always (the LLM
rule). `when: {"*": any}` matches any input.

### Worst-case defaults of an LLM component

Every output port of an LLM component starts with one generated row per top-level mode: any
message in, that mode at 10 out. An analyst's row on the same port and mode refines the default.
Dropping a default needs a reason, and the reason is printed wherever a verdict rests on it:

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

## Claims

```yaml
- {cell: oom@o_statement, verdict: guarantee, by: wallet team, note: "the mandate check rules it out"}
```

The verdicts judge each claim: supported, refuted, unsupported (unchecked or in conflict) or
vacuous (not exercised).

## Evidence

Certificates (JSON or YAML):

```json
{"id": "c_gm", "component": "gm", "targets": {"oom": "never"}, "version": "mandate-v2",
 "issuer": "wallet team", "date": "2026-10-01", "method": "exhaustive mandate-scope test",
 "scope": ["pay"], "context": {"agent": "gpt-x-2026-05"}}
```

`targets` names guard targets (`never` or `always`); `rows` names rows directly. A certificate is
rejected if it would make an LLM row or an undecidable target never, and stale if its version is
not the component's. `context` lists the upstream versions it was signed against; a change there
asks for re-verification without voiding it.

Recognisers (YAML) turn log lines into witnesses; see `cases/*/recognisers/` for CSV, JSON Lines,
JSON and regular-expression formats, lookups (the mandate CSV), grouping and aggregation. A
deployment manifest (`data/deployments.json`) dates the versions, so a witness from before a
change is stale.
