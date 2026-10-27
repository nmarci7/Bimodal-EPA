# The browser workbench (web/)

Part of the [developer guide](../developer-guide.md). Plain ES modules, no build step, served by the
API at `/web/*`. `web/package.json` only tells node that the files are modules (for `web/tests/`).
Line numbers are left out on purpose: `python tools/inventory.py` prints the current ones.

### The browser state and its events

Everything the workbench holds lives in one object, `S` in `web/state.js`:

| field | holds |
|---|---|
| `S.doc` | the model document, exactly the YAML/JSON structure of [model-format.md](../model-format.md), plus `layout.sys` (canvas positions of system ports) and `pos` per component |
| `S.check` | the last answer of `POST /api/model/check`: `{ok, problems, summary, cells, absorbed, decisions}` |
| `S.evidence` | `{files, witnesses, certificates, decisions, recognisers, deployments, lookups}`: what the analyst loaded or wrote |
| `S.analysis` | `{id, status, report, error}` of the last analysis |
| `S.caseId`, `S.bundle`, `S.stage` | the open demo case, its bundle (`GET /api/cases/{case}/bundle`) and the scenario stage |
| `S.selection` | what is selected: `{type: component \| port \| sys \| edge \| guard \| obs, id}` (a port's id is `comp\|side\|name`, a system port's `sys:name`) |
| `S.view` | the visible view: model, evidence, analysis or verdicts |

`S.doc`, `S.evidence` and the case/stage are saved to `localStorage` on every change (`persist`) and
restored on load (`restore`). Views never call each other: they talk through a tiny event bus
(`on(name, fn)` / `emit(name, data)`):

| event | emitted when | listened to by |
|---|---|---|
| `doc` | the model changed (`changed`, `commitDoc`) | canvas, inspector, rows table, outline, model view (name, YAML) |
| `select` | the selection changed | canvas, inspector, rows table, outline |
| `check` | a model check came back (`runCheck`) | model view (badge, footer), inspector, rows table, outline, evidence view |
| `loaded` | a whole new model was set (`setDoc` in app.js) | every view |
| `evidence` | the evidence changed | evidence view |
| `report` | an analysis finished | canvas (verdict colours), verdicts view, app (the dot on the Verdicts tab) |
| `show`, `shown:<view>` | a view is asked for / was shown | app / the view itself |
| `run` | "run the analysis" from anywhere | app → `AnalysisView.run` |
| `maptable:show`, `maptable:toggled` | the rows table is asked for / was toggled | rows table |
| `reveal` | the outline asks to bring a selection into view | model view → `Canvas.reveal` |
| `focus-cell` | a cell should be shown in the verdicts view | verdicts view |

### How an edit reaches the model

There are two ways a change gets into `S.doc`:

* **Direct edits** from the canvas (dragging a node, wiring two ports, dropping a component, Delete):
  the functions in `state.js` (`addComponent`, `connectPorts`, `removeSelection`, …) change `S.doc` in
  place and call `changed(selection)`, which persists, emits `doc` and `select`, and schedules a model
  check 350 ms later (`runCheck`).
* **Dialogs** (everything opened by *Edit…*, *Add row…*, a drop of a guard or an observation point):
  the dialog takes a deep copy of the model (`cloneDoc`), edits the copy (with the doc-parameter
  functions in `ops`), and on Save calls `saveChecked(copy, selection, force)`. That runs the server's
  model check on the copy (`newProblems`): if the copy has problems the current model does not have,
  the dialog shows them and offers *Save anyway* (`force`); otherwise `commitDoc` replaces `S.doc` with
  the copy and emits as above. Cancel throws the copy away, so the model is untouched.

### Files

#### `web/index.html`
The page: the top bar (case picker, the four tabs, the `#actions` slot that app.js fills with the
File menu and Help, Run analysis), the scenario bar, one `<section>` per view, the legacy `#modal`
container and the toast. It loads `style.css` and the module `app.js`.

#### `web/app.js` (entry point)
Wires the four views, the demo cases and their stages, the File menu and Help.

