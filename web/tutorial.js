// The guided tour (Help → Start the tour): six chapters that build a small system with the user and
// use every part of the reasoner. Each step points at the real control (it is outlined), says in a
// sentence or two what to do, and notices when it is done, by watching the model, the evidence and
// the analysis; "Do it for me" makes the same change through the same functions the canvas and the
// windows use, first catching up on any earlier step that was skipped, and pressed again it goes on
// to the next step, so it can be clicked through the whole tour. One failure is followed (a wrong value at the log point) through every verdict:
// unchecked, exposed (A), guarantee (N), unchecked {S,A}, hope (S), guarantee (N). The story is
// checked with the engine in tests/test_tutorial.py.
import { h, clear, verdictClass } from './lib.js';
import { S, on, emit, cloneDoc, commitDoc, persist, blankDoc, connectPorts, addObs, analysisBasis, runCheck, modeFields } from './state.js';
import { button, confirmDialog, isDialogOpen, closeAllDialogs } from './dialog.js';

// ---------------------------------------------------------------- what the user built so far
/** The parts the tour talks about, found in whatever the user built: the first non-LLM component
 * (the "parser"), the first LLM, the system input and output, the edges between them, the log point
 * on the edge into the output, the guard on the LLM's edge. */
export function context(d) {
  const sys = (d.layout && d.layout.sys) || {};
  const fromSys = (e) => e.from.startsWith('sys.'), toSys = (e) => e.to.startsWith('sys.');
  const owner = (ref) => ref.split('.')[0];
  const others = d.components.filter((c) => c.kind !== 'llm');
  const wired = (c, test) => d.edges.some((e) => owner(e.from) === c.id && test(e));
  const parser = others.find((c) => wired(c, toSys)) || others.find((c) => d.edges.some((e) => owner(e.from) === c.id || owner(e.to) === c.id)) || others[0] || null;
  const llm = d.components.find((c) => c.kind === 'llm') || null;
  const ins = new Set([...Object.keys(sys).filter((n) => sys[n].dir === 'in'), ...d.edges.filter(fromSys).map((e) => e.from.slice(4))]);
  const outs = new Set([...Object.keys(sys).filter((n) => sys[n].dir === 'out'), ...d.edges.filter(toSys).map((e) => e.to.slice(4))]);
  const outEdge = parser && d.edges.find((e) => owner(e.from) === parser.id && toSys(e));
  const inEdge = parser && d.edges.find((e) => fromSys(e) && owner(e.to) === parser.id);
  const llmIn = llm && d.edges.find((e) => fromSys(e) && owner(e.to) === llm.id);
  const llmEdge = llm && parser && d.edges.find((e) => owner(e.from) === llm.id && owner(e.to) === parser.id);
  const obs = outEdge && d.observation_points.find((o) => o.edge === outEdge.id);
  const onLlm = llmEdge ? d.guards.filter((g) => g.edge === llmEdge.id) : [];
  const guard = onLlm.find((g) => (g.targets || []).some((t) => t.mode === 'value')) || onLlm[0] || null;
  return { parser, llm, sin: [...ins][0] || null, sout: [...outs][0] || null, outEdge, inEdge, llmIn, llmEdge, obs, guard,
    valueRow: parser && outEdge ? `default.${parser.id}.${outEdge.from.split('.')[1]}.value` : null,
    // value and its sub-kinds: each has a default row of its own, so a fix certifies all of them
    valueRows: parser && outEdge ? modeFields(d).filter((f) => f.name === 'value' || f.parent === 'value').map((f) => `default.${parser.id}.${outEdge.from.split('.')[1]}.${f.name}`) : [] };
}

const ev = () => S.evidence;
const report = () => S.analysis && S.analysis.report;
const current = () => !!(report() && S.analysis.basis === analysisBasis());
const valueCell = () => { const c = context(S.doc); const r = report(); return c.obs && r ? r.cells.find((x) => x.cell === `value@${c.obs.id}`) : null; };
const certSays = (cid, word, alive = true) => ev().certificates.some((c) => c.component === cid
  && Object.entries({ ...(c.rows || {}), ...(c.targets || {}) }).some(([k, v]) => (k === 'value' || k.endsWith('.value')) && v === word)
  && (!alive || !ev().decisions.some((d) => d.kind === 'withdraw-cert' && d.certificate === c.id)));
