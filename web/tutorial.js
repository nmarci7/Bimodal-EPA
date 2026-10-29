// The tutorial: a card in the corner that builds a first model in seven steps (tutorial-steps.js), one
// button each, runs the analysis after every step without leaving the page, and says what the
// verdict means.
import { h, clear, verdictClass } from './lib.js';
import { S, on, emit, cloneDoc, commitDoc, runCheck, persist } from './state.js';
import { button, confirmDialog } from './dialog.js';
import { CELL, STEPS } from './tutorial-steps.js';

export class Tutorial {
  /** load(doc, evidence): replaces the model and the evidence (app.js setDoc, forgetting any case). */
  constructor({ load }) {
    this.load = load;
    this.card = null;
    this.waiting = null;
    on('report', () => { if (this.waiting) { const w = this.waiting; this.waiting = null; w(); } });
  }

  async start() {
    if (this.card) return;
    if (S.doc && S.doc.components.length && S.doc.name !== 'my-first-model') {
      const ok = await confirmDialog('The tutorial starts a new model. Export the one you have first if you want to keep it (File → Export).', { title: 'Start the tutorial', okText: 'Start' });
      if (!ok) return;
    }
    this.i = 0; this.phase = 'ready';
    this.card = h('aside', { class: 'tutorial', 'aria-label': 'Tutorial' });
    document.body.appendChild(this.card);
    this.render();
  }

  stop() { if (this.card) this.card.remove(); this.card = null; this.waiting = null; }

  async step() {
    const st = STEPS[this.i];
    this.phase = 'running'; this.render();
    const cur = { doc: S.doc ? cloneDoc() : null, ev: { certificates: [...S.evidence.certificates], witnesses: [...S.evidence.witnesses], decisions: [...S.evidence.decisions] } };
    const next = st.apply(cur);
    if (this.i === 0) this.load(next.doc, next.ev);
    else {
      S.evidence = { ...S.evidence, ...next.ev };
      commitDoc(next.doc, next.sel);
      emit('evidence');
      persist();
    }
    if (next.sel && this.i === 0) { S.selection = next.sel; emit('select'); }
    await runCheck();
    const done = new Promise((r) => { this.waiting = r; });
    emit('run', { quiet: true });
    await done;
    this.phase = 'done'; this.render();
  }

  render() {
    if (!this.card) return;
    const st = STEPS[this.i], last = this.i === STEPS.length - 1;
    const c = clear(this.card);
    c.append(h('div', { class: 'tut-head' }, h('span', { class: 'tut-count' }, `Tutorial · step ${this.i + 1} of ${STEPS.length}`),
      h('button', { class: 'dlg-x', type: 'button', 'aria-label': 'Close the tutorial', onclick: () => this.stop() }, '×')),
    h('div', { class: 'tut-dots', 'aria-hidden': 'true' }, STEPS.map((_, k) => h('span', { class: k < this.i || (k === this.i && this.phase === 'done') ? 'on' : k === this.i ? 'cur' : '' }))),
    h('h3', {}, st.title), h('p', {}, st.text));
    if (this.phase !== 'done') {
      c.appendChild(h('div', { class: 'tut-actions' }, button(this.phase === 'running' ? 'Running the analysis…' : st.act, () => this.step(), { primary: true, disabled: this.phase === 'running' })));
      return;
    }
    const rep = S.analysis && S.analysis.report;
    const cell = rep && rep.cells.find((x) => x.cell === CELL);
    c.appendChild(h('div', { class: 'tut-result' },
      cell ? h('div', { class: 'inline' }, h('span', { class: `v ${verdictClass(cell.verdict)}` }, cell.verdict), h('span', { class: 'mono small' }, `{${cell.statuses.join(', ')}}`), h('span', { class: 'small muted' }, 'wrong value in the order log'))
        : h('b', {}, 'The analysis did not finish: see 3 Analysis.'),
      h('p', {}, st.result)));
    c.appendChild(h('div', { class: 'tut-actions' },
      button('Show on the Verdicts page', () => emit('focus-cell', CELL), { small: true, ghost: true }),
      h('span', { class: 'spacer' }),
      last ? button('Finish', () => this.finish(), { primary: true }) : button('Next step →', () => { this.i += 1; this.phase = 'ready'; this.render(); }, { primary: true })));
  }

  finish() {
    const c = clear(this.card);
    c.append(h('div', { class: 'tut-head' }, h('span', { class: 'tut-count' }, 'Tutorial · done'),
      h('button', { class: 'dlg-x', type: 'button', 'aria-label': 'Close the tutorial', onclick: () => this.stop() }, '×')),
    h('h3', {}, 'That is the whole loop'),
    h('p', {}, 'Model → evidence → analysis → verdict, and again. You saw all four answers: unchecked, always (exposed), never (guarantee) and sometimes (hope).'),
    h('p', {}, 'Next: open a demo case from the picker, or start your own with File → New model.'),
    h('div', { class: 'tut-actions' }, h('span', { class: 'spacer' }), button('Close', () => this.stop(), { primary: true })));
  }
}