| function | what it does |
|---|---|
| `show(view)` | switches the visible view and tab; clears the "new verdicts" dot; emits `shown:<view>` |
| `loadCases()` | `GET /api/cases`, fills the case picker, opens a case when one is picked |
| `openCase(id, stage)` | `GET /api/cases/{id}/bundle` into `S.bundle`; opens the first (or given) stage, else the bare model |
| `openStage(stage)` | `GET /api/cases/{id}/stages/{stage}`: sets the stage's model and evidence (keeping the system-port layout) and redraws the scenario bar |
| `setDoc(doc, evidence)` | replaces the model (and the evidence): resets analysis, selection and check, persists, emits `loaded`, `evidence`, `report`, and runs a check |
| `drawStagebar()` | the scenario bar: one chip per stage, the current stage's note, what it adds, *Run this stage* |
| `newModel()` | asks, then starts a blank model (`blankDoc`) and forgets the case |
| `importFile(file)` | reads a file, `POST /api/model/parse`, sets it as the model, reports how many problems it has |
| `exportYaml()` | `POST /api/model/yaml` and downloads `<name>.yaml` |
| `bootstrapDialog()` | the *Bootstrap from traces* window: three drop zones (traces, tools list, answers), `POST /api/bootstrap`, shows the skeleton and the questions, and opens the drafted model |
| `openWorkspace()` | File → Open the shared workspace: `GET /api/workspace`, sets the model and the evidence an assistant left there (see [mcp.md](mcp.md)) |
| `saveWorkspace()` | File → Save to the shared workspace…: asks before replacing what is there, then `PUT /api/workspace` with the model, the evidence and the case's recognisers, manifest and lookup files |
| `watchWorkspace()` | on load and whenever the window gets the focus: `GET /api/workspace/meta`, and a message if the assistant (`by: mcp`) changed the workspace since it was last seen (`localStorage` key `epa.wsSeen`) |
| `helpDialog()` | the Help window: the four steps and the shortcuts |
| `main()` | builds the views, binds the tabs, the File menu, Help and Run; restores the saved state or opens a case (`?case=`, `?stage=`, `?view=`, `?run=` in the URL are honoured) |

#### `web/state.js`
The state `S`, the event bus, the model helpers, every direct edit, and the check-then-save step of
the dialogs.

| function | what it does |
|---|---|
| `on(ev, fn)`, `emit(ev, data)` | the event bus |
| `emptyEvidence()`, `blankDoc()` | an empty evidence register; a new model (four modes, default levels) |
| `normaliseDoc(doc)` | fills missing lists and levels, turns old `guard.on` into `edge`, converts the old `pass:` key of components into `absorbs`, and lays out anything without a position |
| `modeFields(doc)`, `topModes(doc)` | the failure modes as `{name, parent}` (sub-kinds have a parent); only the top-level ones |
| `parseRef(ref)`, `nodeIdOfRef(ref)` | `"comp.port"` → `[comp, port]`; the canvas node of a port reference (`sys:name` for a system port) |
| `sysPorts(doc)` | the system inputs and outputs, from the edges and the layout |
| `comp(doc, id)`, `edge(doc, id)` | look up a component or an edge |
| `uniqueId(base, taken)`, `allIds(doc)`, `uniquePort(list, base)` | a fresh identifier; the ids of components and guards; a fresh port name |
| `addComponent(kind, x, y)`, `addSysPort(dir, x, y)` | a new component or system port at a canvas position |
| `connectPorts(from, to)`, `connect(a, b)` | wire two ends (making new ports where none was given), refusing self-loops, sys-to-sys and duplicates; the first wire out of a system input creates the first use case |
| `addPort`, `removePort`, `moveEdgeEnd`, `renameComponent`, `renamePort` | direct edits on `S.doc` (each calls the matching `ops` function, then `changed`) |
| `portEdges(d, cid, side, name)` | the edges at one port |
| `targetText(t)`, `guardSummary(d, g)`, `obsSummary(d, o)` | short texts for a guard target, a guard pill and an eye on the canvas |
| `useCasesAt(d, port)` | the use cases that enter at a system input |
| `addGuard(edgeId)`, `addObs(edgeId)` | add a guard or an observation point directly (kept for scripts; the canvas now opens the dialogs instead) |
| `removeSelection()`, `dropEdges(ids)` | delete the selection with its edges, and the guards and points on them |
| `ops.*` | the same edits on any document `d` without events, for the dialogs: `addPort`, `removePort` (also drops rows, absorptions and dropped defaults that name the port), `moveEdgeEnd`, `dropEdges`, `renameComponent`, `renamePort` (follows edges, flow, rows, absorptions, dropped defaults), `renameGuard`, `renameObs` (follows claims), `renameSysPort` (follows edges and use cases) |
| `cloneDoc(d)`, `commitDoc(doc, sel)` | a deep copy for a dialog; put an edited copy in place and tell every view |
| `checkDoc(doc)`, `newProblems(doc)`, `saveChecked(doc, sel, force)` | `POST /api/model/check`; the problems the copy has that the current model does not; the Save step of every dialog |
| `changed(sel)`, `runCheck()` | after a direct edit: persist, emit, and check the model (debounced); the check itself |
| `persist()`, `restore()` | `localStorage` keys `epa.doc`, `epa.evidence`, `epa.case` |
| `autoLayout(d)` | places components and system ports that have no position: beside the component they are wired to, or in layers by longest path from the inputs |