const addEvidence = (kind, item) => { S.evidence[kind] = [...S.evidence[kind], { date: new Date().toISOString().slice(0, 10), manual: true, ...item }]; persist(); emit('evidence'); };
/** A certificate's own id, or the next free one if the user already used it. */
const certId = (id) => fresh(id, new Set(ev().certificates.map((c) => c.id)));
const valueStates = (c) => Object.entries({ ...(c.rows || {}), ...(c.targets || {}) }).filter(([k]) => k === 'value' || k.endsWith('.value')).map(([, v]) => v);
const isSaying = (c, word) => valueStates(c).includes(word);
/** The component's certificates not withdrawn that say something about the value row. */
const valueCerts = (cid) => ev().certificates.filter((c) => c.component === cid && valueStates(c).length
  && !ev().decisions.some((d) => d.kind === 'withdraw-cert' && d.certificate === c.id));
const notNever = (cid) => valueCerts(cid).filter((c) => !isSaying(c, 'never'));
/** What the tour needs from the model whatever the user changed: the failure it follows, and defaults. */
const basicsOk = (d) => d.worst_case_defaults === 'all' && d.modes.some((m) => (typeof m === 'string' ? m : Object.keys(m)[0]) === 'value');
const ensureBasics = (d) => { if (!d.modes.some((m) => (typeof m === 'string' ? m : Object.keys(m)[0]) === 'value')) d.modes.push('value'); d.worst_case_defaults = 'all'; };
/** What a verdict means, for when the user's model or evidence took another road than the story. */
const MEANING = {
  unchecked: 'The evidence does not settle it: the remaining possibilities disagree.',
  guarantee: 'The evidence rules it out.',
  hope: 'It can happen sometimes, but not every time.',
  exposed: 'It reaches the log every time.',
  'not exercised': 'No message reaches this log point.',
  conflict: 'The evidence contradicts itself; the Verdicts page names what clashes.',
};
const editDoc = (fn, sel) => { const d = cloneDoc(); fn(d); commitDoc(d, sel); };
const fresh = (id, taken) => { let k = id, i = 2; while (taken.has(k)) k = `${id}${i++}`; return k; };

// ---------------------------------------------------------------- where to point
const $$ = (sel) => [...document.querySelectorAll(sel)];
const byText = (sel, text) => $$(sel).filter((b) => b.textContent.trim().startsWith(text));
const T = {
  flow: () => $$('#flow'),
  pal: (name) => () => byText('.palette .pal', name),
  canvas: () => $$('.canvas-wrap, #view-model svg').slice(0, 1),
  run: () => $$('#btn-run'),
  verdictbar: () => $$('#verdictbar'),
  step: (view) => () => $$(`.step[data-view="${view}"]`),
  button: (text) => () => byText('button', text).filter((b) => b.offsetParent),
  certCard: (word) => () => $$('#view-evidence .wit.clickable').filter((w) => w.textContent.includes(`value: ${word}`) || w.textContent.includes(word)),
  cell: () => $$('#view-verdicts .cellbtn').filter((b) => (b.querySelector('.f') || {}).textContent === 'value'),
  panel: (title) => () => $$('.panel').filter((p) => (p.querySelector('h2') || {}).textContent === title),
  menu: (label) => () => $$(`[aria-label="${label}"]`),
  caseSelect: () => $$('#case-select'),
};

// ---------------------------------------------------------------- the tour
// A step: chapter, title, text, target() -> elements, view (shown when the step starts), and either
// done() with doIt() (an action), or nothing (read and go on). done() stays true once the story has
// moved past the step, so that catching up never repeats or undoes it. `after` says what it showed. A
// run step (run: true) shows the followed cell's verdict, and `expect` is the verdict the story
// promises; nav: true steps only open a page, and catching up passes over them and over runs;
// needsRun: true steps need a current analysis; focus: true selects the followed cell.
const RUN = (after, expect) => ({ title: 'Run the analysis', text: 'Press Run analysis, top right. It runs every switch vector of the rows that matter, in every firing order, and keeps what the evidence allows.', target: T.run, run: true,
  done: () => current() && !!valueCell(), after, expect });

export const CHAPTERS = ['Welcome', 'The model', 'Evidence', 'An LLM joins', 'Reading the verdicts', 'A guard', 'And more'];

