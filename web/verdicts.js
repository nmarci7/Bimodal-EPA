// View 4: the verdict table, cell by cell, with the reasons, the candidates, an example run,
// the certify-next ranking, the claims and the exports.
import { h, clear, api, modal, toast, download, verdictClass } from './lib.js';
import { S, on, emit } from './state.js';
import { fmtAt } from './evidence.js';

const ORDER = ['exposed', 'conflict', 'unchecked', 'hope', 'not exercised', 'guarantee'];
const MEANING = {
  guarantee: 'In every candidate the evidence leaves, the failure never reaches this point.',
  hope: 'In every remaining candidate the failure reaches this point sometimes, never always: an LLM row decides it, and no evidence can make that row never.',
  exposed: 'In every remaining candidate the failure reaches this point whenever the point is used.',
  unchecked: 'The remaining candidates disagree about the failure; the statuses below are what they say.',
  'not exercised': 'No use case sends a message over this point.',
  conflict: 'The evidence contradicts itself for this cell.',
};
const STATUS_WORD = { N: 'never', S: 'sometimes', A: 'always' };

export class VerdictsView {
  constructor(host) {
    this.host = host;
    this.page = h('div', { class: 'page' });
    host.appendChild(this.page);
    this.sel = null;
    on('report', () => { this.sel = null; this.render(); });
    on('shown:verdicts', () => this.render());
    on('focus-cell', (id) => { this.sel = id; emit('show', 'verdicts'); });
  }

  rep() { return S.analysis && S.analysis.report; }

