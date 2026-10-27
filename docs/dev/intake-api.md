# Evidence intake, reports, the command line and the HTTP API

Part of the [developer guide](../developer-guide.md). Files: `epa/intake/cert_import.py`,
`epa/intake/log_import.py`, `epa/intake/mcp_import.py`, `epa/intake/bootstrap.py`,
`epa/report/explain.py`, `epa/report/markdown.py`, `epa/cli.py`, `epa/__main__.py`, `epa/__init__.py`,
`epa/api/app.py`. The examples quoted below were produced by running the code on the files of
`cases/`. Line numbers are left out on purpose: `python tools/inventory.py` prints the current ones.

---

## 1. Purpose

### epa/intake/cert_import.py
- This module reads certificates. A certificate is a JSON or YAML record that states the activation (N = never, S = sometimes, A = always) of some rows of one component.
- `load` turns a path, text or parsed data into a list of certificate dicts.
- `resolve_rows` maps a certificate's `targets` and `rows` to model row ids, giving `{row id: N|S|A}`.
- `classify` gives the state `in force`, `stale`, `rejected` or `withdrawn`. `reverify` lists upstream components whose version changed since signing.
- The only module-level data is the `WORD` table.
- Callers:
  - `epa/engine/coordinator.py` `Engine.register` (`classify`, `reverify`)
  - `epa/engine/scenario.py` `stage_inputs` (`load`)
  - `epa/api/app.py` `evidence_certs` (`load`, `classify`, `reverify`)
  - `epa/cli.py` `run` (`load`)

### epa/intake/log_import.py
- This module turns logs, traces and statements into witnesses, using recognisers. A recogniser is a YAML dict that says how records of one log kind become witness records.
- It holds the record readers (csv, jsonl, json, regex), the condition language `holds`, and lookup lists. It also reads the deployment manifest (`load_deployments`, `versions_at`) so that each witness carries the component versions in force on its date.
- Main data structures:
  - the recogniser dict
  - the witness dict (`id, use_case, at, date, source, recogniser, versions, rule, lines`)
  - the manifest `{changes: [{date, set: {component: version}}]}`
- It also builds hand-entered witnesses (`manual_witness`, `WitnessError`) and classifies witnesses (`classify_witness`).
- Callers:
  - `epa/cli.py` `run`
  - `epa/api/app.py` `evidence_logs`, `evidence_witness`
  - `epa/engine/scenario.py` `recognisers`, `stage_inputs`
  - `epa/engine/coordinator.py` `Engine.register`
  - `tests/test_manual_evidence.py`

### epa/intake/mcp_import.py
- This module turns MCP `tools/list` responses into model material.
- `read_tools_list` reads a saved response. `tool_hash` fingerprints one tool's description and input schema.
- `tools_to_patch` makes a tool component per tool, an agent→tool and a tool→agent edge, and suggestions taken from the tool annotations. `diff_tools` compares two tool lists.
- Its only callers are `epa/intake/bootstrap.py` `skeleton_from_mcp`, `epa/cli.py` `bootstrap` and `epa/api/app.py` `do_bootstrap`. `diff_tools` is never called.

### epa/intake/bootstrap.py
- This module drafts a model document when no system model exists. The inputs are OpenTelemetry GenAI spans (JSON Lines), an optional MCP tools list, and the analyst's answers (YAML).
- `skeleton_from_traces` builds a skeleton dict `{components: {id: {...}}, edges: [{from, to, seen, source}], use_cases: [...], traces: n}`.
- `skeleton_from_mcp` adds tool information to the skeleton. `questionnaire` lists what the analyst must decide. `apply_answers` turns skeleton plus answers into a model document marked `status: "draft (accept after review)"`.
- Every element records where it came from in a `source` string.
- Callers: `epa/cli.py` `bootstrap` and `epa/api/app.py` `do_bootstrap`. `tests/test_api.py` exercises it through the API.

### epa/report/explain.py
- This module produces human-readable lines.
- `reason_line` gives one line explaining why a cell's verdict holds. `trace_story` tells a reaching run round by round.
- `NEUTRAL` maps engine verdicts to the regulator-facing labels used in the CRA export.
- Callers:
  - `epa/cli.py` `_print` (`reason_line`)
  - `epa/api/app.py` `cell_trace` (`trace_story`)
  - `epa/report/markdown.py` (`NEUTRAL`, `reason_line`)

### epa/report/markdown.py
- This module renders an analysis report (the dict returned by `coordinator.Engine.analyse`). `report` gives a Markdown document. `cra_export` gives a JSON-serialisable dict with every cell under a neutral label.
- It reads the report keys `model` (the `Model.summary()` dict), `engine`, `cells`, `register`, `ranking`, `reverify` and `absorbed`.
- Callers: `epa/cli.py` `_print` (formats `md` and `cra`), and `epa/api/app.py` `report_md` and `report_cra`. `tests/test_api.py` fetches `/report.md`.

### epa/cli.py
- This is the command line: `python -m epa serve | check | run | case | tla | bootstrap`.
- It wires the model loader, the intake modules, the engine (`coordinator.Engine`), the scenario loader and the report renderers.
- It prints to stdout. Engine progress events go to stderr unless `quiet`.
- The work directory is `$EPA_WORK`, or `<repo>/.epa-work` if that is unset.
- Callers: `epa/__main__.py`; `run.sh` runs `python -m epa serve --port $PORT`; README and user-guide examples.

### epa/__main__.py
- These three lines import `epa.cli.main` and call it, so that `python -m epa` runs the CLI. There is no `if __name__` guard.

### epa/__init__.py
- The package docstring describes the alethic layer (TLA+/TLC), the epistemic layer (ASP/clingo) and the coordinator. It sets `__version__ = "2.0.0"`.
- Nothing in the repository reads `__version__`.

### epa/api/app.py
- This is the FastAPI application behind the reasoner UI. It is started by `python -m epa serve`, which calls `uvicorn epa.api.app:app`, and it is used through `TestClient` in `tests/test_api.py`, `tests/test_ports.py` and `tests/test_manual_evidence.py`.
- The browser holds the model document and the evidence. The server parses, checks, classifies evidence, bootstraps, and runs analyses in background threads, streaming their events as Server-Sent Events.
- Server state:
  - the in-memory dict `ANALYSES`
  - the global lock `RUN_LOCK`
  - a shared SQLite `RunCache` at `WORK/runs.sqlite`
  - the `WORK` directory, which holds TLC artefacts
  - `/web` static files
  - a middleware that sends `Cache-Control: no-cache` for the UI files

---

## 2. Definitions

### epa/intake/cert_import.py
| Definition | What it does | Calls |
|---|---|---|
| `WORD` (constant) | Maps `never/sometimes/always`, `n/s/a` and `N/S/A` to `N/S/A`. | — |
| `load(src)` | String input: a single-line string ending in `.json/.yaml/.yml` that exists is read as a file; any other string is treated as the text. The text is parsed as JSON, then YAML if JSON fails. Dict or list input is used as is. `{certificates: [...]}` is unwrapped. Returns a list; a single record is wrapped. | — |
| `resolve_rows(cert, m)` | Returns `{row id: activation}`. Each `targets` key `k` becomes `leak.<component>.<k>`. Each `rows` key is kept if it is in `m.rows`; otherwise every existing candidate among `<comp>.<k>`, `leak.<comp>.<k>`, `default.<comp>.<k>` overwrites it, so the last one that exists wins. Values go through `WORD`; unknown values are kept verbatim. | — (uses `WORD`) |
| `classify(cert, m, withdrawn=())` | Returns `(state, reason, rows)`, where `rows` is the resolved map. State is `withdrawn`, `rejected`, `stale` or `in force`; rules in section 4. | cert_import.resolve_rows |
| `reverify(cert, m)` | For each `context` entry (component → version at signing) whose component exists in `m` with a non-null version different from the signed one, adds `{component, signed_with, now}`. Returns the list. | — |

