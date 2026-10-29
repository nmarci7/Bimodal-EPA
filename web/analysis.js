// View 3: the run. The coordinator's events arrive as they happen: cones, TLC calls, ASP decisions.
import { h, clear, api, modal, toast } from './lib.js';
import { S, on, emit, persist, analysisBasis } from './state.js';
import { analysisCurrent } from './flow.js';

const STAGES = [
  { id: 'input', k: 'Input', title: 'Model and evidence', cls: '', steps: ['model', 'evidence'] },
  { id: 'cones', k: 'Relevance', title: 'Cells and cones', cls: '', steps: ['cells', 'cone'] },
  { id: 'tlc', k: 'Alethic · TLA+ / TLC', title: 'Runs of each firing choice', cls: 'alethic', steps: ['tlc', 'tlc-done'] },
  { id: 'asp', k: 'Epistemic · ASP / clingo', title: 'Candidates the evidence leaves', cls: 'epistemic', steps: ['verdict', 'conflict'] },
  { id: 'out', k: 'Output', title: 'Verdicts and what to certify next', cls: 'out', steps: ['ranking', 'done'] },
];

export class AnalysisView {
  constructor(host) {
    this.host = host;
    this.page = h('div', { class: 'page' });
    host.appendChild(this.page);
    this.events = [];
    this.render();
    on('shown:analysis', () => this.render());
  }

  /** Runs the analysis; quiet keeps the current page (the tutorial), else the Analysis page shows it. */
  async run({ quiet } = {}) {
    if (!S.doc) return;
    if (S.check && !S.check.ok) { toast('The model is not well-formed yet; see the problems in the inspector.'); emit('show', 'model'); return; }
    this.events = []; this.status = 'running'; this.error = null;
    const basis = analysisBasis();
    S.analysis = { id: null, status: 'running', report: null };
    emit('analysis');
    if (!quiet) emit('show', 'analysis');
    this.render();
    let id;
    try {
      ({ id } = await api('/api/analyses', { doc: S.doc, evidence: { certificates: S.evidence.certificates, witnesses: S.evidence.witnesses, decisions: S.evidence.decisions }, label: S.stage ? `${S.caseId} ${S.stage}` : S.doc.name }));
    } catch (e) { this.status = 'error'; this.error = e.message; S.analysis = { id: null, status: 'error', report: null, error: e.message }; this.render(); emit('report'); return; }
    S.analysis.id = id;
    const es = new EventSource(`/api/analyses/${id}/events`);
    es.onmessage = (m) => { this.events.push(JSON.parse(m.data)); this.renderLive(); };
    es.addEventListener('end', async (m) => {
      es.close();
      const end = JSON.parse(m.data);
      const full = await api(`/api/analyses/${id}`);
      S.analysis = { id, status: full.status, report: full.report, error: full.error, basis };
      this.status = full.status; this.error = full.error;
      persist();
      this.render();
      emit('report');
      if (end.status === 'done') toast(`Analysis done in ${full.report.seconds} s: ${full.report.cells.length} cells, ${full.report.tlc_calls.length} TLC call(s).`);
    });
    es.onerror = () => { /* the end event closes the stream; a dropped connection is retried by the browser */ };
  }

  stageState() {
    const seen = new Set(this.events.map((e) => e.step));
    const last = this.events.length ? this.events[this.events.length - 1].step : null;
    return STAGES.map((st) => ({ ...st, live: st.steps.includes(last) && this.status === 'running', done: st.steps.some((x) => seen.has(x)) }));
  }

  stageValue(st) {
    const ev = this.events;
    const lastOf = (step) => [...ev].reverse().find((e) => e.step === step);
    if (st.id === 'input') { const e = lastOf('evidence'); const m = lastOf('model'); return [m && m.msg.replace(/^model \S+: /, ''), e && e.msg].filter(Boolean).join('; '); }
    if (st.id === 'cones') { const e = lastOf('cells'); const n = ev.filter((x) => x.step === 'cone').length; return e ? `${e.msg}${n ? `; ${n} cone(s) visited` : ''}` : ''; }
    if (st.id === 'tlc') {
      const runs = ev.filter((x) => x.step === 'tlc-done');
      if (!runs.length) return ev.some((x) => x.step === 'cone') ? 'certificates and the cache answer without a new run' : '';
      const states = runs.reduce((a, x) => a + (x.distinct || 0), 0);
      return `${runs.length} TLC call(s), ${states.toLocaleString()} distinct states${runs.some((x) => x.cached) ? ' (some cached)' : ''}`;
    }
    if (st.id === 'asp') {
      const v = ev.filter((x) => x.step === 'verdict').length, c = ev.filter((x) => x.step === 'conflict').length;
      return v ? `${v} cell(s) decided${c ? `; ${c} conflict(s) found and resolved` : ''}` : '';
    }
    if (st.id === 'out') { const d = lastOf('done'); return d ? d.msg : (lastOf('ranking') || {}).msg || ''; }
    return '';
  }