export const STEPS = [
  { ch: 0, title: 'Welcome', text: 'You will build a small system and use every part of the reasoner on it. Do each step yourself: the outlined control shows where. Stuck? "Do it for me".' },
  { ch: 0, title: 'Four steps, left to right', target: T.flow, text: 'The work runs Model → Evidence → Analysis → Verdicts. Each step says where it stands; click one to go there.' },

  { ch: 1, view: 'model', title: 'Add a component', target: T.pal('Deterministic'), text: 'Drag Deterministic from the palette onto the canvas: an ordinary program, say a parser that turns a request into an order.',
    done: () => !!context(S.doc).parser,
    doIt: () => editDoc((d) => { d.components.push({ id: fresh('parser', new Set(d.components.map((c) => c.id))), kind: 'deterministic', label: 'turns the request into an order', in: [], out: [], rows: [], pos: { x: 470, y: 200 } }); }),
    after: 'A component. Double-click any box to edit it, or select it and read it on the right.' },
  { ch: 1, view: 'model', title: 'Where messages enter and leave', target: () => [...T.pal('System input')(), ...T.pal('System output')()], text: 'Drag a System input to the left of it and a System output to the right.',
    done: () => { const c = context(S.doc); return !!(c.sin && c.sout); },
    doIt: () => editDoc((d) => { const c = context(d); const x = c.parser ? c.parser.pos.x : 470; if (!c.sin) d.layout.sys.request = { x: x - 380, y: 205, dir: 'in' }; if (!c.sout) d.layout.sys.order = { x: x + 330, y: 205, dir: 'out' }; }) },
  { ch: 1, view: 'model', title: 'Wire them', target: T.canvas, text: 'Drag from the + handle on the right of a box to the next box: input → component → output.',
    done: () => { const c = context(S.doc); return !!((c.inEdge || c.llmEdge) && c.outEdge && S.doc.use_cases.length); },
    doIt: () => {
      const c = context(S.doc);
      if (!c.inEdge && !c.llmEdge) connectPorts({ node: `sys:${c.sin}` }, { node: c.parser.id });
      if (!context(S.doc).outEdge) connectPorts({ node: c.parser.id }, { node: `sys:${c.sout}` });
      if (!S.doc.use_cases.length) editDoc((d) => { d.use_cases.push({ id: 'uc1', label: '', entries: [{ port: c.sin, token: {} }] }); });
    },
    after: 'The first wire from an input also made a use case: where messages enter.' },
  { ch: 1, view: 'model', title: 'Where you read a log', target: T.pal('Observation point'), text: 'Drag an Observation point onto the edge into the output, and save its window. This is where a log is read.',
    done: () => { const o = context(S.doc).obs; return !!o && 'value' in (o.tolerate || {}); },
    doIt: () => {
      const c = context(S.doc);
      const id = c.obs ? c.obs.id : addObs(c.outEdge.id);
      editDoc((d) => { const o = d.observation_points.find((x) => x.id === id); if (!c.obs) o.label = 'order log'; o.tolerate = { ...(o.tolerate || {}), value: 1 }; });
    } },
  { ...RUN('Every failure at the log is unchecked: nothing is known yet, so it might happen never, sometimes or always. The verdict bar under the top bar shows it from now on.', 'unchecked'), ch: 1 },

  { ch: 2, nav: true, title: 'Open the evidence', target: T.step('evidence'), text: 'Click 2 Evidence in the strip.', done: () => S.view === 'evidence', doIt: () => emit('show', 'evidence') },
  { ch: 2, view: 'evidence', title: 'A test report', target: T.button('New certificate'), text: 'The test team finds the component always gets values wrong. Write it down: New certificate…, pick the component, set its value row to always, add it.',
    done: () => { const c = context(S.doc); return !!c.parser && certSays(c.parser.id, 'always', false); },
    doIt: () => {
      const c = context(S.doc);
      // a certificate saying something else about this row would clash with the report: it goes first
      for (const x of valueCerts(c.parser.id).filter((y) => !isSaying(y, 'always'))) addEvidence('decisions', { kind: 'withdraw-cert', certificate: x.id, by: 'the tour', reason: 'replaced by the test report' });
      addEvidence('certificates', { id: certId('c_test'), component: c.parser.id, rows: { [c.valueRow]: 'always' }, issuer: 'test team', method: 'integration tests' });
    },
    after: 'A certificate fixes how often a row applies: never, sometimes or always.' },
  { ...RUN('value is exposed: it reaches the log every time (A). The other failures are still unchecked.', 'exposed'), ch: 2 },
  { ch: 2, view: 'evidence', title: 'The bug is fixed', target: T.certCard('always'), text: 'Click the test report and withdraw it, with a reason: the bug is fixed.',
    done: () => { const c = context(S.doc); return !!c.parser && ev().decisions.some((d) => d.kind === 'withdraw-cert') && !notNever(c.parser.id).length; },
    doIt: () => { for (const c of notNever(context(S.doc).parser.id)) addEvidence('decisions', { kind: 'withdraw-cert', certificate: c.id, by: 'test team', reason: 'the bug is fixed' }); },
    after: 'The register keeps the withdrawn report and the reason.' },
  { ch: 2, view: 'evidence', title: 'Certify the fix', target: T.button('New certificate'), text: 'New certificate… again: the value row, never.',
    done: () => { const c = context(S.doc); return !!c.parser && certSays(c.parser.id, 'never'); },
    doIt: () => { const c = context(S.doc); addEvidence('certificates', { id: certId('c_fix'), component: c.parser.id, rows: Object.fromEntries(c.valueRows.map((r) => [r, 'never'])), issuer: 'parser team', method: 'property-based tests' }); } },
  { ...RUN('value is a guarantee: the evidence rules it out (N).', 'guarantee'), ch: 2 },

  { ch: 3, view: 'model', title: 'Add an LLM', target: T.pal('LLM component'), text: 'An LLM will write the request before your component reads it. Drag an LLM component onto the canvas.',
    done: () => !!context(S.doc).llm,
    doIt: () => editDoc((d) => {
      // between the input and the component, moving the component and the output along if needed
      const c = context(d);
      const sinPos = (d.layout.sys[c.sin] || {}).x;
      const left = sinPos !== undefined ? sinPos : c.parser.pos.x - 420;
      const shift = Math.max(0, left + 430 - c.parser.pos.x);
      c.parser.pos.x += shift;
      if (d.layout.sys[c.sout] && d.layout.sys[c.sout].x !== undefined) d.layout.sys[c.sout].x += shift;
      d.components.push({ id: fresh('writer', new Set(d.components.map((x) => x.id))), kind: 'llm', label: 'writes the order draft', in: [], out: [], rows: [], pos: { x: left + 210, y: c.parser.pos.y } });
    }) },
  { ch: 3, view: 'model', title: 'Put it in the path', target: T.canvas, text: 'Click the edge from the input to your component and press Delete. Then wire input → LLM → component.',
    done: () => { const c = context(S.doc); return !!(c.llmIn && c.llmEdge && !c.inEdge); },
    doIt: () => { const c = context(S.doc); if (c.inEdge) editDoc((d) => { d.edges = d.edges.filter((e) => e.id !== c.inEdge.id); });
      const c2 = context(S.doc); if (!c2.llmIn) connectPorts({ node: `sys:${c2.sin}` }, { node: c2.llm.id }); if (!context(S.doc).llmEdge) connectPorts({ node: c2.llm.id }, { node: c2.parser.id });  },
    after: 'Boxes can be dragged to tidy up; Fit brings the whole model into view.' },
  { ...RUN('Unchecked again, now sometimes or always (S, A): an LLM can get it wrong, and no certificate may say "never" for an LLM.', 'unchecked'), ch: 3 },
  { ch: 3, view: 'evidence', title: 'A clean log line', target: T.button('New witness'), text: 'The order log shows an order that came out right. New witness…: at the log point, set value to "absent", then add it.',
    done: () => { const c = context(S.doc); return !!c.obs && ev().witnesses.some((w) => { const m = w.at && w.at[c.obs.id] && w.at[c.obs.id].modes; return m && m.value && m.value[1] === 0; }); },
    doIt: () => { const c = context(S.doc); addEvidence('witnesses', { id: fresh('w_clean', new Set(ev().witnesses.map((w) => w.id))), use_case: (S.doc.use_cases[0] || {}).id, at: { [c.obs.id]: { used: true, modes: { value: [0, 0] } } }, source: 'order log, line 1042', recogniser: 'manual' }); },
    after: 'A witness says what one logged interaction delivered. Logs dropped on this page become witnesses too.' },
  { ...RUN('value is a hope (S): this order was fine, so it does not happen every time, but it can happen.', 'hope'), ch: 3 },

  { ch: 4, nav: true, needsRun: true, title: 'Open the verdict', target: () => [...T.step('verdicts')(), ...T.cell()], text: 'Open 4 Verdicts and click the value row.',
    done: () => S.view === 'verdicts' && !!document.querySelector('#view-verdicts .cellbtn.active') && (document.querySelector('#view-verdicts .cellbtn.active .f') || {}).textContent === 'value',
    doIt: () => { const c = context(S.doc); emit('focus-cell', `value@${c.obs.id}`); } },
  { ch: 4, view: 'verdicts', needsRun: true, focus: true, title: 'Why, and what to do', target: () => [...T.button('Show the candidates')(), ...T.button('Show a reaching run')()], text: 'The right side says why and what to do. Try Show the candidates and Show a reaching run: the run tells, firing by firing, how the wrong value gets through.' },
  { ch: 4, view: 'verdicts', needsRun: true, title: 'What to certify next', target: T.panel('Certify next'), text: 'Certify next ranks what to certify first, by how much it would settle. Scroll down to see it.' },

  { ch: 5, view: 'model', title: 'Add a guard', target: T.pal('Guard'), text: 'Drag a Guard onto the edge from the LLM to your component. In its window, make it catch value, and add it.',
    done: () => { const g = context(S.doc).guard; return !!g && (g.targets || []).some((t) => t.mode === 'value'); },
    doIt: () => editDoc((d) => {
      const c = context(d);
      const target = { mode: 'value', decidable: true };
      if (c.guard) c.guard.targets = [...(c.guard.targets || []), target];
      else d.guards.push({ id: fresh('schema', new Set([...d.guards.map((g) => g.id), ...d.components.map((x) => x.id)])), edge: c.llmEdge.id, label: 'schema check', targets: [target] });
    }),
    after: 'A guard catches what it targets, unless its leak row applies. Nobody has vouched for it yet.' },
  { ch: 5, view: 'evidence', title: 'Certify the guard', target: T.button('New certificate'), text: 'New certificate…: pick the guard, say it never lets value through.',
    done: () => { const g = context(S.doc).guard; return !!g && certSays(g.id, 'never'); },
    doIt: () => { const g = context(S.doc).guard; addEvidence('certificates', { id: certId('c_schema'), component: g.id, targets: { value: 'never' }, issuer: 'platform team', method: 'schema tests' }); } },
  { ...RUN('value is a guarantee again (N), whatever the LLM does: the certified guard stops it.', 'guarantee'), ch: 5 },

  { ch: 6, needsRun: true, title: 'The engine at work', target: T.step('analysis'), text: '3 Analysis shows how the verdicts were computed: what ran, step by step. Have a look.' },
  { ch: 6, title: 'Work with an assistant', target: T.menu('Assistant'), text: 'The Assistant menu connects Claude to the reasoner: it can build, check and explain models with you.' },
  { ch: 6, title: 'Save, open, examples', target: () => [...T.menu('File')(), ...T.caseSelect()], text: 'File saves and opens models. The case picker opens three worked examples with their logs and certificates.' },
  { ch: 6, title: 'Simple or detailed', target: T.menu('Help'), text: 'The reasoner starts simple. Help → Show all details shows everything it hides, and Help starts this tour again.' },
];

