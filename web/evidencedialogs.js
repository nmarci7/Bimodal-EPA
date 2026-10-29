// Dialogs for the evidence register: write a certificate or a witness by hand (step by step), look
// at one in detail, withdraw a certificate, reject a witness. A hand-made certificate or witness can
// be edited and deleted; one that came from a file can only be withdrawn or rejected, with the
// reason recorded, because it is a record someone else made.
//
// A certificate (docs/model-format.md, "Evidence") fixes rows of one component: guard targets
// (targets: {key: never|sometimes|always}) or rows by id. A witness says what one interaction
// delivered at observation points: {at: {point: {modes: {f: [lo, hi]}, taint, conf, auth}}}.
// The server classifies both against the model before they go in.
import { h, clear, add, api, toast } from './lib.js';
import { S, emit, persist, modeFields, comp, details } from './state.js';
import { wizard, openDialog, field, textInput, numberInput, selectInput, checkInput, button, confirmDialog } from './dialog.js';
import { rowSentence } from './rows.js';

const WORDS = [['never', 'never'], ['sometimes', 'sometimes'], ['always', 'always']];
const today = () => new Date().toISOString().slice(0, 10);
const STATE_CLASS = { 'in force': 'in-force', rejected: 'rejected', stale: 'stale', withdrawn: 'withdrawn', suspended: 'suspended' };

function changed() { persist(); emit('evidence'); }
function strip(x) { const { state, reason, resolved, reverify, ...rest } = x; return rest; }
export function stateChip(st) { return h('span', { class: `state ${STATE_CLASS[st] || ''}` }, st); }

// ---------------------------------------------------------------- certificates

/** The rows a certificate on this component could state: its open rows, as the model check lists them. */
function certRows(cid) {
  const rows = Object.values((S.check && S.check.ok && S.check.summary.rows) || {}).filter((r) => r.comp === cid && r.open);
  return rows.sort((a, b) => (a.kind === 'leak' ? 0 : 1) - (b.kind === 'leak' ? 0 : 1) || a.id.localeCompare(b.id));
}

function rowWords(r, c) {
  if (r.kind === 'leak') return `the guard lets ${r.id.split('.').slice(2).join('.')} through (its leak row)`;
  if (r.kind === 'fp') return 'the guard refuses a harmless message (false positive)';
  if (r.kind === 'default') { const [, cid, q, m] = r.id.split('.'); return `on any message ${cid} sends ${m} at 10 on ${q} (worst-case default)`; }
  const own = c && (c.rows || []).find((x) => x.id === r.id);
  return own ? rowSentence(own, c) : r.id;
}

/**
 * Write a certificate step by step, or edit a hand-made one (id).
 * The statements are kept as {row id: word}; a guard's leak rows are written as targets.
 */
