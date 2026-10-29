// The guided tour (Help → Start the tour): six chapters that build a small system with the user and
// use every part of the reasoner. Each step points at the real control (it is outlined), says in a
// sentence or two what to do, and notices when it is done, by watching the model, the evidence and
// the analysis; "Do it for me" makes the same change through the same functions the canvas and the
// windows use. One failure is followed (a wrong value at the log point) through every verdict:
// unchecked, exposed (A), guarantee (N), unchecked {S,A}, hope (S), guarantee (N). The story is
// checked with the engine in tests/test_tutorial.py.
import { h, clear, verdictClass } from './lib.js';
import { S, on, emit, cloneDoc, commitDoc, persist, blankDoc, connectPorts, addObs, analysisBasis } from './state.js';
import { button, confirmDialog, isDialogOpen } from './dialog.js';

// ---------------------------------------------------------------- what the user built so far
/** The parts the tour talks about, found in whatever the user built: the first non-LLM component
 * (the "parser"), the first LLM, the system input and output, the edges between them, the log point
 * on the edge into the output, the guard on the LLM's edge. */
export function context(d) {
  const sys = (d.layout && d.layout.sys) || {};
  const fromSys = (e) => e.from.startsWith('sys.'), toSys = (e) => e.to.startsWith('sys.');
  const owner = (ref) => ref.split('.')[0];
  const parser = d.components.find((c) => c.kind !== 'llm') || null;
  const llm = d.components.find((c) => c.kind === 'llm') || null;
  const ins = new Set([...Object.keys(sys).filter((n) => sys[n].dir === 'in'), ...d.edges.filter(fromSys).map((e) => e.from.slice(4))]);
  const outs = new Set([...Object.keys(sys).filter((n) => sys[n].dir === 'out'), ...d.edges.filter(toSys).map((e) => e.to.slice(4))]);
  const outEdge = parser && d.edges.find((e) => owner(e.from) === parser.id && toSys(e));
  const inEdge = parser && d.edges.find((e) => fromSys(e) && owner(e.to) === parser.id);
  const llmIn = llm && d.edges.find((e) => fromSys(e) && owner(e.to) === llm.id);
  const llmEdge = llm && parser && d.edges.find((e) => owner(e.from) === llm.id && owner(e.to) === parser.id);
  const obs = outEdge && d.observation_points.find((o) => o.edge === outEdge.id);
  const guard = llmEdge && d.guards.find((g) => g.edge === llmEdge.id);
  return { parser, llm, sin: [...ins][0] || null, sout: [...outs][0] || null, outEdge, inEdge, llmIn, llmEdge, obs, guard,
    valueRow: parser && outEdge ? `default.${parser.id}.${outEdge.from.split('.')[1]}.value` : null };
}

const ev = () => S.evidence;
const report = () => S.analysis && S.analysis.report;
const current = () => !!(report() && S.analysis.basis === analysisBasis());
const valueCell = () => { const c = context(S.doc); const r = report(); return c.obs && r ? r.cells.find((x) => x.cell === `value@${c.obs.id}`) : null; };
const certSays = (cid, word, alive = true) => ev().certificates.some((c) => c.component === cid
  && Object.entries({ ...(c.rows || {}), ...(c.targets || {}) }).some(([k, v]) => (k === 'value' || k.endsWith('.value')) && v === word)
  && (!alive || !ev().decisions.some((d) => d.kind === 'withdraw-cert' && d.certificate === c.id)));