### epa/intake/log_import.py
| Definition | What it does | Calls |
|---|---|---|
| `load_recogniser(src)` | A dict is returned as is. A string containing `\n` is parsed as YAML text. Any other string is opened as a file path and parsed as YAML. | — |
| `load_deployments(src)` | `None` gives `{"changes": []}`; a dict is returned as is. A single-line string naming an existing file is read from disk; otherwise the string is the text. Parsed as JSON, then YAML if JSON fails. | — |
| `versions_at(deployments, date)` | Sorts `changes` by `date`. Merges, in date order, the `set` map of every change whose `str(date)` ≤ `str(date)[:10]` of the argument. Returns `{component: version}`. | — |
| `records(text, rec)` | Generator of `(line_no, record)` by `rec.format` (default `jsonl`). Unknown format raises `ValueError`. Per-format behaviour is in the table "Reading records" in section 3. | — |
| `_get(rec, path)` | Follows a dotted path through nested dicts. Returns `None` if any part is missing. | — |
| `_num(x)` | Returns `float(x)`, or `None` on `TypeError` or `ValueError`. | — |
| `holds(cond, r, lookups)` | Evaluates one condition (section 3) on record `r` and returns a bool. Raises `ValueError("unknown condition")` if no operator applies. | log_import.holds (recursive), log_import._get, log_import._num |
| `_lookups(rec, base_dir, files=None)` | Builds `{name: set[str]}` from `rec.lookups`. `values` gives the set of the listed items. Otherwise `file` is read from `files[basename(file)]`, or from `os.path.join(base_dir, file)` if it is not there. A `.csv` file gives `{row[column].strip()}`, read with a comma delimiter; any other file is JSON and gives `data[key]` if `key` is given, else `data`, each element as a string. | — |
| `_resolve_levels(at, m)` | Copies each observation entry of a witness `at` map. `modes` values become `[int(lo), int(hi)]`; a scalar `k` becomes `[k, k]`. If a model is given, `conf`/`auth` level names (a scalar, or the elements of a pair) become indices into `m.conf_levels`/`m.auth_levels`, using `list.index`, so an unknown name raises `ValueError`. Other keys are copied. | — |
| `_aggregate(recs_iter, rec)` | Groups records by `str(_get(r, group_by))`, in first-seen order. Each group is the first record's fields plus `_count` and `_lines`. Yields `(first line, group record)`. | log_import._get |
| `witnesses_from_text(text, filename, rec, m=None, deployments=None, base_dir=".", files=None)` | Applies one recogniser to one file and returns `(witnesses in first-seen order, unmatched line numbers)`. Algorithm in section 3. | log_import._lookups, log_import.records, log_import._aggregate, log_import.holds, log_import._resolve_levels, log_import._get, log_import.versions_at |
| `WitnessError` (class) | `ValueError` subclass raised for a hand-entered witness that does not fit the model. | — |
| `WitnessError.__init__(self, problems)` | Message is the problems joined with `"; "`. The list is kept as `.problems`. | — |
| `manual_witness(spec, m, deployments=None)` | Validates a hand-entered witness spec against the model. Collects every problem and raises `WitnessError` if there are any. Otherwise returns a witness shaped like a recogniser's, with `recogniser: "manual"`. Details in section 3. | log_import._resolve_levels, log_import.load_deployments, log_import.versions_at |
| `classify_witness(w, m, rejected=())` | Returns `(state, reason)` with state `rejected`, `stale` or `in force`. Rules in section 3. | model.cone.upstream |
| `recognise_all(text, filename, recognisers, m=None, deployments=None, base_dir=".", files=None)` | Applies every recogniser whose `files` globs match `basename(filename)` (fnmatch). If none match, uses the result of `recognise_any`. Returns `[(rec, witnesses, unmatched)]`. | log_import.witnesses_from_text, log_import.recognise_any |
| `recognise_any(...)` | Returns the first recogniser whose glob matches, applied. Otherwise tries every recogniser in turn, ignoring its globs and skipping any that raise, and returns the first that yields at least one witness. Returns `(None, [], [])` if none does. | log_import.witnesses_from_text |

### epa/intake/mcp_import.py
| Definition | What it does | Calls |
|---|---|---|
| `read_tools_list(src)` | A string starting with `{` (after leading whitespace) is parsed as JSON text. Any other string is a path to a JSON file (`json.load(open(src))`). Anything else is used as parsed data. Unwraps a JSON-RPC `result` and returns `data["tools"]`, or `[]`. | — |
| `tool_hash(t)` | Returns the first 12 hex characters of SHA-256 over `json.dumps({"description", "inputSchema"}, sort_keys=True)`. | — |
| `tools_to_patch(tools, agent="agent", agent_port_call="call", agent_port_result="result", server="mcp", server_trust=False)` | For each tool, with id = name with `-` and `.` replaced by `_`:<br>- a component `{id, kind: "tool", label: first 60 chars of the description, in: ["call"], out: ["result"], trusted, version: "<server>:<hash>", source: "mcp tools/list (<server>)", schema_fields: sorted inputSchema property names}`<br>- edges `e_<agent>_<tid>` (`agent.call → tid.call`) and `e_<tid>_<agent>` (`tid.result → agent.result`)<br>- a suggestion "observation point on the call edge" if `destructiveHint` or `openWorldHint`, with `hint` = every truthy annotation key<br>- a suggestion "read-only: its result edge carries the server's data" if `readOnlyHint`<br>Returns `{components, edges, suggestions}`. | mcp_import.tool_hash |
| `diff_tools(old, new)` | Compares two tool lists by name and hash. Returns `{changed, added, removed}` as sorted name lists. | mcp_import.tool_hash |

### epa/intake/bootstrap.py
| Definition | What it does | Calls |
|---|---|---|
| `read_spans(text)` | Parses JSON Lines into a list of span dicts; blank lines are skipped. | — |
| `skeleton_from_traces(spans, use_case_attr="app.use_case")` | Groups spans by `trace_id`. Derives components, edges (with counts), use cases and the trace count. Returns the skeleton dict. Details in section 5. | — |
| `skeleton_from_mcp(tools, skel, server="mcp", server_trust=False)` | Picks the server component and either folds the tools into it or adds one tool component per tool. Sets `skel["suggestions"]`. Mutates and returns `skel`. Details in section 5. | mcp_import.tools_to_patch, mcp_import.tool_hash |
| `questionnaire(skel)` | Returns a list of `{key, ask}` questions for the analyst (section 5). | — |
| `apply_answers(skel, ans, name)` | Turns skeleton plus answers into a draft model document. Raises `ValueError` if the data flow is unconfirmed or a guard does not have exactly one edge in and one out. Details in section 5. | bootstrap.ref (nested) |
| `apply_answers.ref(x, side)` (nested) | `sys.*` is returned unchanged. A component in `outside` becomes `sys.<x>`. Anything else becomes `<rename.get(x, x)>.<side>`. | — |

### epa/report/explain.py
| Definition | What it does | Calls |
|---|---|---|
| `NEUTRAL` (constant) | Maps verdicts to labels: guarantee → "ruled out (model-relative)", hope → "possible, mitigated, monitored", exposed → "occurs whenever exercised", unchecked → "undetermined", not exercised → "not exercised by the modelled use cases", conflict → "evidence in conflict". | — |
| `reason_line(cell)` | Builds a `"; "`-joined line from `cell.reasons` and `cell.suspended`:<br>- `structural` gives "structural: no row can change it"<br>- `certificates` gives "rests on a, b"<br>- each decision gives `default dropped on <component> (<port>/<mode>): "<reason>"`<br>- `suspended` gives "suspended: …" | — |
| `_tok(m, k, fields)` | Describes a token `k`:<br>- `"<field> <magnitude>"` for each field in `fields` with a non-zero `k.b[field]`<br>- "tainted" if `k.t`<br>- the confidentiality level name if `k.c` is non-zero<br>- "authority <level>" if `k.a` < `m.auth_top`<br>Returns "clean" if none apply. | — |
| `trace_story(m, trace, fields)` | `None` or empty input gives `[]`. Otherwise returns one entry per step in which some edge label changed: `{step: "start" or "round N", edges: ["src → dst: <token>"], fired}`. The first step lists edges whose label has `u` set; later steps list edges whose label differs from the previous step. A `sys` endpoint is shown by its port name. | explain._tok |

### epa/report/markdown.py
| Definition | What it does | Calls |
|---|---|---|
| `report(rep)` | Renders the report dict as Markdown text (section 6). Uses `datetime.now()` for the timestamp. | explain.reason_line |
| `cra_export(rep, product="", version="")` | Builds the regulator-facing dict (section 6). | explain.reason_line |

### epa/cli.py
| Definition | What it does | Calls |
|---|---|---|
| `ROOT` (constant) | The repository root (the parent of `epa/`). | — |
| `_engine(model, quiet=False)` | Returns `Engine(model, $EPA_WORK or ROOT/.epa-work, on_event=…)`. Unless `quiet`, each event prints to stderr as `  <t:7.2f>s  <step:<9> <msg>`. | engine.coordinator.Engine |
| `_print(rep, fmt)` | Prints a report in the chosen format (`text`, `md`, `json` or `cra`; section 7). | report.markdown.report, report.markdown.cra_export, report.explain.reason_line |
| `main(argv=None)` | Builds the argparse parser and dispatches the six subcommands (section 7). | model.load.load_model, model.cone.cells, model.cone.cone_of_cell, model.cone.cones, model.wellformed.absorbed, epistemic.reason.candidate_space, cert_import.load, log_import.load_recogniser, log_import.load_deployments, log_import.recognise_all, engine.scenario.load_case, engine.scenario.stage_inputs, translate.to_tla.module_for, bootstrap.read_spans, bootstrap.skeleton_from_traces, bootstrap.skeleton_from_mcp, bootstrap.questionnaire, bootstrap.apply_answers, mcp_import.read_tools_list, cli._engine, cli._print, coordinator.Engine.analyse |