export function openCertDialog(certId) {
  if (!S.check || !S.check.ok) { toast('Fix the model first: a certificate is classified against it.'); return; }
  const old = certId ? S.evidence.certificates.find((c) => c.id === certId) : null;
  const mode = old ? 'edit' : 'add';
  const sumComps = S.check.summary.components;
  const certifiable = Object.entries(sumComps).filter(([id]) => certRows(id).length).map(([id, c]) => ({ id, ...c }));
  const taken = new Set(S.evidence.certificates.map((c) => c.id).filter((x) => x !== certId));
  let n = 1; while (taken.has(`c_manual_${n}`)) n++;
  const data = {
    id: old ? old.id : `c_manual_${n}`,
    component: old ? old.component : (certifiable.find((c) => c.kind === 'guard') || certifiable[0] || {}).id,
    stated: {}, version: old ? old.version || '' : null, issuer: old ? old.issuer || '' : '', date: old ? old.date || '' : today(),
    method: old ? old.method || '' : '', evidence: old ? old.evidence || '' : '', scope: new Set(old ? old.scope || [] : []), context: { ...(old ? old.context || {} : {}) },
    review: null,
  };
  const resolveOld = () => {
    if (!old) return;
    const comp0 = old.component;
    for (const [k, v] of Object.entries(old.targets || {})) data.stated[`leak.${comp0}.${k}`] = word(v);
    for (const [k, v] of Object.entries(old.rows || {})) {
      const ids = Object.keys(S.check.summary.rows);
      const rid = ids.includes(k) ? k : [`${comp0}.${k}`, `leak.${comp0}.${k}`, `default.${comp0}.${k}`].find((x) => ids.includes(x)) || k;
      data.stated[rid] = word(v);
    }
  };
  resolveOld();
  const compVersion = () => (sumComps[data.component] || {}).version || '';
  if (data.version === null) data.version = compVersion();

  const record = () => {
    const targets = {}, rows = {};
    for (const [rid, w] of Object.entries(data.stated)) {
      if (!w) continue;
      const pre = `leak.${data.component}.`;
      if (rid.startsWith(pre)) targets[rid.slice(pre.length)] = w; else rows[rid] = w;
    }
    const c = { id: data.id.trim(), component: data.component };
    if (Object.keys(targets).length) c.targets = targets;
    if (Object.keys(rows).length) c.rows = rows;
    if (data.version.trim()) c.version = data.version.trim();
    for (const k of ['issuer', 'date', 'method', 'evidence']) if (data[k] && data[k].trim()) c[k] = data[k].trim();
    if (data.scope.size) c.scope = [...data.scope];
    if (Object.keys(data.context).length) c.context = { ...data.context };
    return c;
  };

  const what = (ctx) => {
    const sel = h('select', { onchange: (e) => { data.component = e.target.value; data.stated = {}; data.version = compVersion(); data.context = {}; ctx.rerender(); } });
    const groups = [['Guards', certifiable.filter((c) => c.kind === 'guard')], ['Components', certifiable.filter((c) => c.kind !== 'guard')]];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      sel.appendChild(h('optgroup', { label }, list.map((c) => h('option', { value: c.id, selected: c.id === data.component ? true : undefined },
        details() ? `${c.id}${c.label ? ` — ${c.label}` : ''}${c.version ? ` (${c.version})` : ''}` : (c.label || c.id)))));
    }
    const c = sumComps[data.component] || {};
    return h('div', { class: 'block' }, field('The guard or component it is about', sel, 'Only what has open rows can be certified: a certificate fixes the activation of some of them.', { wide: true }),
      data.component ? h('p', { class: 'hint' }, c.kind === 'guard' ? `${data.component} is a ${c.learned ? 'learned ' : ''}guard on ${c.on_edge || 'an edge'}${c.learned ? ': no certificate can say it never leaks' : ''}.` : `${data.component} is a ${c.kind} component.`) : null);
  };

  const statements = (ctx) => {
    const rows = certRows(data.component);
    const c = comp(S.doc, data.component);
    const box = h('div', { class: 'block' }, h('p', { class: 'hint' }, 'For each row the certificate speaks about, what it establishes: never (it does not happen), sometimes, or always. Leave the others "not stated".'));
    for (const r of rows) {
      const noNever = r.llm ? 'the LLM rule: never is not allowed for an LLM row or a learned guard' : r.kind === 'leak' && !r.decidable ? 'the target is not decidable from the edge' : '';
      box.appendChild(h('div', { class: 'edit-line' },
        h('div', { class: 'grow' }, h('b', { class: 'mono small' }, r.id), h('div', { class: 'small muted' }, rowWords(r, c))),
        field('States', selectInput([['', 'not stated'], ...WORDS.map(([v, t]) => [v, t, v === 'never' && !!noNever])], data.stated[r.id] || '', (v) => { data.stated[r.id] = v; ctx.update(); })),
        noNever ? h('span', { class: 'small muted w12' }, `never: ${noNever}`) : null));
    }
    if (!rows.length) box.appendChild(h('p', { class: 'hint warn' }, 'This component has no open row to certify.'));
    return box;
  };

  const provenance = (ctx) => {
    const ucs = S.doc.use_cases || [];
    const others = Object.entries(sumComps).filter(([id, x]) => id !== data.component && x.version);
    return h('div', { class: 'block' }, h('div', { class: 'fields2' },
      field('Id', textInput(data.id, (v) => { data.id = v; ctx.update(); }, { class: 'mono' }), 'Unique in the register.'),
      field('Covers version', textInput(data.version, (v) => { data.version = v; ctx.update(); }, { class: 'mono', placeholder: compVersion() || 'no version' }),
        compVersion() ? `The model has ${compVersion()}; a different version makes the certificate stale.` : 'The component has no version in the model.'),
      field('Issued by', textInput(data.issuer, (v) => { data.issuer = v; ctx.update(); }, { placeholder: 'e.g. wallet team (N. N.)' })),
      field('Date', h('input', { type: 'date', value: data.date, oninput: (e) => { data.date = e.target.value; ctx.update(); } })),
      field('Method', textInput(data.method, (v) => { data.method = v; ctx.update(); }, { placeholder: 'e.g. exhaustive test of every payee on the mandate + review' }), null, { wide: true }),
      field('Evidence', textInput(data.evidence, (v) => { data.evidence = v; ctx.update(); }, { placeholder: 'a link to the report' }), null, { wide: true })),
    h('span', { class: 'f-label' }, 'Scope: the use cases it was established for (none ticked: every use case)'),
    h('div', { class: 'chips' }, ucs.map((u) => checkInput(u.id, data.scope.has(u.id), (v) => { if (v) data.scope.add(u.id); else data.scope.delete(u.id); ctx.update(); }))),
    others.length ? h('span', { class: 'f-label' }, 'Signed against these versions of other components (a later change there asks for re-verification)') : null,
    others.length ? h('div', { class: 'chips' }, others.map(([id, x]) => checkInput(`${id} ${x.version}`, id in data.context, (v) => { if (v) data.context[id] = x.version; else delete data.context[id]; ctx.update(); }))) : null);
  };

  const review = (ctx) => {
    const box = h('div', { class: 'block' });
    const out = h('div', {}, h('p', { class: 'hint' }, 'Asking the server how it classifies this certificate…'));
    add(box, h('pre', { class: 'code' }, JSON.stringify(record(), null, 2)), out);
    api('/api/evidence/certificates', { doc: S.doc, text: JSON.stringify(record()) }).then((r) => {
      const c = r.certificates[0];
      data.review = c;
      add(clear(out), h('div', { class: 'inline' }, h('b', {}, 'It would be:'), stateChip(c.state), c.reason ? h('span', { class: 'small' }, c.reason) : null),
        (c.reverify || []).length ? h('p', { class: 'small' }, `Re-verify: ${c.reverify.map((x) => `${x.component} ${x.signed_with} → ${x.now}`).join('; ')}`) : null,
        c.state !== 'in force' ? h('p', { class: 'hint' }, 'You can still add it: the register keeps it with its state and reason.') : null);
    }).catch((e) => { add(clear(out), h('p', { class: 'warn' }, e.message)); });
    return box;
  };

  wizard({
    title: mode === 'add' ? 'New certificate' : `Edit certificate ${old.id}`, mode, size: 'lg', saveLabel: mode === 'add' ? 'Add to the register' : 'Save',
    subtitle: 'A certificate fixes rows of one guard or component to never, sometimes or always, for the version it names.',
    steps: [
      { id: 'what', title: 'What it certifies', render: what, problems: () => (data.component ? [] : ['Nothing in this model has an open row to certify.']) },
      { id: 'statements', title: 'What it establishes', render: statements, problems: () => (Object.values(data.stated).some(Boolean) ? [] : ['State at least one row.']) },
      { id: 'provenance', title: 'Who, when, how', render: provenance,
        problems: () => [!data.id.trim() ? 'Give the certificate an id.' : null, taken.has(data.id.trim()) ? `${data.id.trim()} is already in the register.` : null].filter(Boolean) },
      { id: 'review', title: 'Review', render: review },
    ],
    onSave: () => {
      const c = { ...record(), manual: true };
      S.evidence.certificates = S.evidence.certificates.filter((x) => x.id !== certId && x.id !== c.id).concat([c]);
      changed();
      toast(`${c.id} ${mode === 'add' ? 'added' : 'saved'}${data.review ? `: ${data.review.state}` : ''}.`);
      return true;
    },
  });
}