  render() {
    const p = clear(this.page);
    const rep = this.rep();
    if (!rep) {
      p.appendChild(h('div', { class: 'panel' }, h('p', { class: 'empty' }, 'No verdicts yet. Run the analysis; each observation point and failure gets one of guarantee, hope, exposed, unchecked, not exercised or conflict.'),
        h('div', { style: 'text-align:center' }, h('button', { class: 'btn primary', onclick: () => emit('run') }, 'Run analysis'))));
      return;
    }
    const cells = rep.cells.slice().sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
    if (!this.sel || !rep.cells.find((c) => c.cell === this.sel)) this.sel = cells[0] && cells[0].cell;
    const counts = {};
    rep.cells.forEach((c) => { counts[c.verdict] = (counts[c.verdict] || 0) + 1; });
    p.appendChild(h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, `Verdicts for ${rep.model.name}`), h('span', { class: 'muted' }, `${rep.label || ''} · ${rep.seconds} s · clingo ${rep.engine.clingo}${rep.engine.tlc ? ` · TLC ${rep.engine.tlc}` : ''}`)),
      h('div', { class: 'summary' }, ORDER.filter((v) => counts[v]).map((v) => h('span', { class: `v ${verdictClass(v)}` }, `${counts[v]} ${v}`)),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: () => this.export('report.md', 'text/markdown') }, 'Report (Markdown)'),
        h('button', { class: 'btn small', onclick: () => this.export('cra.json', 'application/json') }, 'CRA export (JSON)'))));
    const lay = h('div', { class: 'vlayout' });
    lay.append(this.list(rep), this.detailHost = h('div', { class: 'vdetail' }));
    p.appendChild(lay);
    const grid = h('div', { class: 'grid3' });
    grid.append(this.rankingPanel(rep), this.claimsPanel(rep), this.housekeepingPanel(rep));
    p.appendChild(grid);
    this.detail();
  }

  list(rep) {
    const box = h('div', { class: 'vlist panel' });
    const obs = rep.model.obs;
    for (const [oid, o] of Object.entries(obs)) {
      const cs = rep.cells.filter((c) => c.obs === oid);
      if (!cs.length) continue;
      box.appendChild(h('h3', { class: 'obs-title' }, o.label || oid, ' ', h('span', { class: 'mono' }, `${oid} · ${o.edge}`)));
      for (const c of cs) {
        box.appendChild(h('button', { class: `cellbtn${c.cell === this.sel ? ' active' : ''}`, onclick: () => { this.sel = c.cell; this.render(); } },
          h('span', { class: 'f' }, c.field), h('span', { class: `v ${verdictClass(c.verdict)}` }, c.verdict),
          c.statuses.length ? h('span', { class: 'mono small' }, `{${c.statuses.join(',')}}`) : null,
          h('span', { class: 'r' }, shortReason(c))));
      }
    }
    return box;
  }

  detail() {
    const host = clear(this.detailHost);
    const rep = this.rep();
    const c = rep.cells.find((x) => x.cell === this.sel);
    if (!c) return;
    const o = rep.model.obs[c.obs] || {};
    const panel = h('div', { class: 'panel' });
    panel.append(...[
      h('div', { class: 'panel-head' }, h('h2', { class: 'mono' }, c.cell), h('span', { class: `v ${verdictClass(c.verdict)}` }, c.verdict),
        h('span', { class: 'muted' }, `${{ mode: `failure mode ${c.field}`, taint: 'taint', conf: 'confidentiality', auth: 'authority' }[c.kind] || c.field} at ${o.label || c.obs}`)),
      h('p', { style: 'margin:0;line-height:1.55' }, MEANING[c.verdict]),
      c.statuses.length ? h('div', { class: 'inline' }, h('span', { class: 'small muted' }, 'statuses the candidates give it:'), c.statuses.map((s) => h('span', { class: 'tag plain' }, `${s} ${STATUS_WORD[s]}`)),
        Object.keys(c.per_uc || {}).length > 1 ? h('span', { class: 'small muted' }, `per use case: ${Object.entries(c.per_uc).map(([u, st]) => `${u} {${st.map((x) => (x === 'x' ? 'unused' : x)).join(',')}}`).join(' · ')}`) : null) : null,
      c.advice ? h('div', { class: 'card gen' }, h('span', { class: 'section-title' }, 'What to do'), h('span', {}, c.advice)) : null].filter(Boolean));
    if (c.conflicts.length || c.lacks_path) {
      panel.appendChild(h('div', { class: 'conflictbox' },
        c.lacks_path ? 'The witnesses alone leave no candidate: some run the logs show is not a run of the model. The model lacks a path.'
          : [h('b', {}, 'The evidence was in conflict. '), `Minimal conflict set(s): ${c.conflicts.map((s) => `{${s.join(', ')}}`).join(', ')}. `,
            `The engine suspended ${c.suspended.join(', ')} and decided the cell on the rest. A witness is what happened; the certificate is what someone signed. Withdraw the certificate, or reject the witness with a second reviewer.`]));
    }
    const kv = h('dl', { class: 'kv' });
    const add = (k, v) => { if (v !== null && v !== undefined && v !== '') kv.append(h('dt', {}, k), h('dd', {}, v)); };
    const reasons = c.reasons || {};
    add('Why', [reasons.structural ? 'structural: no candidate the model allows can change it' : null,
      reasons.certificates && reasons.certificates.length ? `rests on ${reasons.certificates.join(', ')}` : null,
      ...(reasons.decisions || []).map((d) => `default dropped on ${d.component}.${d.port} (${d.mode}): "${d.reason}"`)].filter(Boolean).join('; ') || (c.verdict === 'hope' ? 'an LLM row the evidence cannot pin' : null));
    add('Candidates', c.candidates ? `${c.candidates.remaining ?? (c.candidates.at_least ? `more than ${c.candidates.at_least}` : '?')} of ${c.candidates.space} remain` : null);
    add('Open rows in the cone', c.rows.length ? h('span', { class: 'mono small' }, c.rows.join(', ')) : 'none');
    add('Root causes', (c.root_causes || []).length ? h('span', { class: 'mono small' }, c.root_causes.map((s) => (s.length ? `{${s.join(', ')}}` : 'no row needs to fire: the normal flow delivers it')).join('  ')) : null);
    add('Severity', c.severity ? `${c.severity} of 10` : null);
    add('Certificates used', c.certs_used.length ? c.certs_used.join(', ') : null);
    add('Witnesses used', c.witnesses_used.length ? `${c.witnesses_used.length}: ${c.witnesses_used.slice(0, 6).join(', ')}${c.witnesses_used.length > 6 ? ', …' : ''}` : null);
    panel.appendChild(kv);
    const actions = h('div', { class: 'inline' },
      h('button', { class: 'btn small', onclick: () => this.rooms(c, roomsHost) }, 'Show the candidates'),
      c.example_run ? h('button', { class: 'btn small', onclick: () => this.trace(c, traceHost) }, 'Show a reaching run') : null,
      h('button', { class: 'btn small', onclick: () => this.asp(c) }, 'ASP program'),
      h('button', { class: 'btn small', onclick: () => { S.selection = { type: 'obs', id: c.obs }; emit('show', 'model'); emit('select'); } }, 'Show on the canvas'));
    const roomsHost = h('div', { class: 'block' });
    const traceHost = h('div', { class: 'block' });
    panel.append(actions, roomsHost, traceHost);
    host.appendChild(panel);
  }

  async rooms(c, host) {
    clear(host).appendChild(h('p', { class: 'hint' }, 'Enumerating…'));
    try {
      const r = await api(`/api/analyses/${S.analysis.id}/cells/${encodeURIComponent(c.cell)}/possibilities`);
      clear(host);
      const live = r.candidates.filter((x) => !x.struck_by.length);
      host.append(h('span', { class: 'section-title' }, r.remaining_only
          ? `Candidates · ${live.length >= 240 ? 'the first 240' : `all ${live.length}`} remaining of ${r.space}`
          : `Candidates · ${live.length} of ${r.candidates.length} remain`),
        h('p', { class: 'hint' }, r.remaining_only
          ? `Each box is one assignment of never (N), sometimes (S) or always (A) to the open rows that the evidence leaves, with the status it gives the failure here. The space is too large to draw the struck ones; clingo lists the remaining.${r.suspended && r.suspended.length ? ` Suspended: ${r.suspended.join(', ')}.` : ''}`
          : 'Each box is one assignment of never (N), sometimes (S) or always (A) to the open rows, with the status it gives the failure here. A dashed box is struck by the evidence named under it. LLM rows and learned guards have no N.'));
      const grid = h('div', { class: 'rooms' });
      const show = r.candidates.slice().sort((a, b) => (a.struck_by.length > 0) - (b.struck_by.length > 0)).slice(0, 120);
      for (const x of show) {
        const struck = x.struck_by.length > 0;
        grid.appendChild(h('div', { class: `room ${x.status === 'x' ? '' : x.status}${struck ? ' struck' : ''}` },
          h('span', { class: 'act-v' }, Object.entries(x.act).map(([k, v]) => `${k}=${v}`).join(' ') || '(no open row)'),
          h('span', {}, x.status === 'x' ? 'point unused' : `failure ${STATUS_WORD[x.status]}`),
          struck ? h('span', { class: 'muted' }, `struck by ${x.struck_by.slice(0, 3).join(', ')}${x.struck_by.length > 3 ? '…' : ''}`) : null));
      }
      host.appendChild(grid);
      if (r.candidates.length > show.length) host.appendChild(h('p', { class: 'hint' }, `and ${r.candidates.length - show.length} more`));
    } catch (e) { clear(host).appendChild(h('p', { class: 'hint' }, `Not available: ${e.message}. Run the analysis again if the server was restarted.`)); }
  }

  async trace(c, host) {
    clear(host).appendChild(h('p', { class: 'hint' }, 'Reading the run from the TLC state dump…'));
    try {
      const t = await api(`/api/analyses/${S.analysis.id}/cells/${encodeURIComponent(c.cell)}/trace`);
      clear(host);
      if (!t.story.length) { host.appendChild(h('p', { class: 'hint' }, t.note || 'No run to show.')); return; }
      host.append(h('span', { class: 'section-title' }, `A run that reaches the point · use case ${t.run.uc} · rows firing: ${t.run.fire.join(', ') || 'none'}`),
        h('ol', { class: 'story' }, t.story.map((st) => h('li', {}, h('b', {}, st.step), ' ', st.edges.join('; '),
          st.fired && st.fired.length ? h('span', { class: 'fired' }, `  fired: ${st.fired.join(', ')}`) : null))));
    } catch (e) { clear(host).appendChild(h('p', { class: 'hint' }, `Not available: ${e.message}`)); }
  }

  async asp(c) {
    try {
      const text = await api(`/api/analyses/${S.analysis.id}/cells/${encodeURIComponent(c.cell)}/asp`);
      modal(h('div', { class: 'block' }, h('h2', { style: 'margin:0' }, `ASP program for ${c.cell}`), h('pre', { class: 'code' }, text)));
    } catch (e) { toast(e.message); }
  }

  rankingPanel(rep) {
    const panel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Certify next'), h('span', { class: 'muted' }, 'which guard to certify first')),
      h('p', { class: 'hint' }, 'Each guard, and each pair, as if certified now: the key is the severity of the most severe failure it would turn into a guarantee. Learned guards score 0: the LLM rule forbids never.'));
    const rk = rep.ranking || [];
    if (!rk.length) panel.appendChild(h('p', { class: 'hint' }, 'Nothing left to certify that would change a verdict.'));
    for (const a of rk.slice(0, 12)) {
      panel.appendChild(h('div', { class: 'rank' }, h('span', { class: 'key' }, a.key), h('b', {}, a.action.join(' + ')),
        h('span', { class: 'small' }, a.moved.length ? `moves ${a.moved.map((m) => m.cell).join(', ')}` : h('span', { class: 'muted' }, a.note))));
    }
    return panel;
  }

  claimsPanel(rep) {
    const panel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Claims'), h('span', { class: 'muted' }, 'what the teams assert')));
    if (!rep.claims.length) panel.appendChild(h('p', { class: 'hint' }, 'No claims in the model. A claim states the verdict a team asserts for a cell; the engine says whether the evidence supports it.'));
    const J = { supported: 'guarantee', refuted: 'exposed', unsupported: 'unchecked', vacuous: 'not-exercised' };
    for (const cl of rep.claims) {
      panel.appendChild(h('div', { class: 'wit' }, h('div', { class: 'inline' }, h('b', { class: 'mono' }, cl.cell), h('span', { class: 'spacer' }), h('span', { class: `v ${J[cl.judgement] || ''}`, style: 'font-size:12px' }, cl.judgement)),
        h('span', { class: 'muted' }, `${cl.by || 'someone'} claims ${cl.verdict || 'guarantee'}${cl.verdict_now ? `; the verdict is ${cl.verdict_now}` : ''}${cl.note ? ` · "${cl.note}"` : ''}`)));
    }
    return panel;
  }

  housekeepingPanel(rep) {
    const panel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Re-verify and gaps'), h('span', { class: 'muted' }, 'what changed, what is missing')));
    if (rep.reverify.length) {
      panel.appendChild(h('span', { class: 'section-title' }, 'Certificates signed against older versions'));
      for (const r of rep.reverify) panel.appendChild(h('div', { class: 'wit' }, h('b', { class: 'mono' }, r.certificate), h('span', {}, r.changes.map((x) => `${x.component}: signed with ${x.signed_with}, now ${x.now}`).join('; ')),
        h('span', { class: 'muted' }, 'still in force (the guard is unchanged), but its upstream changed: re-run its verification')));
    } else panel.appendChild(h('p', { class: 'hint' }, 'No certificate was signed against a version that has since changed.'));
    if (rep.unmatched.length) {
      panel.appendChild(h('span', { class: 'section-title' }, 'Failures absorbed without a row'));
      panel.appendChild(h('p', { class: 'hint' }, 'These modes can arrive at a deterministic component that has no row and no pass-through for them, so the model drops them silently. That is optimistic; add a row or a pass-through if the component can forward them.'));
      panel.appendChild(h('ul', { class: 'story' }, rep.unmatched.map((u) => h('li', {}, h('span', { class: 'mono small' }, `${u.mode} at ${u.component}.${u.port}`)))));
    }
    const rej = rep.register.certificates.filter((c) => c.state !== 'in force');
    if (rej.length) {
      panel.appendChild(h('span', { class: 'section-title' }, 'Certificates not in force'));
      for (const c of rej) panel.appendChild(h('div', { class: 'wit' }, h('div', { class: 'inline' }, h('b', { class: 'mono' }, c.id), h('span', { class: 'spacer' }), h('span', { class: `state ${c.state === 'rejected' ? 'rejected' : 'stale'}` }, c.state)), h('span', { class: 'muted' }, c.reason)));
    }
    return panel;
  }

  async export(kind, type) {
    try {
      const r = await fetch(`/api/analyses/${S.analysis.id}/${kind}`);
      if (!r.ok) throw new Error('the server no longer has this analysis; run it again');
      const text = kind.endsWith('json') ? JSON.stringify(await r.json(), null, 2) : await r.text();
      download(`${(this.rep().model.name || 'epa')}-${kind}`, text, type);
    } catch (e) { toast(e.message); }
  }
}

function shortReason(c) {
  const r = c.reasons || {};
  if (c.suspended && c.suspended.length) return `suspended ${c.suspended.join(', ')}`;
  if (r.structural) return 'structural';
  if (r.certificates && r.certificates.length) return `rests on ${r.certificates.join(', ')}`;
  if (c.verdict === 'unchecked' && c.candidates) return `${c.candidates.remaining ?? `${c.candidates.at_least}+`} candidates`;
  if (c.verdict === 'hope') return 'an LLM row';
  return '';
}