const addEvidence = (kind, item) => { S.evidence[kind] = [...S.evidence[kind], { date: new Date().toISOString().slice(0, 10), manual: true, ...item }]; persist(); emit('evidence'); };
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
// done() with doIt() (an action), or nothing (read and go on). `after` says what it showed; a run step
// (run: true) also shows the verdict of the followed cell.
const RUN = (after) => ({ title: 'Run the analysis', text: 'Press Run analysis, top right. It runs every possibility of the rows that matter and keeps what the evidence allows.', target: T.run, run: true,
  done: () => current() && !!valueCell(), doIt: () => emit('run', { quiet: true }), after });

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
    done: () => { const c = context(S.doc); return !!(c.inEdge && c.outEdge); },
    doIt: () => { const c = context(S.doc); if (!c.inEdge) connectPorts({ node: `sys:${c.sin}` }, { node: c.parser.id }); if (!context(S.doc).outEdge) connectPorts({ node: c.parser.id }, { node: `sys:${c.sout}` }); },
    after: 'The first wire from an input also made a use case: where messages enter.' },
  { ch: 1, view: 'model', title: 'Where you read a log', target: T.pal('Observation point'), text: 'Drag an Observation point onto the edge into the output, and save its window. This is where a log is read.',
    done: () => !!context(S.doc).obs,
    doIt: () => { const c = context(S.doc); const id = addObs(c.outEdge.id); editDoc((d) => { d.observation_points.find((o) => o.id === id).label = 'order log'; }); } },
  { ...RUN('Every failure at the log is unchecked: nothing is known yet, so it might happen never, sometimes or always. The verdict bar under the top bar shows it from now on.'), ch: 1 },

  { ch: 2, title: 'Open the evidence', target: T.step('evidence'), text: 'Click 2 Evidence in the strip.', done: () => S.view === 'evidence', doIt: () => emit('show', 'evidence') },
  { ch: 2, view: 'evidence', title: 'A test report', target: T.button('New certificate'), text: 'The test team finds the component always gets values wrong. Write it down: New certificate…, pick the component, set its value row to always, add it.',
    done: () => { const c = context(S.doc); return !!c.parser && certSays(c.parser.id, 'always'); },
    doIt: () => { const c = context(S.doc); addEvidence('certificates', { id: 'c_test', component: c.parser.id, rows: { [c.valueRow]: 'always' }, issuer: 'test team', method: 'integration tests' }); },
    after: 'A certificate fixes how often a row fires: never, sometimes or always.' },
  { ...RUN('value is exposed: it reaches the log every time (A). The other failures are still unchecked.'), ch: 2 },
  { ch: 2, view: 'evidence', title: 'The bug is fixed', target: T.certCard('always'), text: 'Click the test report and withdraw it, with a reason: the bug is fixed.',
    done: () => ev().decisions.some((d) => d.kind === 'withdraw-cert'),
    doIt: () => { const c = ev().certificates.find((x) => certSays(x.component, 'always') && x.component === context(S.doc).parser.id); addEvidence('decisions', { kind: 'withdraw-cert', certificate: c.id, by: 'test team', reason: 'the bug is fixed' }); },
    after: 'The register keeps the withdrawn report and the reason.' },
  { ch: 2, view: 'evidence', title: 'Certify the fix', target: T.button('New certificate'), text: 'New certificate… again: the value row, never.',
    done: () => { const c = context(S.doc); return !!c.parser && certSays(c.parser.id, 'never'); },
    doIt: () => { const c = context(S.doc); addEvidence('certificates', { id: 'c_fix', component: c.parser.id, rows: { [c.valueRow]: 'never' }, issuer: 'parser team', method: 'property-based tests' }); } },
  { ...RUN('value is a guarantee: the evidence rules it out (N).'), ch: 2 },

  { ch: 3, view: 'model', title: 'Add an LLM', target: T.pal('LLM component'), text: 'An LLM will write the request before your component reads it. Drag an LLM component onto the canvas.',
    done: () => !!context(S.doc).llm,
    doIt: () => editDoc((d) => { const c = context(d); d.components.push({ id: fresh('writer', new Set(d.components.map((x) => x.id))), kind: 'llm', label: 'writes the order draft', in: [], out: [], rows: [], pos: { x: (c.parser ? c.parser.pos.x : 470) - 210, y: 200 } }); if (c.parser) c.parser.pos.x += 60; if (c.sout && d.layout.sys[c.sout]) d.layout.sys[c.sout].x += 60; }) },
  { ch: 3, view: 'model', title: 'Put it in the path', target: T.canvas, text: 'Click the edge from the input to your component and press Delete. Then wire input → LLM → component.',
    done: () => { const c = context(S.doc); return !!(c.llmIn && c.llmEdge && !c.inEdge); },
    doIt: () => { const c = context(S.doc); if (c.inEdge) editDoc((d) => { d.edges = d.edges.filter((e) => e.id !== c.inEdge.id); });
      const c2 = context(S.doc); if (!c2.llmIn) connectPorts({ node: `sys:${c2.sin}` }, { node: c2.llm.id }); if (!context(S.doc).llmEdge) connectPorts({ node: c2.llm.id }, { node: c2.parser.id });  },
    after: 'Boxes can be dragged to tidy up; Fit brings the whole model into view.' },
  { ...RUN('Unchecked again, now sometimes or always (S, A): an LLM can get it wrong, and no certificate may say "never" for an LLM.'), ch: 3 },
  { ch: 3, view: 'evidence', title: 'A clean log line', target: T.button('New witness'), text: 'The order log shows an order that came out right. New witness…: at the log point, set value to "not there (0)", then add it.',
    done: () => { const c = context(S.doc); return !!c.obs && ev().witnesses.some((w) => { const m = w.at && w.at[c.obs.id] && w.at[c.obs.id].modes; return m && m.value && m.value[1] === 0; }); },
    doIt: () => { const c = context(S.doc); addEvidence('witnesses', { id: 'w_clean', use_case: (S.doc.use_cases[0] || {}).id, at: { [c.obs.id]: { used: true, modes: { value: [0, 0] } } }, source: 'order log, line 1042', recogniser: 'manual' }); },
    after: 'A witness says what one logged interaction delivered. Logs dropped on this page become witnesses too.' },
  { ...RUN('value is a hope (S): this order was fine, so it does not happen every time, but it can happen.'), ch: 3 },

  { ch: 4, title: 'Open the verdict', target: () => [...T.step('verdicts')(), ...T.cell()], text: 'Open 4 Verdicts and click the value row.',
    done: () => S.view === 'verdicts' && !!document.querySelector('#view-verdicts .cellbtn.active') && (document.querySelector('#view-verdicts .cellbtn.active .f') || {}).textContent === 'value',
    doIt: () => { const c = context(S.doc); emit('focus-cell', `value@${c.obs.id}`); } },
  { ch: 4, view: 'verdicts', title: 'Why, and what to do', target: () => [...T.button('Show the candidates')(), ...T.button('Show a reaching run')()], text: 'The right side says why and what to do. Try Show the candidates and Show a reaching run: the run is a story of how the wrong value gets through.' },
  { ch: 4, view: 'verdicts', title: 'What to certify next', target: T.panel('Certify next'), text: 'Certify next ranks what to certify first, by how much it would settle. Scroll down to see it.' },

  { ch: 5, view: 'model', title: 'Add a guard', target: T.pal('Guard'), text: 'Drag a Guard onto the edge from the LLM to your component. In its window, make it catch value, and add it.',
    done: () => { const g = context(S.doc).guard; return !!g && (g.targets || []).some((t) => t.mode === 'value'); },
    doIt: () => editDoc((d) => { const c = context(d); d.guards = d.guards.filter((g) => g.edge !== c.llmEdge.id); d.guards.push({ id: fresh('schema', new Set([...d.guards.map((g) => g.id), ...d.components.map((x) => x.id)])), edge: c.llmEdge.id, label: 'schema check', targets: [{ mode: 'value', threshold: 1, decidable: true }] }); }),
    after: 'A guard catches what it targets, unless its leak row fires. Nobody has vouched for it yet.' },
  { ch: 5, view: 'evidence', title: 'Certify the guard', target: T.button('New certificate'), text: 'New certificate…: pick the guard, say it never lets value through.',
    done: () => { const g = context(S.doc).guard; return !!g && certSays(g.id, 'never'); },
    doIt: () => { const g = context(S.doc).guard; addEvidence('certificates', { id: 'c_schema', component: g.id, targets: { value: 'never' }, issuer: 'platform team', method: 'schema tests' }); } },
  { ...RUN('value is a guarantee again (N), whatever the LLM does: the certified guard stops it.'), ch: 5 },

  { ch: 6, title: 'The engine at work', target: T.step('analysis'), text: '3 Analysis shows how the verdicts were computed: what ran, step by step. Have a look.' },
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
    for (const e of ['doc', 'evidence', 'report', 'loaded', 'select']) on(e, () => this.tick());
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
    this.load(doc, {});
    this.card = h('aside', { class: 'tutorial', 'aria-label': 'Tour', 'aria-live': 'polite' });
    document.body.appendChild(this.card);
    this.timer = setInterval(() => this.tick(), 500);
    this.go(0);
  }

  stop() {
    clearInterval(this.timer);
    this.light([]);
    if (this.card) this.card.remove();
    this.card = null;
  }

  go(i) {
    this.i = i;
    this.wasDone = false;
    const st = STEPS[i];
    if (st.view && S.view !== st.view) emit('show', st.view);
    this.render();
    setTimeout(() => { const el = this.lit[0]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, 100);
  }

  isDone() { const st = STEPS[this.i]; try { return st.done ? !!st.done() : true; } catch (e) { return false; } }

  /** Re-points the outline at the step's controls (they are redrawn often) and notices a step done. */
  tick() {
    if (!this.card) return;
    const st = STEPS[this.i];
    this.light(st.target ? st.target() : []);
    const done = this.isDone();
    if (st.done && done !== this.wasDone) { this.wasDone = done; this.render(); }
    this.place();
  }

  light(els) {
    for (const el of this.lit) if (!els.includes(el)) el.classList.remove('tour-target');
    for (const el of els) el.classList.add('tour-target');
    this.lit = els;
  }

  /** Keeps the card off the controls it points at, and above an open window. */
  place() {
    const r = this.lit.map((el) => el.getBoundingClientRect()).filter((x) => x.width);
    const w = window.innerWidth, hgt = window.innerHeight;
    const hit = r.some((x) => x.right > w - 420 && x.bottom > hgt - 400);
    this.card.classList.toggle('left', hit);
    this.card.classList.toggle('over', isDialogOpen());
  }

  render() {
    if (!this.card) return;
    const st = STEPS[this.i];
    const done = st.done && this.isDone();
    const inCh = STEPS.filter((s) => s.ch === st.ch), k = inCh.indexOf(st);
    const c = clear(this.card);
    c.append(
      h('div', { class: 'tut-head' }, h('span', { class: 'tut-count' }, st.ch ? `Chapter ${st.ch} of ${CHAPTERS.length - 1} · ${CHAPTERS[st.ch]}` : 'The tour'),
        h('button', { class: 'dlg-x', type: 'button', 'aria-label': 'Close the tour', onclick: () => this.stop() }, '×')),
      h('div', { class: 'tut-dots', 'aria-hidden': 'true' }, inCh.map((s, j) => h('span', { class: j < k || (j === k && (done || !st.done)) ? 'on' : j === k ? 'cur' : '' }))),
      h('h3', {}, done ? `✓ ${st.title}` : st.title),
      h('p', {}, st.text));
    if (done && (st.after || st.run)) {
      const cell = st.run ? valueCell() : null;
      c.appendChild(h('div', { class: 'tut-result' },
        cell ? h('div', { class: 'inline' }, h('span', { class: `v ${verdictClass(cell.verdict)}` }, cell.verdict), h('span', { class: 'mono small' }, `{${cell.statuses.join(', ')}}`), h('span', { class: 'small muted' }, 'a wrong value at the log')) : null,
        st.after ? h('p', {}, st.after) : null));
    }
    const last = this.i === STEPS.length - 1;
    c.appendChild(h('div', { class: 'tut-actions' },
      this.i ? button('Back', () => this.go(this.i - 1), { small: true, ghost: true }) : null,
      st.done && !done ? button('Do it for me', () => { try { st.doIt(); } catch (e) { /* the parts it needs are not there yet: the text says what to do first */ } this.tick(); }, { small: true }) : null,
      h('span', { class: 'spacer' }),
      last ? button('Finish', () => this.stop(), { primary: true })
        : button(st.done && !done ? 'Skip' : 'Next →', () => this.go(this.i + 1), { primary: !st.done || done, small: st.done && !done })));
  }
}