function word(v) { return { N: 'never', S: 'sometimes', A: 'always', n: 'never', s: 'sometimes', a: 'always' }[v] || v; }

/** One certificate in full, with what can be done to it. */
export function openCertDetails(c, { suspended } = {}) {
  const st = suspended && c.state === 'in force' ? 'suspended' : c.state;
  const stated = [...Object.entries(c.targets || {}).map(([k, v]) => [`target ${k}`, word(v)]), ...Object.entries(c.rows || {}).map(([k, v]) => [`row ${k}`, word(v)])];
  const body = h('div', { class: 'block' },
    h('div', { class: 'inline' }, stateChip(st), c.reason ? h('span', { class: 'small' }, c.reason) : null, c.manual ? h('span', { class: 'tag plain' }, 'entered by hand') : null),
    st === 'suspended' ? h('p', { class: 'hint', style: 'color: var(--c-ink)' }, 'In a minimal conflict with a witness in the last analysis: withdraw the certificate, or reject the witness.') : null,
    h('dl', { class: 'kv' },
      h('dt', {}, 'About'), h('dd', { class: 'mono' }, c.component),
      h('dt', {}, 'States'), h('dd', {}, stated.map(([k, v]) => h('div', { class: 'mono small' }, `${k}: ${v}`))),
      c.resolved ? h('dt', {}, 'Rows it fixes') : null, c.resolved ? h('dd', { class: 'mono small' }, Object.entries(c.resolved).map(([k, v]) => `${k} = ${v}`).join(', ')) : null,
      h('dt', {}, 'Version'), h('dd', { class: 'mono' }, c.version || '—'),
      h('dt', {}, 'Issued'), h('dd', {}, [c.issuer, c.date].filter(Boolean).join(', ') || '—'),
      c.method ? h('dt', {}, 'Method') : null, c.method ? h('dd', {}, c.method) : null,
      c.evidence ? h('dt', {}, 'Evidence') : null, c.evidence ? h('dd', { class: 'mono small' }, c.evidence) : null,
      c.scope ? h('dt', {}, 'Scope') : null, c.scope ? h('dd', {}, c.scope.join(', ')) : null,
      c.context ? h('dt', {}, 'Signed against') : null, c.context ? h('dd', { class: 'mono small' }, Object.entries(c.context).map(([k, v]) => `${k} ${v}`).join(', ')) : null,
      (c.reverify || []).length ? h('dt', {}, 'Re-verify') : null, (c.reverify || []).length ? h('dd', { style: 'color: var(--h-ink)' }, c.reverify.map((x) => `${x.component} ${x.signed_with} → ${x.now}`).join('; ')) : null));
  const d = openDialog({ title: `Certificate ${c.id}`, size: 'md', body });
  d.setActions([
    c.manual ? button('Delete', async () => {
      if (!await confirmDialog(`Delete ${c.id}? It was entered by hand; it leaves the register.`, { title: 'Delete the certificate', okText: 'Delete', danger: true })) return;
      S.evidence.certificates = S.evidence.certificates.filter((x) => x.id !== c.id); d.close(); changed();
    }, { danger: true }) : null,
    h('span', { class: 'spacer' }),
    c.manual ? button('Edit…', () => { d.close(); openCertDialog(c.id); }) : null,
    c.state === 'in force' ? button('Withdraw…', () => { d.close(); openWithdrawDialog(c); }) : null,
    button('Close', () => d.close(), { primary: true }),
  ]);
}