  renderLive() {
    if (!this.pipe) return this.render();
    this.drawPipeline();
    this.drawLog();
  }

  drawPipeline() {
    clear(this.pipe);
    this.stageState().forEach((st, i) => {
      if (i) this.pipe.appendChild(h('div', { class: 'chev', 'aria-hidden': 'true' }, '›'));
      this.pipe.appendChild(h('div', { class: `stage ${st.cls}${st.live ? ' live' : ''}`, style: st.done || this.status !== 'running' ? '' : 'opacity:.55' },
        h('span', { class: 'k' }, st.k), h('b', {}, st.title), h('span', { class: 'v' }, this.stageValue(st) || (this.status === 'running' ? 'waiting…' : '—'))));
    });
  }

  drawLog() {
    clear(this.log);
    const evs = this.events.length ? this.events : ((S.analysis && S.analysis.report && S.analysis.report.log) || []);
    for (const e of evs) {
      const cls = e.step === 'conflict' ? 'conflict' : e.step.startsWith('tlc') ? 'tlc' : e.step === 'verdict' ? 'verdict' : '';
      this.log.appendChild(h('div', { class: cls }, h('span', { class: 't' }, `${(e.t || 0).toFixed(2)}s`), h('span', { class: 's' }, e.step), e.msg));
    }
    this.log.scrollTop = this.log.scrollHeight;
  }

