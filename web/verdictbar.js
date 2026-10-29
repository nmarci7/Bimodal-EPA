// The verdict bar: once an analysis has run, every log point with its verdicts, in view on every page
// under the top bar. A click opens the point's most severe cell on the Verdicts page.
import { h, clear, verdictClass } from './lib.js';
import { S, on, emit } from './state.js';
import { analysisCurrent } from './flow.js';

const ORDER = ['conflict', 'exposed', 'hope', 'unchecked', 'guarantee', 'not exercised'];

/** The report's cells by log point, in the model's order: [{obs, label, counts, worst}]; worst is the
 * most severe cell (by ORDER). */
export function pointsSummary(rep, doc) {
  const out = new Map();
  for (const c of rep.cells) {
    let p = out.get(c.obs);
    if (!p) {
      const o = ((doc && doc.observation_points) || []).find((x) => x.id === c.obs);
      p = { obs: c.obs, label: (o && o.label) || c.obs, counts: {}, worst: c };
      out.set(c.obs, p);
    }
    p.counts[c.verdict] = (p.counts[c.verdict] || 0) + 1;
    if (ORDER.indexOf(c.verdict) < ORDER.indexOf(p.worst.verdict)) p.worst = c;
  }
  return [...out.values()];
}

export class VerdictBar {
  constructor(el) {
    this.el = el;
    for (const ev of ['report', 'doc', 'evidence', 'loaded', 'analysis']) on(ev, () => this.update());
    this.update();
  }

  update() {
    const rep = S.analysis && S.analysis.report;
    const el = clear(this.el);
    el.hidden = !rep;
    if (!rep) return;
    const current = analysisCurrent();
    el.classList.toggle('stale', !current);
    el.appendChild(h('span', { class: 'vb-title' }, 'Verdicts'));
    for (const p of pointsSummary(rep, S.doc)) {
      el.appendChild(h('button', { class: 'vb-point', title: `${p.label}: open ${p.worst.cell} on the Verdicts page`, onclick: () => emit('focus-cell', p.worst.cell) },
        h('span', { class: 'vb-label' }, p.label),
        ORDER.filter((v) => p.counts[v]).map((v) => h('span', { class: `v ${verdictClass(v)}` }, `${p.counts[v]} ${v}`))));
    }
    if (!current) el.appendChild(h('span', { class: 'vb-stale' }, 'out of date: run the analysis again'));
  }
}