### epa/__main__.py
| Definition | What it does | Calls |
|---|---|---|
| (module body) | `from .cli import main; main()`. | cli.main |

### epa/__init__.py
| Definition | What it does | Calls |
|---|---|---|
| `__version__` | Set to `"2.0.0"`. Never read anywhere. | — |

### epa/api/app.py
| Definition | What it does | Calls |
|---|---|---|
| `ROOT`, `WEB`, `CASES` | The repository root, `ROOT/web` and `ROOT/cases`. | — |
| `WORK` | `$EPA_WORK` or `ROOT/.epa-work`. Created at import with `os.makedirs`. | — |
| `app` | `FastAPI(title="EPA engine v2", version="2.0")`. | — |
| `CACHE` | `RunCache(WORK/runs.sqlite)`, shared by every `Engine` the API builds. | engine.cache.RunCache |
| `ANALYSES` | In-memory dict `{analysis id: state dict}`. | — |
| `RUN_LOCK` | A `threading.Lock` that serialises engine work. | — |
| `_model(doc)` | `load_model(doc)`; a `ModelError` becomes HTTP 422 `{problems}`. | model.load.load_model |
| `_case_dir(case)` | Returns `CASES/<case>`. Raises 404 if it is not a directory, contains a path separator, or starts with `.`. | — |
| `health()` | Returns `{java, java_version, tla2tools (jar path or None), clingo, python, work}`. | alethic.tlc_runner.java_ok, alethic.tlc_runner.find_jar |
| `cases()` | Lists every `cases/*/case.yaml` as `{id, title, summary, figure, order}`, sorted by `order` (missing order counts as 99). | — |
| `case(case)` | Returns `{id, meta, model_text, model (parsed), files}`. `files` holds the relative paths of every file in the case whose name does not start with a dot. | api._case_dir, model.load.read_document |
| `case_file(case, path)` | Returns the file under the case directory as plain text. 404 if the path leaves the directory or is not a file. | api._case_dir |
| `case_figure(case)` | `FileResponse` of `meta.figure`; 404 if there is none. | api._case_dir |
| `Text` (class) | Pydantic body `{text: str}`. | — |
| `Doc` (class) | Pydantic body `{doc: dict}`. | — |
| `model_parse(body)` | `read_document(text)` (on error 422 "cannot read the document: …"). Returns `{doc, problems}`, where `problems` is `validate(doc)` or `["not a mapping"]`. | model.load.read_document, model.load.validate |
| `model_check(body)` | Validates and then loads the model. On problems returns `{ok: false, problems}`. Otherwise returns `{ok: true, problems: [], summary, cells, absorbed, decisions}`. Each `cells` entry is `{cell, rows, fields, components, candidates, runs}`, with `runs = 2^#rows × max(1, #use_cases)`. | model.load.validate, model.load.load_model, model.cone.cells, model.cone.cone_of_cell, epistemic.reason.candidate_space, model.wellformed.absorbed, Model.summary |
| `model_yaml(body)` | Returns `yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=110)` as plain text. | — |
| `LogUpload` (class) | Body `{doc, filename, text, recognisers: [str], deployments: str or None, lookups: dict}`. | — |
| `evidence_logs(body)` | Loads the model, recognisers and manifest, and runs `recognise_all` with `files=lookups` (an exception becomes 422). Classifies each witness and returns `{recognisers: [ids], witnesses (with state and reason), unmatched: [{recogniser, line}]}`. If nothing matched, adds `note: "no recogniser matched this file"`. | api._model, log_import.load_recogniser, log_import.load_deployments, log_import.recognise_all, log_import.classify_witness |
| `case_bundle(case)` | Returns `{id, meta, model_text, models, recognisers, deployments, lookups, logs, certificates, intake, stages}`; contents in the section 8 route table. | api._case_dir, engine.scenario.load_case, api.rel |
| `case_bundle.rel(p)` (nested) | Returns `os.path.relpath(p, case dir)`. | — |
| `case_stage(case, stage)` | Returns `{doc, evidence: {certificates, witnesses, decisions}, stage}` for one scenario stage. | api._case_dir, engine.scenario.stage_inputs |
| `CertUpload` (class) | Body `{doc, text}`. | — |
| `evidence_certs(body)` | For each certificate in `text`, returns the certificate plus `state, reason, resolved, reverify`. No decisions are applied. | api._model, cert_import.load, cert_import.classify, cert_import.reverify |
| `WitnessIn` (class) | Body `{doc, witness: dict, deployments: str or None}`. | — |
| `evidence_witness(body)` | `manual_witness`; a `WitnessError` becomes 422 `{problems}`. Classifies the witness and returns `{witness}`. | api._model, log_import.manual_witness, log_import.classify_witness |
| `EvidenceReq` (class) | Body `{doc, evidence: dict = {}}`. | — |
| `evidence_register(body)` | Returns `Engine(m, WORK, cache=CACHE).register(evidence)`, i.e. `{certificates, witnesses, decisions}` with states that take the decisions into account. | api._model, coordinator.Engine.register |
| `Boot` (class) | Body `{traces, tools?, answers?, name="bootstrapped", server="", server_trust=False}`. | — |
| `do_bootstrap(body)` | Runs skeleton, optional MCP step, questionnaire and optional answers. Returns `{skeleton, questions}`, plus `doc` and `problems` when answers are given; any exception becomes `problems: [str(e)]`. | bootstrap.read_spans, bootstrap.skeleton_from_traces, mcp_import.read_tools_list, bootstrap.skeleton_from_mcp, bootstrap.questionnaire, bootstrap.apply_answers, model.load.validate |
| `AnalysisReq` (class) | Body `{doc, evidence={}, cells: [str] or None, rank=True, label=""}`. | — |
| `start_analysis(body)` | Loads the model and creates the `ANALYSES[aid]` state, where `aid` is 10 hex characters. Starts a daemon thread running `work` and returns `{id}` at once. | api._model, api.work |
| `start_analysis.on_event(e)` (nested) | Appends the event to `st["events"]`. | — |
| `start_analysis.work()` (nested) | Under `RUN_LOCK`: builds an `Engine` (stored in `st["engine"]`), runs `analyse(evidence, only_cells, rank)`, adds `id` and `label` to the report and sets `status="done"`. On an exception sets `status="error"`, `error` = message plus the last 2000 characters of the traceback, and appends `{step: "error"}`. | coordinator.Engine, coordinator.Engine.analyse |
| `analysis_events(aid)` | 404 if the id is unknown. Otherwise returns `StreamingResponse(gen(), "text/event-stream")`. | api.gen |
| `analysis_events.gen()` (nested) | Yields `data: <event json>\n\n` for each new event, polling every 0.1 s. Once the status is not `running` and all events are sent, yields `event: end\ndata: {status, error}`. | — |
| `analysis(aid)` | Returns `{id, status, error, report, events}`; 404 if unknown. | — |
| `_engine(aid)` | Raises 404 "analysis not ready" unless the status is `done`. Returns `(st, fresh Engine(st.model, WORK, cache=CACHE))`. | coordinator.Engine |
| `possibilities(aid, cell)` | Under `RUN_LOCK`, returns `eng.possibilities(cell, st.evidence)`: candidates with their status and what strikes them. | api._engine, coordinator.Engine.possibilities |
| `cell_trace(aid, cell)` | Finds the cell's `example_run` in the report. If there is none, returns `{cell, story: [], note}`. Otherwise, under `RUN_LOCK`, calls `trace_of(cell, uc, frozenset(fire))` and returns `{cell, run, story}`. | api._engine, coordinator.Engine.trace_of, explain.trace_story |
| `cell_asp(aid, cell)` | Finds the cell's cone and builds the register. Under `RUN_LOCK`, calls `ensure(cone, [{}])` (every firing choice) and then `problem(...)` with the in-force certificates and witnesses. Returns the ASP program text. | api._engine, model.cone.cones, model.cone.cells, coordinator.Engine.register, coordinator.Engine.ensure, coordinator.Engine.problem, model.cone.Cell.parse, epistemic.reason (problem).program_text |
| `tla(h)` | Reads `WORK/tlc/<basename(h)>/`. Returns `{module: Cone.tla, cfg: Cone.cfg, library: EpaLib.tla, stats: last 3000 characters of stats.txt}`; 404 if the directory is missing. | — |
| `report_md(aid)` | Returns `markdown.report(report)` as `text/markdown`; 404 if there is no report. | report.markdown.report |
| `report_cra(aid)` | Returns `markdown.cra_export(report)` as JSON; 404 if there is no report. | report.markdown.cra_export |
| `WORKSPACE` | `$EPA_WORKSPACE` or `<WORK>/workspace.json`: the shared workspace file the MCP server also uses (epa/workspace.py). | workspace.default_path |
| `workspace_meta()` | `GET /api/workspace/meta`: `{exists, updated, by, name, case, stage, path}` of the shared workspace, without the model. | workspace.meta |
| `workspace_get()` | `GET /api/workspace`: `{doc, evidence, case, stage, updated, by}`; 404 when the workspace has no model. | workspace.load |
| `WorkspaceIn` (class) | Body `{doc, evidence = {}, case?, stage?}`. | — |
| `workspace_put(body)` | `PUT /api/workspace`: saves the model and the evidence (certificates, witnesses, decisions, recognisers, deployments, lookups, files) as written by the browser, and returns the new meta. | workspace.save, workspace.meta |
| `revalidate_ui(request, call_next)` (async middleware) | Sets `Cache-Control: no-cache` on responses for `/` and `/web/*`. | — |
| `app.mount("/web", StaticFiles(WEB))` | Serves `web/` statically, only if that directory exists. | — |
| `index()` | Returns `FileResponse(web/index.html)`. | — |