export class Tutorial {
  /** load(doc, evidence): replaces the model and the evidence (app.js setDoc, forgetting any case). */
  constructor({ load }) {
    this.load = load;
    this.card = null;
    this.lit = [];
    this.waiting = [];
    this.pinned = 0;
    for (const e of ['doc', 'evidence', 'select']) on(e, () => this.tick());
    on('report', () => { const w = this.waiting; this.waiting = []; w.forEach((r) => r()); this.tick(); });
    on('loaded', () => {
      if (!this.card) return;
      if (!this.loading) { this.foreign = true; this.light([]); this.render(); }
      this.tick();
    });
  }

  async start() {
    if (this.card) return;
    if (S.doc && S.doc.components.length) {
      const ok = await confirmDialog('The tour starts a new, empty model. Export the one you have first if you want to keep it (File → Export).', { title: 'Start the tour', okText: 'Start' });
      if (!ok) return;
    }
    const doc = blankDoc();
    doc.name = 'my-first-model';
    doc.description = 'Built in the tour.';
    this.foreign = false; this.busy = false; this.note = null;
    this.loadModel(doc, {});
    this.card = h('aside', { class: 'tutorial', 'aria-label': 'Tour', 'aria-live': 'polite' });
    document.body.appendChild(this.card);
    this.timer = setInterval(() => this.tick(), 500);
    this.go(0);
  }