export function openWithdrawDialog(c) {
  const data = { by: 'analyst', reason: '' };
  wizard({
    title: `Withdraw ${c.id}`, mode: 'edit', size: 'md', saveLabel: 'Withdraw',
    subtitle: 'The certificate stays in the register as withdrawn; its rows are open again in the next analysis. The decision is recorded with who and why.',
    steps: [{ id: 'w', title: 'Withdraw', render: (ctx) => h('div', { class: 'fields2' },
      field('Decided by', textInput(data.by, (v) => { data.by = v; ctx.update(); })),
      field('Reason', textInput(data.reason, (v) => { data.reason = v; ctx.update(); }, { placeholder: 'why the certificate no longer holds' }), null, { wide: true })),
    problems: () => [data.by.trim() ? null : 'Say who decides.', data.reason.trim() ? null : 'Give the reason; it is printed with the verdicts.'].filter(Boolean) }],
    onSave: () => {
      S.evidence.decisions.push({ kind: 'withdraw-cert', certificate: c.id, by: data.by.trim(), reason: data.reason.trim() });
      changed();
      toast(`${c.id} withdrawn.`);
      return true;
    },
  });
}

// ---------------------------------------------------------------- witnesses

/** Write a witness step by step, or edit a hand-made one (id). */
export function openWitnessDialog(witId) {
  if (!S.check || !S.check.ok) { toast('Fix the model first: a witness is checked against it.'); return; }
  const d0 = S.doc;
  const old = witId ? S.evidence.witnesses.find((w) => w.id === witId) : null;
  const mode = old ? 'edit' : 'add';
  const fields = modeFields(d0);
  const conf = d0.lattices.confidentiality, auth = d0.lattices.authority;
  const points = d0.observation_points;
  const taken = new Set(S.evidence.witnesses.map((w) => w.id).filter((x) => x !== witId));
  let n = 1; while (taken.has(`w_manual_${n}`)) n++;
  // what was seen at each point: per mode 'nl' (not logged) | 'zero' | 'exact' | 'atleast', with k
  const fromRange = ([lo, hi]) => (lo === 0 && hi === 0 ? { how: 'zero', k: 1 } : lo === hi ? { how: 'exact', k: lo } : hi === 10 ? { how: 'atleast', k: lo } : { how: 'range', k: lo, k2: hi });
  const seenOf = (logged = {}) => ({
    modes: Object.fromEntries(Object.entries(logged.modes || {}).map(([f, r]) => [f, fromRange(r)])),
    taint: logged.taint === undefined ? '' : logged.taint ? 'yes' : 'no',
    conf: logged.conf ? conf[logged.conf[0]] || '' : '', auth: logged.auth ? auth[logged.auth[0]] || '' : '',
  });
  const data = {
    id: old ? old.id : `w_manual_${n}`, use_case: old ? old.use_case || '' : (d0.use_cases[0] ? d0.use_cases[0].id : ''),
    date: old ? old.date || '' : today(), source: old ? old.source || '' : '', note: old ? old.rule || '' : '',
    at: old ? Object.fromEntries(Object.entries(old.at).map(([o, l]) => [o, seenOf(l)])) : (points[0] ? { [points[0].id]: seenOf() } : {}),
    review: null,
  };
  const spec = () => {
    const at = {};
    for (const [o, s] of Object.entries(data.at)) {
      const x = {};
      for (const [f, v] of Object.entries(s.modes)) {
        if (v.how === 'zero') (x.modes = x.modes || {})[f] = [0, 0];
        if (v.how === 'exact') (x.modes = x.modes || {})[f] = [v.k, v.k];
        if (v.how === 'atleast') (x.modes = x.modes || {})[f] = [v.k, 10];
        if (v.how === 'range') (x.modes = x.modes || {})[f] = [v.k, v.k2];
      }
      if (s.taint) x.taint = s.taint === 'yes';
      if (s.conf) x.conf = [s.conf, s.conf];
      if (s.auth) x.auth = [s.auth, s.auth];
      at[o] = x;
    }
    return { id: data.id.trim(), use_case: data.use_case || null, date: data.date, source: data.source.trim() || 'entered by hand', note: data.note.trim(), at };
  };

  const where = (ctx) => {
    const box = h('div', { class: 'block' });
    box.appendChild(h('div', { class: 'fields2' },
      field('Use case', selectInput([['', 'not known'], ...d0.use_cases.map((u) => [u.id, `${u.id}${u.label ? ` — ${u.label}` : ''}`])], data.use_case, (v) => { data.use_case = v; ctx.update(); }), 'The run it was part of; "not known" matches every use case.'),
      field('Date', h('input', { type: 'date', value: data.date, oninput: (e) => { data.date = e.target.value; ctx.update(); } }), 'With a deployment manifest, the versions in force that day decide whether it is stale.')));
    box.appendChild(h('span', { class: 'f-label' }, 'Logged at'));
    for (const o of points) {
      box.appendChild(checkInput(`${o.label || o.id} (${o.id})`, o.id in data.at, (v) => { if (v) data.at[o.id] = seenOf(); else delete data.at[o.id]; ctx.update(); },
        `on ${o.edge}${o.log ? ` · ${o.log}` : ''}`));
    }
    if (!points.length) box.appendChild(h('p', { class: 'hint warn' }, 'The model has no observation point: add one on an edge first.'));
    return box;
  };

  const seen = (ctx) => {
    const box = h('div', { class: 'block' });
    for (const [oid, s] of Object.entries(data.at)) {
      const o = points.find((x) => x.id === oid);
      const judged = Object.keys((o && o.tolerate) || {});
      const ordered = [...fields.filter((f) => judged.includes(f.name)), ...fields.filter((f) => !judged.includes(f.name))];
      const card = h('div', { class: 'card' }, h('b', {}, `${(o && o.label) || oid} `, h('span', { class: 'mono small muted' }, oid)));
      for (const f of ordered) {
        const v = s.modes[f.name] || { how: 'nl', k: 1 };
        card.appendChild(h('div', { class: `edit-line${judged.includes(f.name) ? '' : ' faint'}` },
          h('span', { class: `mono small w8${f.parent ? ' sub' : ''}` }, f.name),
          selectInput([['nl', 'not logged'], ['zero', 'not there (0)'], ['exact', 'there, magnitude'], ['atleast', 'there, at least'], ['range', 'between']], v.how,
            (x) => { if (x === 'nl') delete s.modes[f.name]; else s.modes[f.name] = { ...v, how: x, k: x === 'zero' ? 0 : Math.max(1, v.k || 1), k2: v.k2 || 10 }; ctx.rerender(); }),
          ['exact', 'atleast', 'range'].includes(v.how) ? numberInput(v.k, (x) => { v.k = x; ctx.update(); }, { min: v.how === 'range' ? 0 : 1, max: 10, 'aria-label': `${f.name} magnitude` }) : null,
          v.how === 'range' ? h('span', { class: 'small muted' }, 'and') : null,
          v.how === 'range' ? numberInput(v.k2, (x) => { v.k2 = x; ctx.update(); }, { min: 0, max: 10, 'aria-label': `${f.name} upper magnitude` }) : null,
          judged.includes(f.name) ? null : h('span', { class: 'small muted' }, 'not judged here')));
      }
      card.appendChild(h('div', { class: 'fields3' },
        field('Taint', selectInput([['', 'not logged'], ['no', 'clean'], ['yes', 'tainted']], s.taint, (x) => { s.taint = x; ctx.update(); })),
        field('Confidentiality', selectInput([['', 'not logged'], ...conf.map((l) => [l, l])], s.conf, (x) => { s.conf = x; ctx.update(); })),
        field('Authority', selectInput([['', 'not logged'], ...auth.map((l) => [l, l])], s.auth, (x) => { s.auth = x; ctx.update(); }))));
      box.appendChild(card);
    }
    box.appendChild(h('p', { class: 'hint' }, '"Not there" is evidence too: a clean statement line says the failure did not reach the point in that run.'));
    return box;
  };

  const about = (ctx) => h('div', { class: 'fields2' },
    field('Id', textInput(data.id, (v) => { data.id = v; ctx.update(); }, { class: 'mono' }), 'Unique in the register.'),
    field('Where it was seen', textInput(data.source, (v) => { data.source = v; ctx.update(); }, { placeholder: 'e.g. support ticket 4711, statement line 12' })),
    field('Note', textInput(data.note, (v) => { data.note = v; ctx.update(); }, { placeholder: 'what happened, in words' }), null, { wide: true }));

  const review = () => {
    const out = h('div', {}, h('p', { class: 'hint' }, 'Asking the server how it reads this witness…'));
    api('/api/evidence/witness', { doc: S.doc, witness: spec(), deployments: S.evidence.deployments || (S.bundle && S.bundle.deployments) || null }).then((r) => {
      data.review = r.witness;
      add(clear(out), h('div', { class: 'inline' }, h('b', {}, 'It would be:'), stateChip(r.witness.state), r.witness.reason ? h('span', { class: 'small' }, r.witness.reason) : null),
        h('pre', { class: 'code' }, JSON.stringify(strip(r.witness), null, 2)));
    }).catch((e) => { data.review = null; add(clear(out), h('div', { class: 'problems' }, 'The server cannot take it: ', e.message)); });
    return out;
  };

  const seenProblems = () => {
    const p = [];
    if (!Object.keys(data.at).length) p.push('Tick at least one observation point in the first step.');
    for (const [oid, s] of Object.entries(data.at)) {
      const any = Object.keys(s.modes).length || s.taint || s.conf || s.auth;
      if (!any) p.push(`Say what was seen at ${oid}: a failure (or that it was not there), taint, confidentiality or authority.`);
      for (const [f, v] of Object.entries(s.modes)) {
        if (v.how !== 'zero' && !(v.k >= (v.how === 'range' ? 0 : 1) && v.k <= 10)) p.push(`The magnitude of ${f} at ${oid} is from 1 to 10.`);
        if (v.how === 'range' && !(v.k2 >= v.k && v.k2 <= 10)) p.push(`The range of ${f} at ${oid} runs from low to high within 0..10.`);
      }
    }
    return p;
  };

  wizard({
    title: mode === 'add' ? 'New witness' : `Edit witness ${old.id}`, mode, size: 'lg', saveLabel: mode === 'add' ? 'Add to the register' : 'Save',
    subtitle: 'A witness says what one interaction delivered at observation points. Logs make them through recognisers; here you write one yourself.',
    steps: [
      { id: 'where', title: 'Where and when', render: where, problems: () => (Object.keys(data.at).length ? [] : ['Tick the observation point(s) it was logged at.']) },
      { id: 'seen', title: 'What was seen', render: seen, problems: seenProblems },
      { id: 'about', title: 'Source', render: about, problems: () => [!data.id.trim() ? 'Give the witness an id.' : null, taken.has(data.id.trim()) ? `${data.id.trim()} is already in the register.` : null].filter(Boolean) },
      { id: 'review', title: 'Review', render: review },
    ],
    onSave: async () => {
      let w;
      try {
        w = (await api('/api/evidence/witness', { doc: S.doc, witness: spec(), deployments: S.evidence.deployments || (S.bundle && S.bundle.deployments) || null })).witness;
      } catch (e) { return { problems: [e.message], title: 'The server cannot take this witness:' }; }
      const rec = { ...strip(w), manual: true };
      S.evidence.witnesses = S.evidence.witnesses.filter((x) => x.id !== witId && x.id !== rec.id).concat([rec]);
      const files = S.evidence.files.filter((f) => !f.manual);
      const mine = S.evidence.witnesses.filter((x) => x.manual).map((x) => x.id);
      S.evidence.files = files.concat([{ name: 'Entered by hand', kind: 'log', manual: true, recognisers: ['manual'], witnesses: mine, unmatched: 0 }]);
      changed();
      toast(`${rec.id} ${mode === 'add' ? 'added' : 'saved'}: ${w.state}.`);
      return true;
    },
  });
}

