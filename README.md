# EPA engine v2 — bimodal error propagation analysis for agentic systems

This repository is the tool of the TDK paper. It takes a model of an agentic system (components,
edges, guards, observation points, use cases), runs every firing choice of the rows that matter
for each observation point through **TLA+/TLC**, hands those runs to **clingo** as facts, and
answers, for every observation point and failure mode, what the evidence leaves possible:

| verdict | meaning |
|---|---|
| guarantee | in every candidate the evidence leaves, the failure never reaches the point |
| hope | in every remaining candidate it reaches the point sometimes (an LLM row decides) |
| exposed | it reaches the point whenever the point is used |
| unchecked | the remaining candidates disagree; the statuses are the advice |
| not exercised | no use case uses the point |
| conflict | the evidence contradicts itself; minimal conflict sets are reported and suspended |

The analyst works in a browser: draws or imports the model, drops in logs and certificates, runs
the analysis and reads the verdicts with their reasons, the candidates, a reaching run, and the
ranking of which guard to certify next.

## Quick start

Requirements: Python 3.11 or newer, Java 11 or newer (for TLC). `tla2tools.jar` is in `vendor/`.

```sh
./run.sh            # makes .venv, installs the requirements, starts the UI on http://127.0.0.1:8765
```

or by hand:

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m epa serve --port 8765
```

On macOS without Java: `brew install openjdk@21` (and follow brew's note about the symlink), or
any JDK from adoptium.net. `GET /api/health` reports what the server found.

## The workbench

1. **Model.** A canvas with a palette: LLM components, deterministic components, tools, stores,
   external systems and users, system inputs and outputs, guards and observation points. Drag a
   component onto the canvas, drag from the round handle on its right to another component to
   connect them (ports are named for you), drop a guard or an eye onto an edge. The inspector
   edits whatever is selected: kind, version, pass-through modes, authority and clearance, the
   normal flow matrix, rows (when … then emit …, with the activation of fixed rows), the LLM
   worst-case defaults and their recorded drops, guard targets and decidability, observation
   point tolerations, and with nothing selected the model itself: failure modes, lattices, use
   cases, claims. The model is checked as you edit (the badge and the footer). `Import YAML / JSON`
   and `Export YAML` round-trip the same document the CLI reads. `Bootstrap from traces` drafts a
   model from OpenTelemetry-style spans and an MCP tools list.
2. **Evidence.** Drop log files: a recogniser (YAML) turns their lines into witnesses at
   observation points; a deployment manifest makes witnesses from before a version change stale.
   Drop certificates: they are classified against the model (the LLM rule rejects a certificate
   that would make an LLM row never; undecidable targets and stale versions are rejected too).
   Withdraw a certificate or reject a witness (two reviewers), with the reason recorded.
3. **Analysis.** Runs the coordinator and streams its log: cells and cones, each TLC call (firing
   choices, distinct states, depth, seconds), each ASP decision, each conflict. The generated
   TLA+ module of every cone and the ASP program of every cell can be opened.
4. **Verdicts.** The verdict of every cell, grouped by observation point, with the statuses,
   what to do, why (structural, the certificates it rests on, dropped defaults), the root causes,
   the candidates as boxes with what struck them, a reaching run told round by round, the
   certify-next ranking, the claims and whether the evidence supports them, certificates to
   re-verify, and the exports (Markdown report, CRA JSON).

## The demo cases

Each case under `cases/` is a model drawn from the architecture figure (`figure.svg`, shown by the
`Case figure` button), mock data that looks like the real thing (`data/`), certificates
(`certs/`), recognisers (`recognisers/`) and a scenario (`case.yaml`) whose stages assemble the
evidence step by step. Pick a case in the header and click through the stages, or start from
stage S0 and upload the files from `data/` and `certs/` yourself in the Evidence view.

* **Smart-home hub** — a voice and calendar planner (LLM) with memory, a hub, devices, a local
  fallback; a learned memory filter and judge, an interlock, a rate window, a skill sandbox. S0
  design time (conf at the egress is exposed by construction), S1 certificates (the judge's
  vendor evaluation is rejected), S2 a week of logs, S3 the redesign (`model-v2.yaml`).
* **Delegated wallet agent** — an LLM pays invoices under an EUDI-wallet mandate; mandate, dedup,
  amount, cap, revocation-sync and disclosure checks. S1 certificates, S2 the bank statement of
  15 October pays an IBAN off the mandate (conflict with the mandate certificate, suspended), S3
  the certificate is withdrawn, S4 the fixed check is re-certified, S5 the LLM is replaced.
* **MCP coding agent** — a planner and a runner with a workspace, a shell, an MCP server and a
  package registry; tool pinning, allowlist, secret scanner, token scope, lockfile and test
  gates. S1 certificates (the "tests pass" claim is rejected), S2 a PR leaks a private
  repository's content, S3 the scoped token is certified. `intake/` holds traces, two tools
  lists (the later one is a rug pull) and the answers for the bootstrap.

From the command line:

```sh
python -m epa case wallet               # every stage
python -m epa case wallet --stage S2 --format md
python -m epa check cases/smart-home/model.yaml
python -m epa tla cases/wallet/model.yaml oom@o_statement     # the TLA+ module of a cone
python -m epa bootstrap --traces cases/mcp-coding-agent/intake/traces.jsonl \
    --tools cases/mcp-coding-agent/intake/tools_list.json --server mcp \
    --answers cases/mcp-coding-agent/intake/answers.yaml
pytest -q                                # the paper's table, the cases, ASP against enumeration
```

## How it is built

```
epa/model/       load.py (the YAML/JSON document → Model), defaults.py (LLM worst-case rows, guard
                 leak and false-positive rows), wellformed.py, cone.py (cells, path-sensitive cones)
epa/translate/   to_tla.py: one TLA+ module per cone; Init picks a use case and a firing choice,
                 Next is one synchronous round, the run ends at the fixpoint
epa/alethic/     tlc_runner.py (runs TLC, caches by module hash), dump_reader.py, runs.py
epa/epistemic/   asp/epistemic.lp, reason.py (brave reasoning, minimal conflict sets), verdicts.py
epa/intake/      cert_import.py, log_import.py (recognisers), mcp_import.py, bootstrap.py
epa/engine/      coordinator.py (certificates prune firing choices before TLC; conflicts; reasons;
                 certify-next ranking), cache.py (SQLite run cache), scenario.py (case stages)
epa/report/      explain.py, markdown.py (report and CRA export)
epa/api/app.py   FastAPI: model check, evidence intake, analyses with server-sent events
web/             the workbench (plain ES modules, no build step)
cases/           the three demo cases
docs/            model-format.md
```

`docs/model-format.md` describes the model document field by field.