#### `web/lib.js`
Small helpers with no state.

| function | what it does |
|---|---|
| `h(tag, attrs, ...kids)`, `s(...)` | build an HTML (or SVG) element; `on*` attributes become listeners; null, undefined and false children are skipped |
| `clear(el)`, `add(el, ...kids)` | empty an element; append children skipping null (plain `append` would write "null") |
| `api(path, body, method)` | `fetch` with JSON; throws an `Error` carrying the server's `problems` on a non-2xx answer |
| `readFile(file)`, `download(name, text, type)` | read a dropped file as text; save text as a file |
| `toast(msg, ms)` | the message at the bottom of the screen |
| `modal(content)` | the older single-window modal (still used for figures, the YAML of a recogniser, the generated TLA+) |
| `dropZone(label, sub, onFiles, accept)` | a click-or-drop file area |
| `store(key, value)` | `localStorage` get/set as JSON, failing quietly |
| `verdictClass(v)`, `fmtCell(id)` | the CSS class of a verdict; `"field@obs"` → `{field, obs}` |

#### `web/dialog.js`
Dialogs, wizards, confirmations, menus and form controls. Dialogs stack; Escape and × close the top
one, and a dialog with `isDirty` asks before throwing edits away. Focus stays inside the top dialog.

| function | what it does |
|---|---|
| `isDialogOpen()` | whether any dialog is open (the canvas ignores its keys then) |
| `button(label, onClick, opts)` | a button (`primary`, `danger`, `small`, `ghost`, `disabled`, `title`) |
| `openDialog({title, subtitle, size, body, actions, onClose, isDirty})` | opens a window; returns `{setBody, setActions, setMessage, setTitle, close, requestClose}` |
| `confirmDialog(message, opts)` | a yes/no window; resolves `true` for OK; Cancel has the focus |
| `infoDialog(title, content, opts)` | a window to read, with Close |
| `wizard({title, mode, steps, preview, onSave, …})` | a window with steps: *add* mode walks with Back/Next and saves on the last step; *edit* mode shows the steps as tabs with Save always there. Each step may report `problems(ctx)`; Next and Save wait until there are none; the rail shows how many each step has. `onSave` may return `{problems, canForce}` to show the server's objections with *Save anyway* |
| `field`, `textInput`, `numberInput`, `selectInput`, `checkInput`, `choiceCards` | labelled form controls; `choiceCards` are big radio cards with a reason when an option is disabled |
| `dropdown(label, items)` | a button with a menu (items may be checkable; `'sep'` is a separator) |

#### `web/rows.js` (pure; tested by `web/tests/rows.test.js`)
Rows as plain data. No DOM, so node can test it against every row of the shipped models.

| function | what it does |
|---|---|
| `KINDS`, `OPS`, `ACTIVATIONS`, `ID_RE` | the four row kinds with their explanations; the four emit operators; the activations; the id pattern |
| `isAsIs(em)`, `parseOp(op)`, `formatOp({op,k})`, `clamp` | "as it is" in any spelling; `"const 9"`/`9`/`"keep"`/`"+2"`/`"max"` ↔ `{op, k}` (as `_parse_op` in load.py) |
| `rowKind(row)` | failure, internal (no `when`), forwarding (only `any` and `as it is`) or sink (no `then`), as load.py reads it |
| `toDraft(row)`, `fromDraft(draft, original)` | the row ↔ the dialog's editable form (lists of conditions and emissions); fields the dialog does not edit are kept; the activation is written only when it differs from the kind's default |
| `defaultActivation(kind)` | `always` for forwarding, `open` otherwise |
| `setKind(draft, kind, comp, fields)` | reshape a draft for another kind, keeping what still fits |
| `draftProblemsByStep(draft, ctx)`, `draftProblems(draft, ctx)` | what stands in the way of saving, by wizard step (kind, trigger, effect, name): the rules of `validate` in load.py plus the LLM rule and the operators that need a matched magnitude |
| `activationChoices(draft, comp)`, `activationText(act, llmRow, kind)` | the activations the dialog offers (never disabled for an LLM row that emits a failure); what each means |
| `rowSentence(row, comp)` (with `condText`, `emitText`, `list`) | what a row does, in one sentence |
| `rowYaml(row)` | the row in YAML flow style, for the dialog's preview |
| `freshRowId(cid, taken, base)`, `allRowIds(doc)` | a new row id; every analyst row id of the model |
| `llmDefaultStatus(c, q, m)` | whether the default "m at 10 on q" of an LLM stands, is refined (and by which rows) or dropped |