---

## 3. Recognisers

A recogniser is a YAML mapping. This is what the code reads, using `cases/wallet/recognisers/bank-statement-v1.yaml` as the example:

```yaml
id: bank-statement-v1                 # required: the witness's `recogniser`, and API `unmatched[].recogniser`
files: ["duna-bank-*.csv"]            # fnmatch globs on the file's basename
format: csv                           # csv | jsonl (default) | json | regex
use_case: pay                         # a string, or {field: f, map: {value: use case}}
date: {field: booking_date}           # default {field: date}; a non-dict value is a literal date
id_field: end_to_end_id               # the witness key
id_prefix: stmt                       # default: the file stem
match: {field: channel, eq: delegate-agent}
lookups:
  mandate: {file: mandate.csv, column: iban}
rules:
  - label: payee IBAN not on the mandate
    when: {field: creditor_iban, not_in: mandate}
    witness: {o_statement: {modes: {oom: [1, 10]}}}
  - label: payee IBAN on the mandate
    when: {field: creditor_iban, in: mandate}
    witness: {o_statement: {modes: {oom: [0, 0]}}}
```

### Reading records (`records`)
| format | extra keys | line numbers | record |
|---|---|---|---|
| `csv` | `delimiter` (default `,`) | data rows from 2 (the header is line 1); counts records | header→value dict; keys and values stripped; empty or `None` keys dropped |
| `jsonl` | — | physical line, from 1; blank lines skipped | `json.loads(line)` |
| `json` | `items` (default `items`) | position in the list, from 1 | element of `data[items]` (top-level object) or of the top-level list |
| `regex` | `pattern` (required) | physical line, from 1 | `re.search(pattern).groupdict()`; lines that do not match are silently skipped |

### Other keys
- **`match`**: a condition. Records that fail it are skipped silently: they produce no witness and are not counted as unmatched.
- **`rules`** (required): a list of `{label?, when?, witness}`. The first rule whose `when` holds decides; a missing `when` always holds. A record that passes `match` but fits no rule has its line number added to `unmatched`.
- **`witness`**: `{obs_id: {modes: {field: [lo, hi] | k}, conf: level | [lo, hi], auth: level | [lo, hi], taint, used, …}}`. It goes through `_resolve_levels`: a mode `k` becomes `[k, k]`, and with a model, level names become indices. Other keys are copied unchanged. Recogniser witnesses are **not** checked against `m.fields`.
- **`use_case`**: a literal, or `{field, map}`. For the map form the value is `map[str(field value)]`, falling back to the raw field value (example: `egress-v1.yaml`).
- **`date`**: `{field}` gives `str(value)[:10]`. A non-dict value is used literally (`date_spec or ""`).
- **Witness key**: `id_field` value; else the `group_by` value (only when not aggregating); else the line number. The id is `w_<id_prefix or file stem>_<key>`, with every non-alphanumeric character replaced by `_`. Example: `w_stmt_DUNA_AGT_000413`.
- **Records with the same key** merge into one witness:
  - `lines` grows
  - per observation point, `modes` dicts are merged (a later value for the same mode overwrites)
  - other per-point keys are overwritten
  - `use_case`, `date`, `source`, `rule` and `versions` come from the first record
- **`group_by` + `aggregate: true`** (example: `bank-statement-dup-v1.yaml`):
  - `match` is applied first, then `_aggregate` gives one record per group: the first record's fields, plus `_count` (lines sharing the key) and `_lines`.
  - Rules see `_count`, as in `when: {field: _count, ge: 2}`.
  - `lines` gets all of the group's lines.
  - Without `id_field`, the key is the group's first line number, e.g. `w_dup_2`.