  render() {
    const p = clear(this.page);
    const rep = S.analysis && S.analysis.report;
    if (!this.events.length && rep) this.events = rep.log || [];
    if (!this.status && S.analysis) this.status = S.analysis.status;
    const done = rep && this.status !== 'running';
    p.appendChild(h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Analysis: how the verdicts are computed'),
        h('span', { class: 'muted' }, this.status === 'running' ? 'running…' : rep ? `last run: ${rep.seconds} s, ${rep.tlc_calls.length} TLC call(s), ${rep.cells.length} cells` : 'not run yet')),
      h('p', { class: 'hint' }, 'This page shows the engine at work; the answer itself is on 4 Verdicts.',
        h('span', { class: 'detail' }, ' For every observation point and failure the engine takes the rows that can matter (the cone), lets TLC run every firing choice of those rows for every use case, and hands the runs to clingo. Candidates are assignments of never, sometimes or always to the open rows; certificates and witnesses strike the ones they contradict; the statuses the remaining candidates give the failure are the verdict.')),
      done && !analysisCurrent() ? h('div', { class: 'problems' }, 'The model or the evidence changed after this run: the verdicts are out of date until you run it again.') : null,
      h('div', { class: 'inline' },
        h('button', { class: `btn${done && analysisCurrent() ? '' : ' primary'}`, disabled: this.status === 'running' ? true : undefined, onclick: () => this.run() }, this.status === 'running' ? 'Running…' : rep ? 'Run again' : 'Run analysis'),
        done ? h('button', { class: `btn${analysisCurrent() ? ' primary' : ''}`, onclick: () => emit('show', 'verdicts') }, 'See the verdicts →') : null)));
    this.pipe = h('div', { class: 'pipeline' });
    p.appendChild(this.pipe);
    this.drawPipeline();
    if (this.error) p.appendChild(h('div', { class: 'problems' }, h('b', {}, 'The analysis failed. '), h('pre', { class: 'code', style: 'margin-top:8px' }, this.error)));
    const why = nothingToJudge();
    if (why && this.status !== 'running') p.appendChild(h('div', { class: 'problems' }, h('b', {}, 'Nothing to judge yet. '), why));
    this.log = h('div', { class: 'log', role: 'log', 'aria-live': 'polite' });
    const grid = h('div', { class: 'grid2' });
    grid.append(h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Coordinator log'), h('span', { class: 'muted' }, 'every step, as it happened')), this.log),
      this.conesPanel(rep));
    p.appendChild(grid);
    this.drawLog();
  }

  conesPanel(rep) {
    const panel = h('section', { class: 'panel detail' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Cones and TLC runs'), h('span', { class: 'muted' }, 'one TLA+ module per cone')));
    if (!rep) { panel.appendChild(h('p', { class: 'empty' }, this.status === 'running' ? 'The cones appear when the run ends.' : 'Run the analysis to see which rows each observation point depends on and what TLC explored.')); return panel; }
    const cells = Object.fromEntries(rep.cells.map((c) => [c.cell, c]));
    for (const k of rep.cones) {
      const calls = rep.tlc_calls.filter((c) => c.cone === k.key);
      const card = h('div', { class: 'cone' },
        h('div', { class: 'inline' }, h('b', { class: 'mono' }, k.obs), h('span', { class: 'small muted' }, `${k.cells.length} cell(s) · ${k.rows.length} open row(s) · use cases ${k.use_cases.join(', ')}`)),
        h('div', { class: 'inline' }, k.cells.map((c) => h('span', { class: `v ${(cells[c] || {}).verdict ? cells[c].verdict.replace(' ', '-') : ''}`, style: 'font-size:12px' }, `${c.split('@')[0]}: ${(cells[c] || {}).verdict || '?'}`))),
        h('span', { class: 'mono small', style: 'overflow-wrap:anywhere' }, k.rows.length ? `rows: ${k.rows.join(', ')}` : 'no open row can change these cells'),
        k.always && k.always.length ? h('span', { class: 'mono small muted' }, `fixed always: ${k.always.join(', ')}`) : null,
        h('span', { class: 'small muted' }, `components: ${k.components.join(', ')}`));
      if (!calls.length) card.appendChild(h('span', { class: 'small', style: 'color: var(--g-ink)' }, 'no TLC call in this analysis: the runs were cached or no row is open'));
      for (const c of calls) {
        card.appendChild(h('div', { class: 'inline small' }, h('span', { class: 'tag' }, `TLC ${c.tlc_version || ''}`.trim()),
          h('span', {}, `${c.vectors >= 0 ? c.vectors : 'many'} firing choice(s) · ${(c.distinct || 0).toLocaleString()} distinct states · depth ${c.depth} · ${c.runs} runs · ${c.cached ? 'cached' : `${c.seconds} s`}`),
          h('button', { class: 'btn small', onclick: () => this.showTla(c.hash) }, 'Generated TLA+')));
      }
      card.appendChild(h('div', { class: 'inline' }, k.cells.map((c) => h('button', { class: 'btn small', onclick: () => this.showAsp(c) }, `ASP for ${c.split('@')[0]}`))));
      panel.appendChild(card);
    }
    return panel;
  }

  async showTla(hash) {
    try {
      const t = await api(`/api/tla/${hash}`);
      const tabs = { 'Cone.tla': t.module, 'Cone.cfg': t.cfg, 'EpaLib.tla': t.library, 'TLC output': t.stats };
      const pre = h('pre', { class: 'code' }, t.module);
      modal(h('div', { class: 'block' }, h('h2', { style: 'margin:0' }, 'The module TLC checked'),
        h('p', { class: 'hint' }, 'Generated from the model for this cone. Init chooses a use case and a firing choice; Next applies one synchronous round until nothing changes. TLC dumps every state; the engine reads the terminal ones.'),
        h('div', { class: 'avail' }, Object.keys(tabs).map((k) => h('button', { onclick: () => { pre.textContent = tabs[k]; } }, k))), pre));
    } catch (e) { toast(e.message); }
  }

  async showAsp(cell) {
    try {
      const text = await api(`/api/analyses/${S.analysis.id}/cells/${encodeURIComponent(cell)}/asp`);
      modal(h('div', { class: 'block' }, h('h2', { style: 'margin:0' }, `ASP program for ${cell}`),
        h('p', { class: 'hint' }, 'The runs as facts, the candidate choice with the LLM rule, the certificate and witness constraints, and the status of the failure. clingo reasons bravely over the stable models.'),
        h('pre', { class: 'code' }, text)));
    } catch (e) { toast(e.message); }
  }
}

/** Why a well-formed model gives no cell: the verdicts are per observation point and judged failure. */
function nothingToJudge() {
  const d = S.doc, ch = S.check;
  if (!d || !ch || !ch.ok || (ch.cells || []).length) return null;
  if (!d.observation_points.length) return 'The model has no observation point, and verdicts are given only there. Drop an eye (palette: Observation point) on the edge whose log you would read, then run again.';
  return 'No observation point judges a failure. Select an eye and tick the failures it judges (its toleration), or the provenance it checks, then run again.';
}