#### `web/rowdialog.js`
| function | what it does |
|---|---|
| `openRowDialog(cid, rowId, opts)` | the row wizard (add, or edit with tabs): Kind, When, Then, Name and activation, with the sentence and the YAML under every step; `opts.preset` (refining an LLM default), `opts.from` (copy a row), `opts.startAt`. Save: a copy of the model with the row in place, the server check (and a warning if a certificate names a renamed row), `commitDoc` |
| `deleteRow(cid, rowId)` | asks (naming certificates that state the row), then deletes |
| `certsNaming(rowId)` | the certificates in the register that name a row by id |

#### `web/modeldialogs.js`
One editing window per kind of model element. Each edits a copy and saves with `saveChecked`.

| function | what it does |
|---|---|
| `openComponentDialog(cid, {startAt})` | tabs Properties, Ports, Normal flow, What it absorbs (non-LLM), LLM defaults (LLM); renames the component last |
| `openAbsorbDialog(cid, port)` | which modes stop at one input, and why |
| `openDropDefaultDialog(cid, port, mode)` | drop one LLM default with a reason, or refine it with a row instead |
| `refinePreset(cid, port, mode)` | the row draft that refines a default: same trigger, same failure, magnitude 10 |
| `openGuardDialog(gid, {edge})` | a new guard on an edge (from a drop or *Add guard…*) or an existing one: name, id, version, edge, learned, closed output, order on the edge; then its targets, with what catching each does |
| `catchSentence(t)` | what catching a target does (Definition: Guardrail) |
| `openObsDialog(oid, {edge})` | a new or existing observation point: name, id, edge (one point per edge), log; the failures it judges and from which magnitude; provenance (taint, confidentiality, authority) |
| `openEdgeDialog(eid)`, `openSysDialog(name)` | an edge's label and its ports; a system port's name |
| `openUseCaseDialog(ucId, {port})`, `deleteUseCase(ucId)` | a use case: id, label, and each entry's input and token (taint, confidentiality, authority, failures it already carries) |
| `openClaimDialog(index)`, `deleteClaim(index)` | a claim: the cell, the claimed verdict, who claims it |
| `openModelDialog({startAt})` | name and description; failure modes with sub-kinds; confidentiality and authority levels |
| `idsIn(doc)`, `idProblem(v, taken)` | ids in use; what is wrong with a proposed id |

#### `web/modelview.js`, `web/canvas.js`, `web/maptable.js`, `web/inspector.js`, `web/outline.js` (view 1)

| definition | what it does |
|---|---|
| `ModelView` | lays out view 1: the left pane (Add / Outline tabs, remembered in `localStorage`), the canvas bar (badge, model name, Case figure, Fit, the View menu), the canvas, the rows table, the YAML pane, the footer, and the inspector. `status()` draws the badge and the footer from `S.check`; `leftTab`, `refreshYaml`, `toggleYaml`, `figure`; `eyeIcon()` draws the palette's eye |
| `Canvas` | the SVG canvas. `nodes()` and `ports(byId)` compute geometry (`endPoint` finds where an edge meets a system port; `toWorld` turns mouse coordinates into canvas ones; `applyT` applies the pan and zoom) (each port sits on the border facing what it is wired to, pairs ordered so their edges do not cross); `render()` draws edges (`edgeShape`, with their guard pills and eyes), nodes (`nodeShape`) and ports (`portShape`) (coloured by the worst verdict after an analysis, `verdictsByObs`); `bind()` handles pan, zoom, moving nodes, wiring from ports and from the + handle, drops from the palette (a guard or point opens its dialog), double-click and Enter (`edit`), Delete (asks first); `reveal(sel)` scrolls a selection into view; `fit()`; `nearestEdge(w)` (the edge a guard or eye is dropped on); `select()`; `flash(msg)` (a toast); helpers `nodeHeight`, `clip`, `segDist` |
| `MapTable` | the rows table under the canvas for the selected component, port or guard: the normal flow, the analyst's rows as sentences with Edit / Copy / Delete (rows touching a selected port are marked), and folded *Rows the engine adds* (pass-through with Absorb…, LLM defaults with Refine… / Drop… / Restore, absorptions with Edit…); for a guard its catch, leak and false-positive rows. `target()` finds what the selection's table is; `head` and `table` build the header and a table; `generated` the folded rows. Helpers `actShort` (the activation column) and `restoreDefault` |
| `Inspector` | the right pane: a summary of the selection (`renderModel`, `renderComponent`, `renderPort`, `renderSys`, `renderEdge`, `renderGuard`, `renderObs`) with *Edit…*, the problems of the model and an observation point's cells (`renderGenerated`), and *Delete …* at the bottom (`remove` asks first). Helpers: `head` (title, kind, Edit…), `section`, `kv` (a definition list), `select`, `useCases` and `ucItem` (the use-case list), `claims`. `judgesText(o)` says what a point judges |
| `Outline`, `allRowsDialog()` | the outline lists (`renderList`; `group` and `item` build them; `match` filters; click selects and reveals, double-click edits) and the All rows window |