- **`lookups`**: `{name: {values: [...]}}` (inline); `{name: {file, column}}` (CSV, read with a comma delimiter); or `{name: {file, key?}}` (JSON). The file text comes from the `files` dict by basename (the API's `lookups` body field; `scenario.lookup_files` for cases), else from `base_dir/file`.
- **Applying recognisers to a file** (`recognise_all`): every recogniser whose glob matches is applied; one log can yield several kinds of witness, e.g. the wallet statement is read by both `bank-statement-v1` and `bank-statement-dup-v1`. If no glob matches, `recognise_any` tries every recogniser regardless of its globs and keeps the first that yields at least one witness.

### Condition language (`holds(cond, r, lookups)`)
Only the **first** applicable key in this order is evaluated.

1. `None` → true.
2. `{all: [c…]}`, `{any: [c…]}`, `{not: c}`.
3. Otherwise `field` (a dotted path, via `_get`) is required; `v` is its value.

| key | true when |
|---|---|
| `eq_field: g` | `str(v) == str(r[g])` |
| `ne_field: g` | `str(v) != str(r[g])` |
| `nonempty: b` | `bool(v) == bool(b)` |
| `eq: x` | `str(v) == str(x)`. YAML `true` becomes `"True"`. |
| `ne: x` | `str(v) != str(x)` |
| `in: S` | `S` is a lookup name (string) or a literal list (elements as strings). A list `v`: every element is in `S`. A scalar: `str(v)` is in `S`. |
| `not_in: S` | A list `v`: some element is not in `S`. A scalar: `str(v)` is not in `S`. |
| `contains: x` | `v` is not `None` and `str(x)` is in `v`: list membership if `v` is a list, else a substring of `str(v)`. |
| `regex: p` | `v` is not `None` and `re.search(p, str(v))` matches. |
| `gt` / `ge` / `lt` / `le: n` | Both sides convert with `float()` and the comparison holds. False if either is not numeric. |
| `exists: b` | `(v is not None and v != "") == bool(b)` |
| anything else | raises `ValueError("unknown condition …")` |

### Witness record produced
`{id, use_case, at: {obs_id: {modes: {f: [lo, hi]}, conf: [i, j], auth: [i, j], taint, used}}, date (YYYY-MM-DD), source: "<basename> line <first line>", recogniser: <rec id>, versions: versions_at(deployments, date), rule: <rule label or "">, lines: [line numbers]}`

The API and `Engine.register` add `state` and `reason`.

`versions` comes from the deployment manifest. Example `cases/wallet/data/deployments.json`: `{system, note, changes: [{date, set: {component: version}}]}`. Every change up to the witness's date is applied in order, so a witness dated 2026-10-15 gets `gm: mandate-v2`, and one dated 2026-10-20 or later gets `mandate-v3`.

### `manual_witness(spec, m, deployments=None)`: witnesses entered by hand
The spec is `{id?, use_case?, date?, source?, note?, at: {obs_id: {modes, taint, conf, auth, used}}}`. Each line below is a problem that gets collected:
- `at` is not a non-empty dict.
- An observation id is not in `m.obs`.
- A mode name is not in `m.fields`.
- A magnitude is not an integer, or not within `0 ≤ lo ≤ hi ≤ 10`. A scalar `k` means `[k, k]`.
- `conf`/`auth` is not a pair, or names a level outside `m.conf_levels`/`m.auth_levels`. Numeric elements are not range-checked.
- An observation entry ends up empty ("say what was seen there …").
- The use case is unknown.
- The date is not `YYYY-MM-DD`.

`taint` and `used` are coerced to `bool` when present and not `None`. If any problem was collected, the function raises `WitnessError(problems)`. Otherwise:
- `at` is `_resolve_levels(norm, m)`.
- `versions` is `versions_at(load_deployments(deployments), date)` if both are given, else the model's own non-null component versions.
- `id` is `spec.id`, or `w_manual_` + the first 6 hex characters of SHA-1 over `[at, uc, date]`; characters other than alphanumerics and `_` are replaced by `_`.
- `source` is `spec.source` or "entered by hand"; `recogniser` is `"manual"`; `rule` is `spec.note` or `""`; `lines` is `[]`.

### `classify_witness(w, m, rejected=())`
Checks run in order:
1. `w.id` is in `rejected` → `rejected`, "rejected by a recorded decision (second reviewer signed)". `Engine.register` builds this set from decisions with `kind: reject-witness` and a `second_reviewer`.
2. A logged observation point is not in `m.obs` → `rejected`.
3. `use_case` is set and unknown → `rejected`.
4. The witness passed through every component upstream of its observation points (`cone.upstream(m, obs.edge)` for each point, unioned). For each `versions` entry whose component is in that set and has a non-null model version that differs from the witness's, the reason "`<cid>` was `<v>`, now `<version>`" is added. If any are found → `stale`, reasons joined with `; `.
5. Otherwise → `in force`, `""`.

---

## 4. Certificates

**Record format** (docstring and `cases/wallet/certs/c_gm.json`):
```json
{"id": "c_gm", "component": "gm", "targets": {"oom": "never"},
 "version": "mandate-v2", "issuer": "wallet team (N. N.)", "date": "2026-10-01",
 "method": "exhaustive mandate-scope test …", "scope": ["pay"],
 "context": {"agent": "gpt-x-2026-05", "wallet": "wallet-3.2"}, "evidence": "ci://…"}
```
- Either `targets` (guard target keys) or `rows` (`{row id or short key: activation}`) states the rows, or both.
- Activations may be `never/sometimes/always`, `n/s/a` or `N/S/A`.
- A file may contain one record, a list, or `{certificates: [...]}` (`load`).
- What reads which field:
  - `classify` reads `id`, `component`, `targets`, `rows` and `version`.
  - `reverify` reads `context`.
  - `scope` is read only by `coordinator.Engine.applies`: a certificate counts for a cone only if its scope covers every use case in which the cell can carry a message, or none of its rows can fire in the uncovered ones.
  - `markdown.report` prints `id`, `component`, `version`, `method`, `issuer` and `date`.
  - `evidence` is carried along but never read.

**`resolve_rows(cert, m)`**:
- `targets[k]` becomes `leak.<component>.<k>`.
- A `rows` key is kept if it is a model row id. Otherwise it is replaced by the last existing candidate among `<comp>.<k>`, `leak.<comp>.<k>` and `default.<comp>.<k>`; if none exists, the raw key is kept and later rejected as an unknown row.
- Values are mapped through `WORD`.
- Example: `c_gm` resolves to `{"leak.gm.oom": "N"}`.

**`classify(cert, m, withdrawn=())`**: the first matching rule wins.
1. `id` is in `withdrawn` → **withdrawn**, "withdrawn by a recorded decision". The set comes from `Engine.register`: decisions with `kind: withdraw-cert`.
2. The component is not in `m.components` → **rejected**, "unknown component".
3. No rows were resolved → **rejected**, "states no row".
4. For each resolved row:
   - not in `m.rows` → **rejected**, "unknown row r"
   - `row.comp` differs from the component → **rejected**, "row r belongs to X, not Y"
   - activation not N/S/A → **rejected**, "unknown activation"
   - `N` on a `row.llm` row → **rejected**, "never on a learned guard / an LLM row (r): the LLM rule forbids it". Example: `vendor-eval.json` on `p_offmandate`.
   - `N` on a `leak` row that is not `decidable` → **rejected**, "never on a target that is not decidable from the edge".
5. The component has a non-null version and the certificate's `version` is neither `None` nor equal to it → **stale**, "`<comp>` is now X, the certificate covers Y". Example: `c_gm_v3` against the base model, where gm is `mandate-v2`.
6. Otherwise → **in force**.

**`reverify(cert, m)`** returns `[{component, signed_with, now}]` for `context` entries whose component's current version differs. It does not change the state. `Engine.analyse` reports it under `report.reverify`, only for certificates in force. `Engine.register` stores it per certificate along with `resolved`; `analyse` later adds `suspended`.

---

## 5. Bootstrap

Pipeline (CLI `bootstrap`, API `POST /api/bootstrap`):
`read_spans(traces text)` → `skeleton_from_traces` → [`mcp_import.read_tools_list` → `skeleton_from_mcp`] → `questionnaire` → [`apply_answers` → (API only) `model.load.validate`].

**`read_spans`**: one JSON span per line. Fields read: `trace_id`, `span_id`, `parent_span_id`, `start` (sorted as a string) and `attributes`.

**`skeleton_from_traces(spans, use_case_attr="app.use_case")`**, per trace:
- **Root and use case**: the root is the first span with no `parent_span_id`, else the trace's first span. The agent is `root.gen_ai.agent.name` (default `agent`). The use case is the root's `use_case_attr` value (default `default`); `ucs[uc]` is incremented.
- **Components**, taken from spans in start order; the first occurrence of each id wins (`setdefault`):
  - `gen_ai.operation.name == chat` → the agent, `{kind: llm, version: gen_ai.request.model, source: "traces: chat spans"}`
  - `execute_tool` → `gen_ai.tool.name` with `-` and `.` replaced by `_`, `{kind: tool}`
  - otherwise `epa.component` → `{kind: epa.kind or "deterministic", version: service.version}`
  - other spans, e.g. the `invoke_agent` root, are not components
- **Edges**:
  - A component span whose parent span is another component gives `parent → child`, counted.
  - A component span with no component parent is appended to the trace's top-level sequence `top`, without consecutive duplicates.
  - The chain `sys.<uc>_in → top[0] → top[1] …` adds edges.
  - `entry_of` is computed but never used.
- **Returns** `{components: {id: {...}}, edges: [{from, to, seen: k, source: "traces: seen in k of n"}], use_cases: [{id, entry: "<uc>_in", source: "traces: k of n root spans"}], traces: n}`.
- For `cases/mcp-coding-agent/intake/traces.jsonl` (2 traces) the result is:
  - components: planner (llm, coder-llm-2026-07), runner, toolpin, allowlist, github_mcp, shell
  - edges: `sys.issue_in→planner`, `planner→runner`, `runner→toolpin`, `toolpin→github_mcp` (seen 3, i.e. "seen in 3 of 2"), `runner→allowlist`, `allowlist→shell`

**`skeleton_from_mcp(tools, skel, server, server_trust)`**: this is what the MCP tools list adds.
- **Choosing the server**: if `server` is not a traced component, the first component whose name contains `mcp` (case-insensitive) is taken. In the example that is `github_mcp`.
- **If the server component exists**, it gets:
  - `tools: [{name, hash: tool_hash, hints: annotation keys whose value is True}]`
  - `version`: existing, else `"tools:" + hash over the list of tool hashes` (example: `tools:7393b32af8f0`)
  - `source` += " + mcp tools/list"
  - `trusted = server_trust`
- **Otherwise**, every tool component from `tools_to_patch` is merged in, each with `schema_fields`, `version` (existing, else `<server>:<hash>`), `trusted` and `source`.
- **In both cases** `skel.suggestions = tools_to_patch(...).suggestions`:
  - destructive or open-world tools → "observation point on the call edge"
  - read-only tools → "result edge carries the server's data"
- The edges from `tools_to_patch` are ignored.

**`questionnaire(skel)`** returns `{key, ask}` items in this order:
1. `modes`
2. `data_flow_confirmed`
3. for each `kind: tool` component that appears in an edge: `guards.<id>` (is it a guard: targets, decidable, version) and `outside` (is it a sink outside the system)
4. `observation_points`
5. `use_case_tokens`

**`apply_answers(skel, ans, name)`**:
1. Raises `ValueError` unless `ans.data_flow_confirmed` is truthy.
2. Guards: for each `ans.guards[g]`, requires exactly one edge into `g` and one out of it (else `ValueError`). Replaces them with a merged edge `from: in.from, to: out.to, source: "<in source>; guard g placed on it (answers)"` and removes component `g`. The guard entry is `{id (spec.id or g), label, version, targets (required), learned, closed_output, source: "g: traces + answers"}`.
3. Removes the `outside` components.
4. Edges: each becomes `{id: e_<a>_<b>, from: ref(from, "out"), to: ref(to, "in"), source}`. Here `a` and `b` are the last dotted part of each endpoint, after `rename`, with `_` appended until the id is unique. Each guard gets `edge` = its merged edge's id.
5. Observation points: each `{id, into, label?, log?, tolerate?, taint?, clearance?, requires?}` is attached to the first document edge whose `to == ref(into, "in")`.
6. Components: `{id (renamed), kind, label, version, in: ["in"], out: ["out"], …ans.components[cid] extras (e.g. authority, rows), source}`. MCP-derived `tools`, `schema_fields` and `trusted` are not copied.
7. Use cases: `{id, entries: [{port: "<uc>_in", token: ans.use_case_tokens[uc] or {}}], source}`.
8. Returns `{name, status: "draft (accept after review)", modes, components, guards, edges, use_cases, observation_points}`, plus `lattices` if given.

**Answers file format** (`cases/mcp-coding-agent/intake/answers.yaml`):
```yaml
modes: [omission, {commission: [drift]}, value]
lattices: {confidentiality: [public, private], authority: [none, contributor, maintainer]}
data_flow_confirmed: true
guards:                       # keyed by the traced component that is a guard
  toolpin: {id: gt, label: tool list, version: toolpin-v1, targets: [{mode: drift, threshold: 1, decidable: true}]}
  allowlist: {id: ga, label: allowlist, version: allowlist-v2, closed_output: true, targets: [{taint: true, decidable: true}]}
outside: [github_mcp, shell]  # sinks, become sys.<name>
components:                   # extra keys per (original) component id; kind/label override
  planner: {authority: maintainer}
  runner: {authority: maintainer, rows: [...]}
use_case_tokens: {issue: {taint: true, auth: none, conf: public}}
observation_points:
  - {id: o_mcp, into: github_mcp, label: MCP call log, tolerate: {drift: 1}, requires: maintainer}
  - {id: o_process, into: shell, label: process audit, taint: reject, requires: maintainer}
# also read, not in the example: rename: {old id: new id}; guards.<g>.learned
```
For this example the result has guard `gt` on `e_runner_github_mcp`, guard `ga` on `e_runner_shell`, and edges `e_issue_in_planner`, `e_planner_runner`, `e_runner_github_mcp` (to `sys.github_mcp`) and `e_runner_shell` (to `sys.shell`).

---

## 6. Reports

**`explain.trace_story(m, trace, fields)`**:
- **Input**: the result of `Engine.trace_of`, `{cell, uc, fire, steps: [{round, fired, labels: {edge: {u, n, k: token}}}]}`. The steps come from TLC's `states.dump`.
- **Output**: a list of `{step: "start" | "round N", edges: ["src → dst: <token text>"], fired: [...]}`, one per step in which an edge label changed. The first step lists only the edges in use.
- **Token text** (`_tok`): the non-zero magnitudes of the cone's `fields`, "tainted", the confidentiality level, "authority <level>" below the top, or "clean".

**`markdown.report(rep)`** produces:
1. `# Verdicts for <model name>`, then a line with the generation time (now), the TLC version (or `-`) and the clingo version.
2. One `## <obs label or id> (`obs`)` section per observation point. Each cell is a bullet:
   - `**field**: verdict {statuses}`
   - then "— R of S candidates remain", or "— more than N of S …"
   - then "— reason_line"
   - then ". _advice_."
   - then a sub-bullet "root causes: {rows}; …" unless the verdict is `guarantee`
3. `## Evidence register`:
   - each certificate: id, component, version, method, issuer, date, **state**, reason
   - each witness: id, source, recogniser, date, **state**, reason
4. `## Certify next` (if `ranking`): the first 10 actions as `a + b: key K — moves cells — note`.
5. `## Re-verify` (if `reverify`): `` `cert`: comp signed_with → now ``.
6. `## Absorbed failures (every other failure passes through)` (if `absorbed`): `modes at comp.port (kind): reason`.

**`markdown.cra_export(rep, product="", version="")`** returns a dict:
- `product`: the argument, or the model name
- `version`: the argument
- `generated`: an ISO timestamp, to the second
- `method`: "bimodal error propagation analysis (alethic: TLA+/TLC runs; epistemic: ASP over candidates)"
- `mapping`: risk assessment → CRA Art. 13(2)-(4); technical documentation → Art. 31, Annex VII; vulnerability handling → Annex I Part II; severe incident → Art. 14(4)
- `cells`: one `{observation_point, failure, assessment (NEUTRAL label), statuses, basis (reason_line), attestations (reasons.certificates), observation_records (witnesses_used)}` per cell
- `not_provided`: probabilities or rates; conformity with harmonised standards; behaviour outside the modelled use cases and edges; correctness of the mapping tables

---

## 7. CLI (`python -m epa …`, epa/cli.py)

| Subcommand | Arguments | Behaviour / output |
|---|---|---|
| `serve` | `--port` (int, 8765), `--host` (127.0.0.1) | Prints `EPA engine v2: open http://host:port` to stderr, then `uvicorn.run("epa.api.app:app", log_level="warning")`. |
| `check MODEL` | model path | Prints `<name>: N components, N edges, N rows`. Then one line per cell: id, number of cone rows, `candidate_space`, row ids. Then `absorbs: modes at comp.port (kind: reason)` for each `wellformed.absorbed` entry. |
| `run MODEL` | `--certs F…`, `--logs F…`, `--recognisers F…`, `--deployments F`, `--format text\|md\|json\|cra` (text), `--no-rank` | Loads the model and the certificates (`cert_import.load`), recognisers and manifest. Runs each log through `recognise_all(open(f).read(), f, recs, m, deps, os.path.dirname(f))`; no `files` dict is passed, so lookups are read from the log's directory. Runs `Engine.analyse({certificates, witnesses}, rank=not --no-rank)`, printing events to stderr, then `_print`. No decisions can be given. |
| `case CASE` | case dir or name under `cases/`, `--stage S`, `--format` | Runs the given stage, or every stage in `case.yaml` (or `[None]` if there are none). Each stage: `scenario.stage_inputs`, then a quiet `Engine.analyse(evidence)` (ranking on), then `_print`. In text format, prints the header `=== <title> - <sid>: <label>` first. |
| `tla MODEL CELL` | model, cell id (e.g. `oom@o_statement`) | Prints `to_tla.module_for(m, cone)[0]`, the TLA+ module of the cone containing the cell. |
| `bootstrap` | `--traces F` (required), `--tools F`, `--answers F`, `--server` (default `mcp`), `--name` (default `bootstrapped`) | Builds the skeleton and runs `skeleton_from_mcp` if `--tools` is given (server_trust is always False here). Without `--answers`, prints `- key: ask` for each question. With answers, prints the draft document via `yaml.safe_dump(sort_keys=False)`; it is not validated. |

**`_print` formats**:
- `json`: `json.dumps(rep, indent=1, default=str)`
- `md`: `markdown.report`
- `cra`: JSON of `cra_export`
- `text`: one line per cell (`cell`, `verdict`, `{statuses}`, `remaining/space` or `>at_least/space`, then `reason_line`), followed by `certify next:` with up to 8 lines (`action`, `key`, moved cells or note)

---

## 8. HTTP API (epa/api/app.py)

| Method | Path | Request body | Response | Calls |
|---|---|---|---|---|
| GET | `/api/health` | — | `{java, java_version, tla2tools, clingo, python, work}` | tlc_runner.java_ok, tlc_runner.find_jar |
| GET | `/api/cases` | — | `[{id, title, summary, figure, order}]` sorted by order | — |
| GET | `/api/cases/{case}` | — | `{id, meta, model_text, model, files}` | _case_dir, load.read_document |
| GET | `/api/cases/{case}/file?path=` | — | plain text of the file (404 outside the case dir) | _case_dir |
| GET | `/api/cases/{case}/figure` | — | the figure file (404 if none) | _case_dir |
| POST | `/api/model/parse` | `{text}` | `{doc, problems}`; 422 if unreadable | load.read_document, load.validate |
| POST | `/api/model/check` | `{doc}` | `{ok: false, problems}`, or `{ok: true, problems: [], summary, cells: [{cell, rows, fields, components, candidates, runs}], absorbed, decisions}` | load.validate, load.load_model, cone.cells, cone.cone_of_cell, reason.candidate_space, wellformed.absorbed |
| POST | `/api/model/yaml` | `{doc}` | YAML text | — |
| POST | `/api/evidence/logs` | `{doc, filename, text, recognisers: [YAML text], deployments?, lookups: {basename: text}}` | `{recognisers, witnesses (+state, reason), unmatched: [{recogniser, line}]}` (+`note` if nothing matched); 422 on model or recogniser-run errors | _model, log_import.load_recogniser, log_import.load_deployments, log_import.recognise_all, log_import.classify_witness |
| GET | `/api/cases/{case}/bundle` | — | `{id, meta, model_text, models, recognisers, deployments, lookups, logs, certificates, intake, stages}` (see note below) | _case_dir, scenario.load_case |
| GET | `/api/cases/{case}/stages/{stage}` | — | `{doc, evidence: {certificates, witnesses, decisions}, stage}`; witnesses are unclassified | _case_dir, scenario.stage_inputs |
| POST | `/api/evidence/certificates` | `{doc, text}` | `{certificates: [cert + state, reason, resolved, reverify]}` | _model, cert_import.load, cert_import.classify, cert_import.reverify |
| POST | `/api/evidence/witness` | `{doc, witness: spec, deployments?}` | `{witness (+state, reason)}`; 422 `{problems}` | _model, log_import.manual_witness, log_import.classify_witness |
| GET | `/api/workspace/meta` | — | `{exists, updated, by, name, case, stage, path}` | workspace.meta |
| GET | `/api/workspace` | — | `{doc, evidence, case, stage, updated, by}`; 404 if empty | workspace.load |
| PUT | `/api/workspace` | `{doc, evidence, case?, stage?}` | the new meta | workspace.save |
| POST | `/api/evidence/register` | `{doc, evidence}` | `{certificates, witnesses, decisions}` with states that take decisions into account | _model, coordinator.Engine.register |
| POST | `/api/bootstrap` | `{traces, tools?, answers?, name, server, server_trust}` | `{skeleton, questions}`, plus `doc` and `problems` when answers are given | bootstrap.read_spans, bootstrap.skeleton_from_traces, mcp_import.read_tools_list, bootstrap.skeleton_from_mcp, bootstrap.questionnaire, bootstrap.apply_answers, load.validate |
| POST | `/api/analyses` | `{doc, evidence, cells?, rank, label}` | `{id}` (returned at once; a background thread runs the analysis) | _model, Engine.analyse (in thread) |
| GET | `/api/analyses/{aid}/events` | — | `text/event-stream`: `data: <event>` lines, then `event: end` with `{status, error}` | — |
| GET | `/api/analyses/{aid}` | — | `{id, status, error, report, events}` | — |
| GET | `/api/analyses/{aid}/cells/{cell}/possibilities` | — | `Engine.possibilities` result: `{cell, rows, candidates: [{act, status, struck_by}], runs, space, suspended[, remaining_only]}` | _engine, Engine.possibilities |
| GET | `/api/analyses/{aid}/cells/{cell}/trace` | — | `{cell, run, story}`, or `{cell, story: [], note}` | _engine, Engine.trace_of, explain.trace_story |
| GET | `/api/analyses/{aid}/cells/{cell}/asp` | — | ASP program text | _engine, cone.cones, cone.cells, Engine.register, Engine.ensure, Engine.problem, Cell.parse |
| GET | `/api/tla/{h}` | — | `{module, cfg, library, stats}` from `WORK/tlc/<h>/` | — |
| GET | `/api/analyses/{aid}/report.md` | — | Markdown report | markdown.report |
| GET | `/api/analyses/{aid}/cra.json` | — | CRA export JSON | markdown.cra_export |
| GET | `/` | — | `web/index.html` | — |
| GET | `/web/*` | — | static UI files | StaticFiles |

**Bundle contents** (`GET /api/cases/{case}/bundle`):
- `recognisers`: `{relative path: text}` for the `meta.recognisers` globs.
- `lookups`: `{basename: text}` for the `meta.lookup_files` globs (default `data/*.csv`, `data/*.json`), excluding the deployments file.
- `deployments`: the manifest text.
- `certificates`: paths under `certs/`.
- `intake`: paths under `intake/`.
- `logs`: paths under `data/` that are neither lookups nor the manifest.
- `models`: `.yaml`/`.yml` paths starting with `model`.

**How the server keeps state**:
- **`WORK`**: `$EPA_WORK` or `<repo>/.epa-work`, created at import.
  - It holds `runs.sqlite` and the TLC directories `tlc/<hash>/` (`Cone.tla`, `Cone.cfg`, `EpaLib.tla`, `stats.txt`, `states.dump`).
  - `/api/tla/{h}` and `Engine.trace_of` read those directories.
- **`CACHE`**: one `engine.cache.RunCache` (SQLite with `check_same_thread=False`, its own `threading.Lock`, and an in-memory `mem` dict of runs per cone key).
  - Tables `runs(cone, uc, fire, fired, labels, rounds, variants)` and `coverage(cone, pins, tlc)`.
  - Shared by every `Engine` the API builds, so explored firing choices persist across analyses and restarts. Runs are keyed by the cone's behaviour hash, not by versions.
- **`ANALYSES`**: an in-memory dict `aid → {id, status: running|done|error, events, report, error, model (the Model object), evidence, label, started, engine}`. It is never pruned and is lost on restart; the UI then reports "the server no longer has this analysis".
- **Threads and `RUN_LOCK`**:
  - `POST /api/analyses` starts a daemon `threading.Thread` per analysis. The thread holds the global `RUN_LOCK` for the whole run, so analyses execute one at a time; a waiting one still shows `running`.
  - `possibilities`, `trace` (around `trace_of`) and `asp` (around `ensure`+`problem`) also take `RUN_LOCK`.
  - `register` and `model/check` do not take it.
  - Follow-up endpoints build a fresh `Engine(st.model, WORK, cache=CACHE)` through `_engine(aid)`. The stored `st["engine"]` is never read.
- **Server-Sent Events**:
  - The `Engine`'s `on_event` callback appends each event `{t, step, msg, …}` to `st.events`.
  - `/events` is a synchronous generator that polls the list every 0.1 s and sends each new event as `data: <json>\n\n`. When the status leaves `running` it sends `event: end\ndata: {status, error}`.
  - The UI (`web/analysis.js`) uses `EventSource`; on `end` it fetches `GET /api/analyses/{id}`.
- **Static UI and caching**:
  - `web/` is mounted at `/web` if it exists, and `/` serves `web/index.html`.
  - The `revalidate_ui` HTTP middleware adds `Cache-Control: no-cache` to `/` and `/web/*` responses, so the browser revalidates every UI file (a 304 if unchanged) and never mixes old and new files.

---

## 9. Workflow notes

### (a) Log file uploaded in the UI
1. `web/evidence.js` `EvidenceView.addLog(name, text)` gathers:
   - recogniser texts: `S.bundle.recognisers` merged with user-added ones
   - `deployments()`: the user's manifest, else the bundle's
   - `lookups()`: bundle plus user
2. The browser sends `POST /api/evidence/logs {doc, filename, text, recognisers, deployments, lookups}`.
3. `app.evidence_logs` calls `app._model` → `model.load.load_model(doc)` (422 on `ModelError`).
4. It calls `log_import.load_recogniser(text)` for each recogniser (YAML parse).
5. It calls `log_import.load_deployments(deployments)`.
6. It calls `log_import.recognise_all(text, filename, recs, m, deps, files=lookups)`. For each recogniser whose `files` glob matches the basename, `log_import.witnesses_from_text` runs:
   1. `_lookups` builds the lookup sets from `files` or disk.
   2. `records` reads records by format.
   3. `holds(match)` filters records; with `aggregate`, `_aggregate` groups them.
   4. For each record, the rules are tried in order with `holds(when)`. On the first match: `_resolve_levels(witness, m)`, then date, use case and key via `_get`, then `versions_at(deps, date)`, and the record is merged into the witness for its key.
   5. Records that fit no rule go to `unmatched`.
7. If no glob matched, `log_import.recognise_any` tries every recogniser and keeps the first that yields witnesses.
8. For each witness, `log_import.classify_witness(w, m)` runs: the observation point and use case are checked, then `model.cone.upstream` gives the version check, setting `state` and `reason`.
9. The response is `{recognisers, witnesses, unmatched}`.
10. The UI strips `state` and `reason`, replaces witnesses with the same id in `S.evidence.witnesses`, records the file entry, then calls `persist()` (localStorage) and `emit('evidence')`.
11. `EvidenceView.refresh` sends `POST /api/evidence/register {doc, evidence}`.
12. `app.evidence_register` builds `coordinator.Engine(m, WORK, cache=CACHE)` and calls `Engine.register`, which builds the `withdrawn`/`rejected` sets from decisions and calls `log_import.classify_witness(w, m, rejected)` and `cert_import.classify` / `reverify` for each item. The register is rendered.

### (b) Certificate uploaded
1. `EvidenceView.addCert(name, text)` runs; the hand-entry dialog in `web/evidencedialogs.js` sends `JSON.stringify(record)` the same way.
2. The browser sends `POST /api/evidence/certificates {doc, text}`.
3. `app.evidence_certs` calls `app._model` → `model.load.load_model`.
4. `cert_import.load(text)` parses JSON, falls back to YAML, and unwraps to a list.
5. For each certificate, `cert_import.classify(c, m)` runs: `cert_import.resolve_rows` (targets become `leak.<comp>.<k>`, rows are resolved), then the rejection rules, then the version check. No `withdrawn` set is passed.
6. `cert_import.reverify(c, m)` compares the context versions.
7. The response is `{certificates: [c + state, reason, resolved, reverify]}`.
8. The UI strips `state`, `reason`, `resolved` and `reverify`, merges by id into `S.evidence.certificates`, then calls `persist()` and `emit('evidence')`.
9. `POST /api/evidence/register` then runs as in (a) steps 11–12, this time with decisions applied, so a certificate can come back as `withdrawn`.

### (c) Bootstrap
1. `web/app.js` `bootstrapDialog`:
   - Optionally ("Use the … intake files") it fetches each bundle intake file with `GET /api/cases/{case}/file?path=…`.
   - It maps `traces*` to traces, `tools_list.json` to tools and `answers*` to answers.
2. The browser sends `POST /api/bootstrap {traces, tools, answers, server, name: "bootstrapped"}`.
3. `app.do_bootstrap` runs `bootstrap.read_spans(traces)`, then `bootstrap.skeleton_from_traces(spans)`.
4. If `tools` is given:
   1. If `server` is not a traced component, the API picks the component whose name contains "mcp".
   2. `mcp_import.read_tools_list(tools)` runs.
   3. `bootstrap.skeleton_from_mcp(tools, skel, server, server_trust)` calls `mcp_import.tools_to_patch`, which calls `mcp_import.tool_hash`. The server component gets `tools`, `version` and `trusted`, or tool components are added, and the suggestions are set.
5. `bootstrap.questionnaire(skel)` runs.
6. If answers are given: `yaml.safe_load(answers)`, then `bootstrap.apply_answers(skel, ans, name)` (guards merged, outside components removed, edges, observation points, components, use cases), then `model.load.validate(doc)`. Exceptions become `problems`.
7. The response is `{skeleton, questions, doc?, problems?}`. The UI shows the component and edge counts and the questions.
8. "Open the bootstrapped model" calls `setDoc(normaliseDoc(doc), emptyEvidence())` → `persist` → `emit('loaded'/'evidence'/'report')` → `runCheck()`, which sends `POST /api/model/check`.

### (d) Case stage opened
1. Precondition: `openCase(id)` sends `GET /api/cases/{case}/bundle` → `app.case_bundle` → `scenario.load_case`. The response holds recognisers, lookups, manifest, file lists and stages.
2. `openStage(stage)` sends `GET /api/cases/{case}/stages/{stage}`.
3. `app.case_stage` runs `app._case_dir`, then `engine.scenario.stage_inputs(dir, stage)`, which:
   1. calls `scenario.load_case` (case.yaml)
   2. calls `log_import.load_deployments(meta.deployments)`
   3. calls `scenario.recognisers`, which runs `log_import.load_recogniser` for each glob match
   4. calls `scenario.lookup_files` (`{basename: text}`)
   5. processes each stage in order, up to and including the requested one:
      - resets the evidence if `carry: false`
      - switches `model` if the stage names one
      - accumulates `versions`
      - calls `model.load.load_model(scenario.apply_versions(read_document(model), versions))`
      - calls `cert_import.load` for each certificate file
      - calls `log_import.recognise_all(text, path, recs, m, deps, case_dir, files)` for each log (the same chain as (a) step 6)
      - accumulates `decisions`
   6. finally, `apply_versions(read_document(model_path), versions)` gives the doc.
4. The response is `{doc, evidence: {certificates, witnesses, decisions}, stage}`.
5. The UI keeps the old system layout if the new doc has none, then calls `setDoc(normaliseDoc(doc), evidence)` → `persist` → emit → `runCheck()`, which sends `POST /api/model/check`, which emits `check`.
6. `EvidenceView.refresh` sends `POST /api/evidence/register`, which runs `Engine.register` and classifies everything against the stage's model and decisions (e.g. S3's `withdraw-cert c_gm`).

