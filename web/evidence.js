// View 2: the evidence register. Logs become witnesses through recognisers; certificates are
// classified against the model (the LLM rule, decidability, versions); decisions withdraw or reject.
import { h, clear, api, readFile, dropZone, toast, modal } from './lib.js';
import { S, on, emit, persist } from './state.js';

const STATE_CLASS = { 'in force': 'in-force', rejected: 'rejected', stale: 'stale', withdrawn: 'withdrawn', suspended: 'suspended' };

export function fmtAt(at, doc) {
  const conf = (doc && doc.lattices && doc.lattices.confidentiality) || [];
  const auth = (doc && doc.lattices && doc.lattices.authority) || [];
  const rng = ([a, b], names) => {
    const n = (i) => (names ? names[i] ?? i : i);
    return a === b ? `${n(a)}` : `${n(a)}–${n(b)}`;
  };
  const out = [];
  for (const [obs, v] of Object.entries(at || {})) {
    const parts = [];
    for (const [f, r] of Object.entries(v.modes || {})) parts.push(`${f} ${rng(r)}`);
    if (v.taint) parts.push(v.taint[0] === v.taint[1] ? (v.taint[0] ? 'tainted' : 'untainted') : 'taint unknown');
    if (v.conf) parts.push(`conf ${rng(v.conf, conf)}`);
    if (v.auth) parts.push(`authority ${rng(v.auth, auth)}`);
    out.push(`${obs}: ${parts.join(', ') || 'seen'}`);
  }
  return out.join(' · ');
}

export class EvidenceView {
  constructor(host) {
    this.host = host;
    this.register = null;
    this.page = h('div', { class: 'page' });
    host.appendChild(this.page);
    on('loaded', () => this.refresh());
    on('evidence', () => this.refresh());
    on('shown:evidence', () => this.refresh());
    on('check', () => { if (S.view === 'evidence' || !this.register) this.refresh(); });
  }

  // ---------------------------------------------------------------- intake
  recogniserTexts() {
    return { ...(S.bundle ? S.bundle.recognisers : {}), ...(S.evidence.recognisers || {}) };
  }
  deployments() { return S.evidence.deployments || (S.bundle && S.bundle.deployments) || null; }
  lookups() { return { ...(S.bundle ? S.bundle.lookups : {}), ...(S.evidence.lookups || {}) }; }

  async addLog(name, text, fromCase) {
    const recs = Object.values(this.recogniserTexts());
    if (!recs.length) { toast('Add a recogniser first: it says how lines of this log become witnesses.'); return; }
    try {
      const r = await api('/api/evidence/logs', { doc: S.doc, filename: name, text, recognisers: recs, deployments: this.deployments(), lookups: this.lookups() });
      if (!r.witnesses.length && !r.recognisers.length) { toast(`${name}: no recogniser matched this file.`); return; }
      const ids = new Set(r.witnesses.map((w) => w.id));
      S.evidence.witnesses = S.evidence.witnesses.filter((w) => !ids.has(w.id)).concat(r.witnesses.map(strip));
      S.evidence.files = S.evidence.files.filter((f) => f.name !== name).concat([{ name, kind: 'log', fromCase, recognisers: r.recognisers, witnesses: [...ids], unmatched: r.unmatched.length }]);
      toast(`${name}: ${r.witnesses.length} witness(es) via ${r.recognisers.join(', ')}`);
      this.changed();
    } catch (e) { toast(`${name}: ${e.message}`); }
  }

  async addCert(name, text, fromCase) {
    try {
      const r = await api('/api/evidence/certificates', { doc: S.doc, text });
      const ids = new Set(r.certificates.map((c) => c.id));
      S.evidence.certificates = S.evidence.certificates.filter((c) => !ids.has(c.id)).concat(r.certificates.map(strip));
      S.evidence.files = S.evidence.files.filter((f) => f.name !== name).concat([{ name, kind: 'cert', fromCase, certificates: [...ids] }]);
      const st = r.certificates.map((c) => `${c.id} ${c.state}`).join(', ');
      toast(`${name}: ${st}`);
      this.changed();
    } catch (e) { toast(`${name}: ${e.message}`); }
  }

  async addFiles(files, kind) {
    for (const f of files) {
      const text = await readFile(f);
      if (kind === 'cert' || (!kind && /cert|claim|eval/i.test(f.name) && f.name.endsWith('.json'))) await this.addCert(f.name, text, false);
      else if (kind === 'recogniser' || (!kind && /\.(ya?ml)$/i.test(f.name))) { S.evidence.recognisers = { ...(S.evidence.recognisers || {}), [f.name]: text }; toast(`recogniser ${f.name} added`); this.changed(); }
      else if (kind === 'deployments') { S.evidence.deployments = text; toast('deployment manifest added'); this.changed(); }
      else await this.addLog(f.name, text, false);
    }
  }