/** One witness in full, with what can be done to it. */
export function openWitnessDetails(w, fmtAt) {
  const body = h('div', { class: 'block' },
    h('div', { class: 'inline' }, stateChip(w.state), w.reason ? h('span', { class: 'small' }, w.reason) : null, w.manual ? h('span', { class: 'tag plain' }, 'entered by hand') : null),
    h('dl', { class: 'kv' },
      h('dt', {}, 'What was seen'), h('dd', { class: 'mono small' }, fmtAt(w.at, S.doc)),
      h('dt', {}, 'Use case'), h('dd', {}, w.use_case || 'not known'),
      h('dt', {}, 'Date'), h('dd', {}, w.date || '—'),
      h('dt', {}, 'Source'), h('dd', {}, w.source || '—'),
      w.recogniser ? h('dt', {}, 'Read by') : null, w.recogniser ? h('dd', { class: 'mono small' }, w.recogniser === 'manual' ? 'entered by hand' : w.recogniser) : null,
      w.rule ? h('dt', {}, w.manual ? 'Note' : 'Rule') : null, w.rule ? h('dd', {}, w.rule) : null,
      (w.lines || []).length ? h('dt', {}, 'Lines') : null, (w.lines || []).length ? h('dd', { class: 'mono small' }, w.lines.join(', ')) : null,
      w.versions ? h('dt', {}, 'Versions then') : null, w.versions ? h('dd', { class: 'mono small' }, Object.entries(w.versions).map(([k, v]) => `${k} ${v}`).join(', ')) : null));
  const d = openDialog({ title: `Witness ${w.id}`, size: 'md', body });
  d.setActions([
    w.manual ? button('Delete', async () => {
      if (!await confirmDialog(`Delete ${w.id}? It was entered by hand; it leaves the register.`, { title: 'Delete the witness', okText: 'Delete', danger: true })) return;
      S.evidence.witnesses = S.evidence.witnesses.filter((x) => x.id !== w.id);
      for (const f of S.evidence.files) if (f.manual) f.witnesses = f.witnesses.filter((x) => x !== w.id);
      S.evidence.files = S.evidence.files.filter((f) => !f.manual || f.witnesses.length);
      d.close(); changed();
    }, { danger: true }) : null,
    h('span', { class: 'spacer' }),
    w.manual ? button('Edit…', () => { d.close(); openWitnessDialog(w.id); }) : null,
    !w.manual && w.state === 'in force' ? button('Reject…', () => { d.close(); openRejectDialog(w); }) : null,
    button('Close', () => d.close(), { primary: true }),
  ]);
}