---

## 10. Observations

**Dead code**, confirmed by a repository-wide grep over `*.py` and `*.js`:
- `mcp_import.diff_tools` is never called, including in tests.
- The `edges` that `mcp_import.tools_to_patch` returns are never used: its only caller, `bootstrap.skeleton_from_mcp`, reads only `components` (and those only in the no-server branch) and `suggestions`. Its parameters `agent`, `agent_port_call` and `agent_port_result` are never passed.
- In `bootstrap.skeleton_from_traces`, `entry_of` is computed but never read.
- In `api/app.py`:
  - `normalise` is imported and never used.
  - `st["engine"]` is set but never read; `_engine(aid)` builds a new `Engine` each time.
- `epa.__version__` is never read. The FastAPI app declares `version="2.0"` instead.

**Docstrings that promise more than the code does**:
- The `mcp_import` docstring says `read_tools_list` can read a live server's response through the MCP SDK and a launch command. It only accepts JSON text, a file path or parsed data.
- The `manual_witness` docstring mentions agents entering witnesses "through the MCP server". There is no MCP server in the repository; a grep for FastMCP or `mcp.server` finds nothing.

**Surprising behaviour in the intake code**:
- **Date handling in `witnesses_from_text`**: a record without the date field gets `date = "None"` (from `str(None)`). `versions_at` then applies every manifest change, future ones included, because `"2027-…" <= "None"` compares as strings.
- **Condition operators**: `holds` compares `eq`/`ne` as `str()`. YAML `eq: true` becomes `"True"`, which matches JSON `true` but not a CSV cell `true`. Only the first operator key present, in the fixed order, is evaluated; extra keys in the same condition are ignored silently. An `in`/`not_in` naming a lookup that is not defined fails with `TypeError` (testing membership in `None`).
- **What `unmatched` leaves out**: records that fail `match`, and lines that do not fit a `regex` pattern, are dropped without being reported; `unmatched` covers only records that no rule fits.
- **Lookup files ignore the delimiter**: `_lookups` reads CSV lookup files with a comma, whatever the recogniser's `delimiter`.
- **The fallback ignores globs**: `recognise_any`'s second loop tries every recogniser regardless of its globs, so a file can be recognised by a recogniser meant for other files. Its first loop does nothing when it is called from `recognise_all`, because `recognise_all` only calls it after no glob matched.
- **Recogniser witnesses are not checked against the model's fields**: an unknown failure mode passes `classify_witness`. An unknown `conf`/`auth` level name raises `ValueError` in `_resolve_levels`.
- **One-line strings are treated as file paths** by `load_recogniser`, `load_deployments` and `cert_import.load`. In the API this means:
  - a recogniser string without a newline is opened as a path on the server
  - lookups not supplied in the `lookups` body are read relative to the server's working directory (`base_dir="."`)