  async fromCase(path, kind) {
    const text = await api(`/api/cases/${S.caseId}/file?path=${encodeURIComponent(path)}`);
    const name = path.split('/').pop();
    if (kind === 'cert') await this.addCert(name, text, true); else await this.addLog(name, text, true);
  }

  removeFile(f) {
    S.evidence.files = S.evidence.files.filter((x) => x !== f);
    if (f.kind === 'log') { const ids = new Set(f.witnesses); S.evidence.witnesses = S.evidence.witnesses.filter((w) => !ids.has(w.id)); }
    if (f.kind === 'cert') { const ids = new Set(f.certificates); S.evidence.certificates = S.evidence.certificates.filter((c) => !ids.has(c.id)); }
    this.changed();
  }

  changed() { persist(); emit('evidence'); }

  async refresh() {
    if (!S.doc) return;
    if (!S.check || !S.check.ok) { this.register = null; this.render(); return; }
    try { this.register = await api('/api/evidence/register', { doc: S.doc, evidence: S.evidence }); }
    catch (e) { this.register = null; }
    this.render();
  }

  // ---------------------------------------------------------------- drawing
  render() {
    const p = clear(this.page);
    const reg = this.register || { certificates: [], witnesses: [], decisions: [] };
    const count = (list, st) => list.filter((x) => x.state === st).length;
    p.appendChild(h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Evidence register'),
        h('span', { class: 'muted' }, 'evidence narrows the candidates; it never changes the model')),
      h('p', { class: 'hint' }, 'A certificate fixes rows of a guard to never or always for the versions it names. A witness says what one logged interaction delivered at an observation point. Each is in force, or rejected, stale or withdrawn, and the register keeps the reason.'),
      h('div', { class: 'summary' },
        h('span', { class: 'v guarantee' }, `${count(reg.certificates, 'in force')} certificate(s) in force`),
        count(reg.certificates, 'rejected') ? h('span', { class: 'v exposed' }, `${count(reg.certificates, 'rejected')} rejected`) : null,
        count(reg.certificates, 'stale') + count(reg.certificates, 'withdrawn') ? h('span', { class: 'v not-exercised' }, `${count(reg.certificates, 'stale') + count(reg.certificates, 'withdrawn')} stale or withdrawn`) : null,
        h('span', { class: 'v unchecked' }, `${count(reg.witnesses, 'in force')} witness(es) in force`),
        count(reg.witnesses, 'stale') ? h('span', { class: 'v not-exercised' }, `${count(reg.witnesses, 'stale')} stale witness(es)`) : null,
        reg.decisions.length ? h('span', { class: 'v conflict' }, `${reg.decisions.length} decision(s)`) : null)));
    const grid = h('div', { class: 'grid3' });
    grid.append(this.logsPanel(reg), this.certsPanel(reg), this.contextPanel(reg));
    p.appendChild(grid);
  }

  available(list, kind) {
    if (!S.bundle || !list || !list.length) return null;
    const loaded = new Set(S.evidence.files.map((f) => f.name));
    return h('div', { class: 'block' }, h('span', { class: 'section-title' }, `From the ${S.bundle.meta.title} case`),
      h('div', { class: 'avail' }, list.map((path) => {
        const name = path.split('/').pop();
        return h('button', { class: loaded.has(name) ? 'loaded' : '', title: path, onclick: () => this.fromCase(path, kind) }, name);
      })));
  }

  logsPanel(reg) {
    const byId = Object.fromEntries(reg.witnesses.map((w) => [w.id, w]));
    const panel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Logs and traces'), h('span', { class: 'muted' }, 'become witnesses')),
      dropZone('Drop log files here, or click to choose', 'CSV, JSON Lines, JSON or plain text; a recogniser must match the file name', (fs) => this.addFiles(fs, 'log')),
      this.available(S.bundle && S.bundle.logs, 'log'));
    const files = S.evidence.files.filter((f) => f.kind === 'log');
    // witnesses that arrived with a stage, without a file record
    const known = new Set(files.flatMap((f) => f.witnesses));
    const loose = reg.witnesses.filter((w) => !known.has(w.id));
    const groups = files.map((f) => ({ name: f.name, recs: f.recognisers, unmatched: f.unmatched, ws: f.witnesses.map((id) => byId[id]).filter(Boolean), f }));
    const bySrc = {};
    for (const w of loose) { const src = (w.source || 'witnesses').split(' line')[0]; (bySrc[src] = bySrc[src] || []).push(w); }
    for (const [name, ws] of Object.entries(bySrc)) groups.push({ name, recs: [...new Set(ws.map((w) => w.recogniser).filter(Boolean))], ws });
    if (!groups.length) panel.appendChild(h('p', { class: 'empty' }, 'No witnesses yet. Without them every LLM row stays open.'));
    for (const g of groups) panel.appendChild(this.fileCard(g));
    return panel;
  }

  fileCard(g) {
    const body = h('div', { class: 'filecard-body', hidden: true });
    const inForce = g.ws.filter((w) => w.state === 'in force').length;
    const failures = g.ws.filter((w) => Object.values(w.at || {}).some((v) => Object.values(v.modes || {}).some((r) => r[1] > 0) || (v.taint && v.taint[0]))).length;
    for (const w of g.ws) {
      body.appendChild(h('div', { class: 'wit' },
        h('div', { class: 'inline' }, h('b', { class: 'mono' }, w.id), h('span', { class: 'spacer' }), h('span', { class: `state ${STATE_CLASS[w.state] || ''}` }, w.state)),
        h('span', { class: 'mono' }, fmtAt(w.at, S.doc)),
        h('span', { class: 'muted' }, `${w.rule || ''}${w.use_case ? ` · use case ${w.use_case}` : ''}${w.date ? ` · ${w.date}` : ''}`),
        w.state !== 'in force' && w.reason ? h('span', { class: 'muted' }, w.reason) : null,
        w.state === 'in force' ? h('div', {}, h('button', { class: 'btn small', onclick: () => this.rejectWitness(w) }, 'Reject…')) : null));
    }
    const head = h('div', { class: 'filecard-head', onclick: () => { body.hidden = !body.hidden; } },
      h('b', { class: 'mono small' }, g.name), (g.recs || []).map((r) => h('span', { class: 'tag' }, r)), h('span', { class: 'spacer' }),
      h('span', { class: 'small muted' }, `${g.ws.length} witness(es), ${inForce} in force${failures ? `, ${failures} showing a failure` : ''}${g.unmatched ? `, ${g.unmatched} line(s) unmatched` : ''}`),
      g.f ? h('button', { class: 'x', 'aria-label': `remove ${g.name}`, onclick: (e) => { e.stopPropagation(); this.removeFile(g.f); } }, '×') : null);
    return h('div', { class: 'filecard' }, head, body);
  }

  certsPanel(reg) {
    const panel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Certificates'), h('span', { class: 'muted' }, 'fix rows of guards')),
      dropZone('Drop certificate files here, or click to choose', 'JSON or YAML: component, targets or rows, version, issuer, method', (fs) => this.addFiles(fs, 'cert'), '.json,.yaml,.yml'),
      this.available(S.bundle && S.bundle.certificates, 'cert'));
    if (!reg.certificates.length) panel.appendChild(h('p', { class: 'empty' }, 'No certificates. Every decidable guard target stays open: never, sometimes or always.'));
    const conflicts = new Set(((S.analysis && S.analysis.report) ? S.analysis.report.cells : []).flatMap((c) => c.suspended || []));
    for (const c of reg.certificates) {
      const what = Object.entries(c.targets || c.rows || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      const st = conflicts.has(c.id) && c.state === 'in force' ? 'suspended' : c.state;
      panel.appendChild(h('div', { class: 'wit' },
        h('div', { class: 'inline' }, h('b', { class: 'mono' }, c.id), h('span', { class: 'tag guard' }, c.component), h('span', { class: 'spacer' }), h('span', { class: `state ${STATE_CLASS[st] || ''}` }, st)),
        h('span', { class: 'mono' }, `${what}${c.version ? ` · ${c.version}` : ''}`),
        h('span', { class: 'muted' }, `${c.issuer || ''}${c.date ? ` · ${c.date}` : ''}`),
        c.method ? h('span', {}, c.method) : null,
        c.state !== 'in force' && c.reason ? h('span', { style: 'color: var(--e-ink)' }, c.reason) : null,
        st === 'suspended' ? h('span', { style: 'color: var(--c-ink)' }, 'in a minimal conflict with a witness in the last analysis; withdraw it or reject the witness') : null,
        (c.reverify || []).length ? h('span', { style: 'color: var(--h-ink)' }, `re-verify: ${c.reverify.map((x) => (typeof x === 'string' ? x : `${x.component} ${x.signed_with} → ${x.now}`)).join('; ')}`) : null,
        c.state === 'in force' ? h('div', {}, h('button', { class: 'btn small', onclick: () => this.withdraw(c) }, 'Withdraw…')) : null));
    }
    return panel;
  }

  contextPanel(reg) {
    const recs = this.recogniserTexts();
    const panel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Recognisers and context'), h('span', { class: 'muted' }, 'how logs are read')),
      h('p', { class: 'hint' }, 'A recogniser maps the lines of one log format to witnesses at an observation point. The deployment manifest says which versions were live on which day, so a witness from before a change goes stale.'),
      h('div', { class: 'block' }, h('span', { class: 'section-title' }, 'Recognisers'),
        Object.keys(recs).length ? h('div', { class: 'avail' }, Object.keys(recs).map((n) => h('button', { onclick: () => modal(h('div', { class: 'block' }, h('h2', { style: 'margin:0' }, n), h('pre', { class: 'code' }, recs[n]))) }, n.split('/').pop())))
          : h('p', { class: 'hint' }, 'None yet.')),
      dropZone('Drop recogniser YAML here', 'format, files, match, use_case, rules', (fs) => this.addFiles(fs, 'recogniser'), '.yaml,.yml'),
      h('div', { class: 'block' }, h('span', { class: 'section-title' }, 'Deployment manifest'),
        this.deployments() ? h('button', { class: 'btn small', onclick: () => modal(h('div', { class: 'block' }, h('h2', { style: 'margin:0' }, 'Deployments'), h('pre', { class: 'code' }, this.deployments()))) }, 'Show the manifest') : h('p', { class: 'hint' }, 'None: witnesses are taken to be from the current versions.'),
        dropZone('Drop a deployment manifest', 'JSON: dated versions per component', (fs) => this.addFiles(fs, 'deployments'), '.json')));
    const decs = h('div', { class: 'block' }, h('span', { class: 'section-title' }, 'Decisions'));
    if (!S.evidence.decisions.length) decs.appendChild(h('p', { class: 'hint' }, 'None. Withdrawing a certificate or rejecting a witness is recorded here with who and why.'));
    for (const d of S.evidence.decisions) {
      decs.appendChild(h('div', { class: 'wit' }, h('div', { class: 'inline' }, h('b', {}, d.kind === 'withdraw-cert' ? `withdraw ${d.certificate}` : `reject ${d.witness}`), h('span', { class: 'spacer' }),
        h('button', { class: 'x', 'aria-label': 'undo decision', onclick: () => { S.evidence.decisions = S.evidence.decisions.filter((x) => x !== d); this.changed(); } }, '×')),
        h('span', { class: 'muted' }, `${d.by || ''}${d.second_reviewer ? ` and ${d.second_reviewer}` : ''}: ${d.reason || ''}`)));
    }
    panel.appendChild(decs);
    return panel;
  }

  withdraw(c) {
    const by = h('input', { value: 'analyst', style: 'height:34px;border:1px solid var(--line2);border-radius:6px;padding:0 8px' });
    const reason = h('input', { placeholder: 'why the certificate no longer holds', style: 'height:34px;border:1px solid var(--line2);border-radius:6px;padding:0 8px' });
    const close = modal(h('div', { class: 'block' }, h('h2', { style: 'margin:0' }, `Withdraw ${c.id}`),
      h('p', { class: 'hint' }, 'The certificate leaves the register; its rows are open again in the next analysis.'),
      h('label', { class: 'field' }, 'Decided by', by), h('label', { class: 'field' }, 'Reason', reason),
      h('div', {}, h('button', { class: 'btn primary', onclick: () => { S.evidence.decisions.push({ kind: 'withdraw-cert', certificate: c.id, by: by.value, reason: reason.value }); close(); this.changed(); } }, 'Withdraw'))));
  }

  rejectWitness(w) {
    const by = h('input', { value: 'analyst', style: 'height:34px;border:1px solid var(--line2);border-radius:6px;padding:0 8px' });
    const second = h('input', { placeholder: 'a second reviewer (required)', style: 'height:34px;border:1px solid var(--line2);border-radius:6px;padding:0 8px' });
    const reason = h('input', { placeholder: 'why the log line is wrong', style: 'height:34px;border:1px solid var(--line2);border-radius:6px;padding:0 8px' });
    const close = modal(h('div', { class: 'block' }, h('h2', { style: 'margin:0' }, `Reject ${w.id}`),
      h('p', { class: 'hint' }, 'A witness is what happened. Rejecting one says the log is wrong, so it takes two people.'),
      h('label', { class: 'field' }, 'Decided by', by), h('label', { class: 'field' }, 'Second reviewer', second), h('label', { class: 'field' }, 'Reason', reason),
      h('div', {}, h('button', { class: 'btn primary', onclick: () => {
        if (!second.value.trim()) { toast('A rejection needs a second reviewer.'); return; }
        S.evidence.decisions.push({ kind: 'reject-witness', witness: w.id, by: by.value, second_reviewer: second.value, reason: reason.value }); close(); this.changed();
      } }, 'Reject'))));
  }
}

function strip(x) {
  const { state, reason, resolved, reverify, ...rest } = x;
  return rest;
}