export function openRejectDialog(w) {
  const data = { by: 'analyst', second: '', reason: '' };
  wizard({
    title: `Reject ${w.id}`, mode: 'edit', size: 'md', saveLabel: 'Reject',
    subtitle: 'A witness is what happened. Rejecting one says the log is wrong, so it takes two people, and the reason is recorded.',
    steps: [{ id: 'r', title: 'Reject', render: (ctx) => h('div', { class: 'fields2' },
      field('Decided by', textInput(data.by, (v) => { data.by = v; ctx.update(); })),
      field('Second reviewer', textInput(data.second, (v) => { data.second = v; ctx.update(); }, { placeholder: 'required' })),
      field('Reason', textInput(data.reason, (v) => { data.reason = v; ctx.update(); }, { placeholder: 'why the log line is wrong' }), null, { wide: true })),
    problems: () => [data.by.trim() ? null : 'Say who decides.', data.second.trim() ? null : 'A rejection needs a second reviewer.', data.reason.trim() ? null : 'Give the reason.'].filter(Boolean) }],
    onSave: () => {
      S.evidence.decisions.push({ kind: 'reject-witness', witness: w.id, by: data.by.trim(), second_reviewer: data.second.trim(), reason: data.reason.trim() });
      changed();
      toast(`${w.id} rejected.`);
      return true;
    },
  });
}
