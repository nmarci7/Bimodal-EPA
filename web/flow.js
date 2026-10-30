// The workflow strip in the top bar: Model → Evidence → Analysis → Verdicts. Each step says what it
// is for (its tooltip) and where it stands: the model check, the evidence, the last run (and whether
// the model or the evidence changed since), the verdicts. Clicking a step shows its view; app.js
// marks the active one (show) and the verdicts dot.
import { h } from './lib.js';
import { S, on, emit, analysisBasis } from './state.js';

export const STEPS = [
  { view: 'model', n: 1, name: 'Model', purpose: 'Draw the system: components, edges, what each component does with failures (rows), guards, and the points where logs are read.' },
  { view: 'evidence', n: 2, name: 'Evidence', purpose: 'What you know: certificates from the teams, witnesses from the logs, and the decisions taken on them.' },
  { view: 'analysis', n: 3, name: 'Analysis', purpose: 'How the verdicts are computed: TLC runs every switch vector of the rows that matter in every firing order, clingo keeps the candidates the evidence allows. Watch a run here, with its log and its cones.' },
  { view: 'verdicts', n: 4, name: 'Verdicts', purpose: 'The answer: for each log point and failure, what the evidence leaves possible, why, and what to certify next.' },
];

const ORDER = ['conflict', 'exposed', 'hope', 'unchecked', 'guarantee', 'not exercised'];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Whether the last finished run was on the model and evidence as they are now. */
export function analysisCurrent() {
  return !!(S.analysis && S.analysis.report && S.analysis.basis === analysisBasis());
}

/** Where a step stands -> {text, tone}; tone: ok | warn | todo | busy | '' (neutral). */
export function stepStatus(view) {
  if (view === 'model') {
    if (!S.doc) return { text: 'no model yet', tone: 'todo' };
    const n = plural(S.doc.components.length, 'component', 'components');
    if (!S.check) return { text: `${n} · checking…`, tone: 'busy' };
    if (!S.check.ok) return { text: plural(S.check.problems.length, 'problem', 'problems'), tone: 'warn' };
    return { text: `${n} · well-formed`, tone: 'ok' };
  }
  if (view === 'evidence') {
    const c = S.evidence.certificates.length, w = S.evidence.witnesses.length;
    if (!c && !w) return { text: 'none yet', tone: 'todo' };
    return { text: `${plural(c, 'certificate', 'certificates')} · ${plural(w, 'witness', 'witnesses')}`, tone: '' };
  }
  const a = S.analysis;
  if (view === 'analysis') {
    if (!a) return { text: 'not run yet', tone: 'todo' };
    if (a.status === 'running') return { text: 'running…', tone: 'busy' };
    if (a.status === 'error' || !a.report) return { text: 'failed', tone: 'warn' };
    if (!analysisCurrent()) return { text: 'out of date: run again', tone: 'warn' };
    return { text: `done in ${a.report.seconds} s`, tone: 'ok' };
  }
  if (!a || !a.report) return { text: a && a.status === 'running' ? 'coming…' : 'after the analysis', tone: a && a.status === 'running' ? 'busy' : 'todo' };
  const counts = {};
  a.report.cells.forEach((c) => { counts[c.verdict] = (counts[c.verdict] || 0) + 1; });
  const text = ORDER.filter((v) => counts[v]).map((v) => `${counts[v]} ${v}`).join(' · ') || 'no cells';
  return { text: analysisCurrent() ? text : `old: ${text}`, tone: analysisCurrent() ? '' : 'warn' };
}

export class FlowBar {
  constructor(nav) {
    this.nav = nav;
    this.status = {};
    for (const [i, s] of STEPS.entries()) {
      if (i) nav.appendChild(h('span', { class: 'step-arrow', 'aria-hidden': 'true' }, '→'));
      const st = h('span', { class: 'step-s' });
      this.status[s.view] = st;
      nav.appendChild(h('button', { class: 'tab step', 'data-view': s.view, title: s.purpose, onclick: () => emit('show', s.view) },
        h('span', { class: 'step-n' }, String(s.n)),
        h('span', { class: 'step-t' }, h('span', { class: 'step-name' }, s.name), st)));
    }
    for (const ev of ['check', 'doc', 'evidence', 'loaded', 'report', 'analysis']) on(ev, () => this.update());
    this.update();
  }

  update() {
    for (const s of STEPS) {
      const { text, tone } = stepStatus(s.view);
      const el = this.status[s.view];
      el.textContent = text;
      el.className = `step-s${tone ? ` ${tone}` : ''}`;
      el.parentElement.parentElement.setAttribute('aria-label', `${s.n} ${s.name}: ${text}`);
    }
  }
}