  loadModel(doc, evidence) { this.loading = true; this.load(doc, evidence); this.loading = false; }

  stop() {
    clearInterval(this.timer);
    this.light([]);
    if (this.card) this.card.remove();
    this.card = null;
  }

  go(i) {
    this.i = i;
    this.note = null;
    const st = STEPS[i];
    if (st.view && S.view !== st.view) emit('show', st.view);
    if (st.focus && valueCell()) emit('focus-cell', valueCell().cell);
    this.render();
    setTimeout(() => { const el = this.lit[0]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, 100);
  }

  stepDone(st) { try { return st.done ? !!st.done() : true; } catch (e) { return false; } }
  isDone() { return this.stepDone(STEPS[this.i]); }

  /** The earlier actions that were skipped (or undone since). */
  missing(i) { return STEPS.slice(0, i).filter((s) => s.done && !s.run && !s.nav && !this.stepDone(s)); }

  /** What the card shows that the model can change: redrawn when it does. */
  state() { return [this.isDone(), this.missing(this.i).length, current(), !!valueCell()].join(); }

  /** Whether "Do it for me" has anything to do at step i. */
  work(i) {
    const st = STEPS[i];
    return this.missing(i).length > 0 || !this.stepDone(st) || (!!st.needsRun && !(current() && valueCell()));
  }

  /** Runs the analysis and waits for it: one already running is waited for, not started twice. */
  async analyse() {
    const finished = () => new Promise((r) => { this.waiting.push(r); });
    if (S.analysis && S.analysis.status === 'running') await finished();
    if (current() && valueCell()) return;
    await runCheck();
    if (!S.check || !S.check.ok) { this.note = `The model has a problem: ${((S.check && S.check.problems) || ['it cannot be read'])[0]}`; return; }
    const done = finished();
    emit('run', { quiet: true });
    await done;
    if (S.analysis && S.analysis.error) this.note = 'The analysis failed: see 3 Analysis.';
  }

  /** Brings the model and the evidence to step i: every action not done yet, in the story's order,
   * then the analysis if the step needs one. A window left open is closed first: it edits a copy. */
  async catchUp(i) {
    this.note = null;
    closeAllDialogs();
    if (!basicsOk(S.doc)) editDoc(ensureBasics);
    for (const s of STEPS.slice(0, i + 1)) if (s.doIt && !s.nav && !this.stepDone(s)) s.doIt();
    const st = STEPS[i];
    if (st.run || st.needsRun) await this.analyse();
    if (st.nav && !this.stepDone(st)) st.doIt();
    if (st.view && S.view !== st.view) emit('show', st.view);
    if (st.focus && valueCell()) emit('focus-cell', valueCell().cell);
    emit('fit');
  }

  /** Do it for me: catches up at this step, or, if it is done, goes on and does the next one. */
  async press() {
    if (this.busy) return;
    this.busy = true;
    this.pinned = Date.now() + 2500;
    this.render();
    try {
      if (this.foreign) this.resume();
      else if (this.work(this.i)) await this.catchUp(this.i);
      else if (this.i < STEPS.length - 1) { this.go(this.i + 1); if (this.work(this.i)) await this.catchUp(this.i); }
    } catch (e) { this.note = `That did not work: ${e.message}`; }
    this.busy = false;
    this.render();
  }

  /** Back to the tour's model after the user opened another one. */
  resume() {
    this.loadModel(this.saved.doc, this.saved.ev);
    this.foreign = false;
    const st = STEPS[this.i];
    if (st.view) emit('show', st.view);
  }

  /** Re-points the outline at the step's controls (they are redrawn often) and notices a step done. */
  tick() {
    if (!this.card) return;
    if (this.foreign) { this.place(); return; }
    if (S.doc) this.saved = { doc: S.doc, ev: S.evidence };
    const st = STEPS[this.i];
    this.light(st.target ? st.target() : []);
    if (this.state() !== this.shown && !this.busy) this.render();
    this.place();
  }

  light(els) {
    for (const el of this.lit) if (!els.includes(el)) el.classList.remove('tour-target');
    for (const el of els) el.classList.add('tour-target');
    this.lit = els;
  }

  /** Keeps the card off the controls it points at, and above an open window. While "Do it for me" is
   * being clicked it stays put, so the button stays under the mouse. */
  place() {
    this.card.classList.toggle('over', isDialogOpen());
    if (Date.now() < this.pinned) return;
    const r = this.lit.map((el) => el.getBoundingClientRect()).filter((x) => x.width);
    const w = window.innerWidth, hgt = window.innerHeight;
    this.card.classList.toggle('left', r.some((x) => x.right > w - 420 && x.bottom > hgt - 400));
  }

  renderPaused() {
    const c = clear(this.card);
    c.append(
      h('div', { class: 'tut-head' }, h('span', { class: 'tut-count' }, 'The tour'),
        h('button', { class: 'dlg-x', type: 'button', 'aria-label': 'Close the tour', onclick: () => this.stop() }, '×')),
      h('h3', {}, 'The tour is paused'),
      h('p', {}, 'You opened another model. The tour\'s model is kept: go back whenever you like.'),
      h('div', { class: 'tut-actions' }, h('span', { class: 'spacer' }), button('Back to the tour', () => this.press(), { primary: true, disabled: this.busy })));
  }

  render() {
    if (!this.card) return;
    if (this.foreign) { this.renderPaused(); return; }
    this.shown = this.state();
    const st = STEPS[this.i];
    const done = st.done && this.isDone();
    const inCh = STEPS.filter((s) => s.ch === st.ch), k = inCh.indexOf(st);
    const skipped = this.missing(this.i);
    const c = clear(this.card);
    c.append(
      h('div', { class: 'tut-head' }, h('span', { class: 'tut-count' }, st.ch ? `Chapter ${st.ch} of ${CHAPTERS.length - 1} · ${CHAPTERS[st.ch]}` : 'The tour'),
        h('button', { class: 'dlg-x', type: 'button', 'aria-label': 'Close the tour', onclick: () => this.stop() }, '×')),
      h('div', { class: 'tut-dots', 'aria-hidden': 'true' }, inCh.map((s, j) => h('span', { class: j < k || (j === k && (done || !st.done)) ? 'on' : j === k ? 'cur' : '' }))),
      h('h3', {}, done ? `✓ ${st.title}` : st.title),
      h('p', {}, st.text));
    if (skipped.length) {
      const names = skipped.slice(0, 2).map((s) => s.title).join(', ');
      c.appendChild(h('p', { class: 'tut-note' }, `Skipped so far: ${names}${skipped.length > 2 ? ` and ${skipped.length - 2} more` : ''}. Do it for me catches up.`));
    } else if (st.needsRun && !(current() && valueCell())) {
      c.appendChild(h('p', { class: 'tut-note' }, 'This step needs a fresh analysis. Do it for me runs it.'));
    }
    if (this.note) c.appendChild(h('p', { class: 'tut-note warn' }, this.note));
    if (done && (st.after || st.run)) {
      const cell = st.run ? valueCell() : null;
      const onStory = !st.expect || (cell && cell.verdict === st.expect);
      c.appendChild(h('div', { class: 'tut-result' },
        cell ? h('div', { class: 'inline' }, h('span', { class: `v ${verdictClass(cell.verdict)}` }, cell.verdict), h('span', { class: 'mono small' }, `{${cell.statuses.join(', ')}}`), h('span', { class: 'small muted' }, 'a wrong value at the log')) : null,
        onStory ? (st.after ? h('p', {}, st.after) : null)
          : h('p', {}, `${MEANING[cell.verdict] || ''} Your model or evidence differs from the tour's here, so the result does too. That is fine: try it, and go on.`)));
    }
    const last = this.i === STEPS.length - 1;
    const doer = this.busy ? 'Working…' : 'Do it for me';
    c.appendChild(h('div', { class: 'tut-actions' },
      button('Back', () => this.go(this.i - 1), { small: true, ghost: true, disabled: !this.i || this.busy }),
      !last || this.work(this.i) ? button(doer, () => this.press(), { small: true, disabled: this.busy }) : null,
      h('span', { class: 'spacer' }),
      last ? button('Finish', () => this.stop(), { primary: true, disabled: this.busy })
        : button(st.done && !done ? 'Skip' : 'Next →', () => this.go(this.i + 1), { primary: !st.done || !!done, small: !!st.done && !done, disabled: this.busy })));
  }
}