- **Missing certificate path**: `cert_import.load` on a path that does not exist returns `[<the path string>]` (YAML parses it as a string). `classify` then fails with `AttributeError`.
- **`resolve_rows` has no `break`**: if several candidate row ids exist, the last one wins, in the order `default.*` over `leak.*` over `<comp>.*`.
- **Short magnitude lists**: in `manual_witness`, a one-element magnitude list such as `[3]` raises an uncaught `IndexError` (an HTTP 500), not a `WitnessError`.
- **Classification at upload time ignores decisions**: `/api/evidence/logs` and `/api/evidence/certificates` classify without the `withdrawn`/`rejected` sets. The UI throws those states away (`strip`) and relies on `/api/evidence/register`.

**Surprising behaviour in bootstrap**:
- **Edge counts**: "seen in k of n" counts edge occurrences, not traces. The example gives "seen in 3 of 2" for `toolpin→github_mcp`. The merged guard edge keeps only the in-edge's source text.
- **Hints differ between the two MCP paths**: `tools_to_patch` suggestions list every truthy annotation key, so `title` appears (e.g. `["openWorldHint", "title"]`). The `hints` in `skeleton_from_mcp` keep only keys whose value is `True`.
- **Questionnaire gaps**: it asks `guards.X` and `outside` for every traced tool component, so the `outside` key appears four times in the example. It never asks about `lattices`, `components` or `rename`, which `apply_answers` reads.
- **MCP information is lost**: `apply_answers` drops `tools`, `schema_fields`, `trusted` and the suggestions; only `version` reaches the document. In the example `github_mcp` is listed as `outside`, so the tools list does not affect the draft document at all.
- **Empty error message**: an observation point whose `into` matches no edge raises `StopIteration`; the API reports that as `problems: [""]`.
- **Duplicated logic**: `do_bootstrap` repeats `skeleton_from_mcp`'s server-resolution logic.
- **CLI gaps**: the CLI `bootstrap` has no server-trust option and does not validate the draft.

**Surprising behaviour in the CLI and API**:
- **Lookups in `epa run`**: they are read from each log file's directory. For the wallet statements in `data/statements/`, `mandate.csv` (which is in `data/`) would not be found. `epa case` does not have this problem, because it passes `lookup_files`.
- **JSON output of `epa case`**: `--format json` or `cra` without `--stage` prints one JSON document per stage, one after another, not a single JSON value.
- **Unknown stage id**: `GET /api/cases/{case}/stages/{bad}` returns 200 with `stage: null` and the evidence of every stage accumulated.
- **Bundle and scenario disagree on the manifest**: `case_bundle` leaves the deployments file out of `lookups`, but `scenario.lookup_files` includes it.
- **`cra_export` parameters are never passed**: no caller passes `product` or `version`, so `version` is always `""`.
- **Analyses are only in memory**: `ANALYSES` is never pruned. All engine work is serialised by one global lock, so a second analysis waits while showing `running`.
- **Busy polling**: the SSE generator sleeps 0.1 s between checks inside a threadpool worker for the lifetime of each stream.