#### `web/evidence.js` and `web/evidencedialogs.js` (view 2)

| definition | what it does |
|---|---|
| `fmtAt(at, doc)` | a witness's `at` part in words ("o_statement: oom 1–10, tainted") |
| `EvidenceView` | the register: `refresh()` asks `POST /api/evidence/register` for the state of everything; `render()` draws the summary and three panels (`logsPanel` with `fileCard` per log, `certsPanel`, `contextPanel` for recognisers, the manifest and the decisions). Intake: `addFiles` sorts dropped files, `addLog` (`POST /api/evidence/logs`), `addCert` (`POST /api/evidence/certificates`), `fromCase` loads a case file (`available` lists the case's files), `removeFile`; `recogniserTexts`, `deployments`, `lookups` merge the case's and the analyst's; `withdraw`, `rejectWitness` open the dialogs; `strip` drops the server's classification before storing |
| `openCertDialog(certId)` | the certificate wizard: what it certifies (guards and components with open rows, from `S.check.summary.rows`), what it establishes (never disabled where the LLM rule or decidability forbids it), who/when/how (version prefilled, scope, signed-against versions), and a review with the server's classification |
| `openCertDetails(c)`, `openWithdrawDialog(c)` | a certificate in full (edit and delete for hand-made ones, withdraw when in force); the withdrawal decision |
| `openWitnessDialog(witId)` | the witness wizard: where and when, what was seen (per mode: not logged, not there, exactly, at least, between; taint, confidentiality, authority), source, and a review: `POST /api/evidence/witness` shapes and classifies it |
| `openWitnessDetails(w, fmtAt)`, `openRejectDialog(w)` | a witness in full (edit and delete for hand-made ones, reject for the others); the two-reviewer rejection |
| `certRows`, `rowWords`, `word`, `stateChip`, `changed`, `strip` | helpers |

#### `web/analysis.js` (view 3)
| definition | what it does |
|---|---|
| `AnalysisView.run()` | `POST /api/analyses` with the model and the evidence, then follows `GET /api/analyses/{id}/events` (Server-Sent Events); at the `end` event fetches `GET /api/analyses/{id}`, stores the report in `S.analysis` and emits `report` |
| `stageState`, `stageValue`, `drawPipeline` | the five pipeline boxes (input, relevance, TLC, clingo, output), lit by the event steps |
| `renderLive`, `drawLog`, `render` | the live coordinator log and the page |
| `conesPanel(rep)` | per cone: its cells and verdicts, open rows, components, the TLC calls (states, depth, seconds or cached) |
| `showTla(hash)`, `showAsp(cell)` | `GET /api/tla/{hash}` (module, cfg, library, TLC output); `GET /api/analyses/{id}/cells/{cell}/asp` |
| `nothingToJudge()` | why a well-formed model gives no cell |

#### `web/verdicts.js` (view 4)
| definition | what it does |
|---|---|
| `VerdictsView.render()`, `list(rep)` | the summary counts, the exports, the cells grouped by observation point, worst first |
| `detail()` | one cell: meaning, statuses (per use case), advice, conflict box, why, candidates, root causes, severity, certificates and witnesses used, certificates withheld by scope |
| `rooms(c, host)`, `trace(c, host)`, `asp(c)` | `GET …/possibilities` (candidate boxes, struck ones with what struck them), `GET …/trace` (a reaching run, round by round), `GET …/asp` |
| `rankingPanel`, `claimsPanel`, `housekeepingPanel` | certify next; claims and their judgement; re-verify, declared absorptions, certificates not in force |
| `export(kind, type)` | downloads `report.md` or `cra.json` |
| `shortReason(c)` | the one-line reason in the cell list |
