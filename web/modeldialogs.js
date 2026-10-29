// Dialogs for editing the model: a component (properties, ports, normal flow, what it absorbs, an
// LLM's worst-case defaults), a guard, an observation point, an edge, a system port, a use case, a
// claim, and the model's own settings. Each edits a copy of the model and commits it on Save, after
// the server's model check (state.saveChecked); Cancel leaves the model untouched.
import { h, toast } from './lib.js';
import { S, comp, edge, parseRef, modeFields, topModes, sysPorts, cloneDoc, commitDoc, saveChecked, ops, portEdges, uniqueId, targetText } from './state.js';
import { wizard, field, textInput, numberInput, selectInput, checkInput, button, confirmDialog, openDialog } from './dialog.js';
import { openRowDialog } from './rowdialog.js';
import { defaultStatus, hasDefaults } from './rows.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const KINDS = [['llm', 'LLM (discretionary)'], ['deterministic', 'deterministic'], ['tool', 'tool / API'], ['store', 'store / memory'], ['external', 'external system'], ['user', 'user']];

function idsIn(doc) { return new Set([...doc.components.map((c) => c.id), ...doc.guards.map((g) => g.id), 'sys']); }
function idProblem(v, taken, what = 'The id') {
  if (!v) return `${what} cannot be empty.`;
  if (!IDENT.test(v)) return `${what} must start with a letter or _ and use only letters, digits and _.`;
  if (taken.has(v)) return `${v} is already used.`;
  return null;
}
const levelOpts = (levels) => levels.map((l) => [l, l]);

// ---------------------------------------------------------------- component
export function openComponentDialog(cid, { startAt } = {}) {
  const doc = cloneDoc();
  const c = comp(doc, cid);
  if (!c) return;
  const data = { newId: cid };
  const conf = doc.lattices.confidentiality, auth = doc.lattices.authority;
  const tops = topModes(doc);
  const taken = idsIn(doc); taken.delete(cid);
  const isLlm = () => c.kind === 'llm';
  const flowOf = () => c.flow || Object.fromEntries(c.in.map((p) => [p, c.out.slice()]));

  const props = (ctx) => h('div', { class: 'fields2' },
    field('Id', textInput(data.newId, (v) => { data.newId = v.trim(); ctx.update(); }, { class: 'mono', spellcheck: 'false' }), 'Edges, certificates and verdicts name the component by it.'),
    field('Kind', selectInput(KINDS, c.kind, (v) => { c.kind = v; ctx.rerender(); }), c.kind === 'llm' ? 'An LLM passes nothing through and gets worst-case default rows.' : hasDefaults(doc, c) ? 'Every failure passes through unless you declare it absorbed, and the component starts with worst-case default rows (a model setting).' : 'Every failure passes through unless you declare it absorbed.'),
    field('Label', textInput(c.label, (v) => { c.label = v; ctx.update(); }), null, { wide: true }),
    field('Version', textInput(c.version, (v) => { c.version = v.trim() || undefined; ctx.update(); }, { class: 'mono', placeholder: 'e.g. wallet-3.2' }), 'A change makes the certificates and witnesses that name the old one stale.'),
    field('Own authority', selectInput(levelOpts(auth), c.authority || auth.at(-1), (v) => { c.authority = v; ctx.update(); })),
    field('Clearance', selectInput(levelOpts(conf), c.clearance || conf.at(-1), (v) => { c.clearance = v; ctx.update(); }), 'The most confidential data it may receive.'),
    field('Requires', selectInput(levelOpts(auth), c.requires || auth[0], (v) => { c.requires = v; ctx.update(); }), 'The authority a message needs before it acts.'),
    h('div', { class: 'f wide' },
      checkInput('Trusted', c.trusted !== undefined ? c.trusted : !['external', 'user'].includes(c.kind), (v) => { c.trusted = v; ctx.update(); }, 'An untrusted component taints what it touches.'),
      checkInput('Raises authority', c.raises, (v) => { c.raises = v; ctx.update(); }, 'It acts on its own authority (signs, approves).')));

  const ports = (ctx) => {
    const box = h('div', { class: 'block' });
    for (const side of ['in', 'out']) {
      box.appendChild(h('div', { class: 'block-head' }, h('b', {}, side === 'in' ? 'Input ports' : 'Output ports'), h('span', { class: 'spacer' }),
        button(side === 'in' ? '+ Input port' : '+ Output port', () => { ops.addPort(doc, cid, side); ctx.rerender(); }, { small: true })));
      if (!c[side].length) box.appendChild(h('p', { class: 'hint' }, 'None yet. Wiring on the canvas adds ports too.'));
      for (const p of c[side]) {
        const es = portEdges(doc, cid, side, p);
        box.appendChild(h('div', { class: 'edit-line' },
          h('span', { class: `pdot ${side}` }),
          h('input', { value: p, class: 'mono port-name', 'aria-label': `name of port ${p}`, spellcheck: 'false', onchange: (e) => {
            if (!ops.renamePort(doc, cid, side, p, e.target.value.trim())) toast('A port name is an identifier, unique on its side.');
            ctx.rerender();
          } }),
          h('span', { class: 'small muted grow' }, es.length ? `${side === 'in' ? 'from' : 'to'} ${es.map((x) => (side === 'in' ? x.from : x.to)).join(', ')}` : 'unconnected'),
          button('Delete', async () => {
            if (es.length || (c.rows || []).some((r) => (side === 'in' ? (r.when || {})[p] : (r.then || {})[p]) !== undefined)) {
              const ok = await confirmDialog(`Delete port ${p}? Its ${es.length} edge(s) and the rows that use it go too.`, { title: 'Delete the port', okText: 'Delete', danger: true });
              if (!ok) return;
            }
            ops.removePort(doc, cid, side, p); ctx.rerender();
          }, { small: true, ghost: true })));
      }
    }
    return box;
  };

  const flow = (ctx) => {
    if (!c.in.length || !c.out.length) return h('p', { class: 'hint' }, 'The normal flow needs an input and an output port.');
    const f = flowOf();
    return h('div', { class: 'block' }, h('table', { class: 'flow-table big' },
      h('tr', {}, h('th', {}, 'input ↓  sends to →'), c.out.map((q) => h('th', { class: 'mono' }, q))),
      c.in.map((p) => h('tr', {}, h('td', { class: 'mono' }, p), c.out.map((q) => h('td', {}, h('input', { type: 'checkbox', 'aria-label': `${p} sends to ${q}`, checked: (f[p] || []).includes(q),
        onchange: (e) => { c.flow = c.flow || JSON.parse(JSON.stringify(f)); const l = new Set(c.flow[p] || []); if (e.target.checked) l.add(q); else l.delete(q); c.flow[p] = c.out.filter((x) => l.has(x)); ctx.update(); } })))))),
    h('p', { class: 'hint' }, 'On the happy path, a message arriving on an input goes on to the ticked outputs, carrying every failure it brought unless the component absorbs it.'));
  };

  const absorbs = (ctx) => {
    c.absorbs = c.absorbs || [];
    const box = h('div', { class: 'block' }, h('p', { class: 'hint' }, 'Everything passes through a non-LLM component (assumption A6). Tick a failure to say it stops at that input, and give the reason: it is a claim an auditor can dispute, printed wherever a verdict rests on it.'));
    if (!c.in.length) box.appendChild(h('p', { class: 'hint' }, 'No input port yet.'));
    for (const p of c.in) {
      const a = c.absorbs.find((x) => x.port === p);
      const set = new Set(a ? (a.modes === 'all' ? tops : [].concat(a.modes || a.mode || [])) : []);
      const toggle = (m) => {
        let x = c.absorbs.find((y) => y.port === p);
        if (!x) { x = { port: p, modes: [], reason: '' }; c.absorbs.push(x); }
        const ms = new Set(x.modes === 'all' ? tops : [].concat(x.modes || x.mode || []));
        if (ms.has(m)) ms.delete(m); else ms.add(m);
        x.modes = tops.filter((t) => ms.has(t)); delete x.mode;
        c.absorbs = c.absorbs.filter((y) => y.modes.length);
        ctx.rerender();
      };
      box.appendChild(h('div', { class: 'card' },
        h('div', { class: 'inline' }, h('b', { class: 'mono' }, p), h('span', { class: 'small muted' }, set.size ? `absorbs ${[...set].join(', ')}` : 'everything passes')),
        h('div', { class: 'chips' }, tops.map((m) => h('button', { type: 'button', class: `mchip${set.has(m) ? ' absorbed' : ' on'}`, 'aria-pressed': String(set.has(m)), title: set.has(m) ? `${m} stops here (click to let it pass)` : `${m} passes (click to absorb it)`, onclick: () => toggle(m) }, set.has(m) ? `${m}: absorbed` : m))),
        a ? field('Why it stops here (required)', textInput(a.reason, (v) => { a.reason = v; ctx.update(); }, { placeholder: 'e.g. the intake re-reads the invoice; a stale copy is discarded' }), null, { wide: true }) : null));
    }
    return box;
  };

  const defaults = (ctx) => {
    c.drop_defaults = c.drop_defaults || [];
    const box = h('div', { class: 'block' }, h('p', { class: 'hint' }, `Each output starts with one worst-case row per failure mode: any message in, that failure at 10 out. A row of yours with the same trigger replaces it; dropping one needs a structural reason, printed wherever a verdict rests on it.${isLlm() ? '' : ' A certificate may also say one never fires (not so for an LLM).'}`));
    if (!c.out.length) box.appendChild(h('p', { class: 'hint' }, 'No output port yet.'));
    for (const q of c.out) {
      box.appendChild(h('b', { class: 'mono' }, q));
      for (const m of tops) {
        const st = defaultStatus(c, q, m);
        box.appendChild(h('div', { class: 'edit-line' },
          h('span', { class: 'mono small w8' }, `${m} at 10`),
          st.status === 'refined' ? h('span', { class: 'small muted grow' }, `replaced by your row ${st.refinedBy.join(', ')}`)
            : checkInput('drop it', !!st.drop, (v) => { if (v) c.drop_defaults.push({ port: q, mode: m, reason: '' }); else c.drop_defaults = c.drop_defaults.filter((x) => !(x.port === q && x.mode === m)); ctx.rerender(); }),
          st.drop ? textInput(st.drop.reason, (v) => { st.drop.reason = v; ctx.update(); }, { placeholder: 'the structural reason (required)', class: 'grow' }) : h('span', { class: 'grow' })));
      }
    }
    return box;
  };

  const problems = {
    props: () => [idProblem(data.newId, taken)].filter(Boolean),
    absorbs: () => (isLlm() ? [] : (c.absorbs || []).filter((a) => !(a.reason || '').trim()).map((a) => `Say why ${a.port} absorbs ${[].concat(a.modes).join(', ')}.`)),
    defaults: () => (!hasDefaults(doc, c) ? [] : (c.drop_defaults || []).filter((d) => !(d.reason || '').trim()).map((d) => `Give the reason for dropping ${d.mode} on ${d.port}.`)),
  };

  wizard({
    title: `Edit ${cid}`, subtitle: `${c.kind} component`, mode: 'edit', size: 'lg', startAt,
    steps: [
      { id: 'props', title: 'Properties', render: props, problems: problems.props },
      { id: 'ports', title: 'Ports', hint: 'Inputs receive, outputs send. Renaming a port renames it in its edges and rows.', render: ports },
      { id: 'flow', title: 'Normal flow', render: flow },
      { id: 'absorbs', title: 'What it absorbs', render: absorbs, problems: problems.absorbs, skip: isLlm },
      { id: 'defaults', title: 'Worst-case defaults', render: defaults, problems: problems.defaults, skip: () => !hasDefaults(doc, c) },
    ],
    onSave: async (ctx, { force } = {}) => {
      if (isLlm()) delete c.absorbs;
      if (!hasDefaults(doc, c)) delete c.drop_defaults;
      if (c.absorbs && !c.absorbs.length) delete c.absorbs;
      if (c.drop_defaults && !c.drop_defaults.length) delete c.drop_defaults;
      if (data.newId !== cid && !ops.renameComponent(doc, cid, data.newId)) return { problems: [`Cannot rename to ${data.newId}.`] };
      const r = await saveChecked(doc, { type: 'component', id: data.newId }, force);
      if (r === true) toast(`${data.newId} saved.`);
      return r;
    },
  });
}

// ---------------------------------------------------------------- what a component absorbs at one port
export function openAbsorbDialog(cid, port) {
  const doc = cloneDoc();
  const c = comp(doc, cid);
  const tops = topModes(doc);
  c.absorbs = c.absorbs || [];
  const cur = c.absorbs.find((a) => a.port === port);
  const data = { modes: new Set(cur ? (cur.modes === 'all' ? tops : [].concat(cur.modes || cur.mode || [])) : []), reason: cur ? cur.reason || '' : '' };
  wizard({
    title: `What ${cid} absorbs at ${port}`, subtitle: 'A failure stops only where the model says so, with a reason (assumption A6).', mode: 'edit', size: 'md',
    steps: [{ id: 'a', title: 'Absorbs',
      render: (ctx) => h('div', { class: 'block' },
        h('div', { class: 'chips' }, tops.map((m) => h('button', { type: 'button', class: `mchip${data.modes.has(m) ? ' absorbed' : ' on'}`, 'aria-pressed': String(data.modes.has(m)),
          onclick: () => { if (data.modes.has(m)) data.modes.delete(m); else data.modes.add(m); ctx.rerender(); } }, data.modes.has(m) ? `${m}: absorbed` : `${m}: passes`))),
        field('Why it stops here', textInput(data.reason, (v) => { data.reason = v; ctx.update(); }, { placeholder: 'e.g. the intake re-reads the invoice; a stale copy is discarded' }), 'Required when something is absorbed.', { wide: true })),
      problems: () => (data.modes.size && !data.reason.trim() ? ['Give the reason: an absorption is a claim an auditor can dispute.'] : []) }],
    onSave: async (ctx, { force } = {}) => {
      c.absorbs = c.absorbs.filter((a) => a.port !== port);
      if (data.modes.size) c.absorbs.push({ port, modes: tops.filter((m) => data.modes.has(m)), reason: data.reason.trim() });
      if (!c.absorbs.length) delete c.absorbs;
      return saveChecked(doc, { type: 'component', id: cid }, force);
    },
  });
}

// ---------------------------------------------------------------- dropping a worst-case default
export function openDropDefaultDialog(cid, port, mode) {
  const data = { reason: '' };
  const d = openDialog({ title: `Drop the default ${mode} on ${cid}.${port}?`, size: 'md',
    subtitle: `The worst case says ${cid} may send this failure on any message. Dropping it needs a structural reason, printed wherever a verdict rests on it.` });
  const reason = textInput('', (v) => { data.reason = v; drop.disabled = !v.trim(); }, { placeholder: 'e.g. lateness is modelled at the bank' });
  const drop = button('Drop it', async () => {
    const doc = cloneDoc();
    const c = comp(doc, cid);
    c.drop_defaults = (c.drop_defaults || []).concat([{ port, mode, reason: data.reason.trim() }]);
    await saveChecked(doc, { type: 'component', id: cid }, true);
    d.close();
    toast(`Default ${mode} on ${port} dropped.`);
  }, { primary: true, disabled: true });
  d.setBody(h('div', { class: 'block' }, field('The structural reason', reason, null, { wide: true }),
    h('p', { class: 'hint' }, comp(S.doc, cid).kind === 'llm' ? 'To lower the magnitude instead, refine the default with a row of your own.'
      : 'To lower the magnitude instead, refine the default with a row of your own. If a test or a review shows it never happens, a certificate that says so keeps the record with the evidence.')));
  d.setActions([button('Cancel', () => d.close()), h('span', { class: 'spacer' }),
    button('Refine with a row instead', () => { d.close(); openRowDialog(cid, null, { preset: refinePreset(cid, port, mode), startAt: 'effect' }); }), drop]);
}

/** The draft that refines a worst-case default: same trigger (any message), same failure on the same port. */
export function refinePreset(cid, port, mode) {
  const c = comp(S.doc, cid);
  const taken = new Set(S.doc.components.flatMap((x) => (x.rows || []).map((r) => r.id)));
  let id = `${cid}_${port}_${mode}`; let i = 2;
  while (taken.has(id)) id = `${cid}_${port}_${mode}${i++}`;
  return { id, kind: 'failure', when: [{ port: c.in.length === 1 ? c.in[0] : '*', any: true, mode: '', threshold: 1 }], then: [{ port, asis: false, mode, op: 'const', k: 10 }] };
}

// ---------------------------------------------------------------- guard
export function openGuardDialog(gid, { edge: edgeId, startAt } = {}) {
  const doc = cloneDoc();
  const fields = modeFields(doc).map((m) => m.name);
  const mode = gid ? 'edit' : 'add';
  let g = gid ? doc.guards.find((x) => x.id === gid) : null;
  if (gid && !g) return;
  if (!g) { g = { id: uniqueId('g', idsIn(doc)), label: '', edge: edgeId || (doc.edges[0] && doc.edges[0].id), targets: [] }; doc.guards.push(g); }
  g.targets = g.targets || [];
  const data = { newId: g.id };
  const taken = idsIn(doc); taken.delete(g.id);
  const conf = doc.lattices.confidentiality, auth = doc.lattices.authority;
  const kindOf = (t) => ('mode' in t ? 'mode' : 'taint' in t ? 'taint' : 'conf' in t ? 'conf' : 'auth');

  const what = (ctx) => {
    const onEdge = doc.guards.filter((x) => x.edge === g.edge);
    const idx = onEdge.indexOf(g);
    const swap = (o) => { const i = doc.guards.indexOf(g), j = doc.guards.indexOf(o); doc.guards[i] = o; doc.guards[j] = g; ctx.rerender(); };
    return h('div', { class: 'block' }, h('div', { class: 'fields2' },
      field('Name', textInput(g.label, (v) => { g.label = v; ctx.update(); }, { placeholder: 'e.g. mandate check, schema validator, LLM judge' }), 'What the guard is, in words.', { wide: true }),
      field('Id', textInput(data.newId, (v) => { data.newId = v.trim(); ctx.update(); }, { class: 'mono', spellcheck: 'false' }), 'Certificates name the guard by its id.'),
      field('Version', textInput(g.version, (v) => { g.version = v.trim() || undefined; ctx.update(); }, { class: 'mono', placeholder: 'e.g. mandate-v2' }), 'Certificates name the version they cover.'),
      field('Cuts the edge', selectInput(doc.edges.map((x) => [x.id, `${x.id}: ${x.from} → ${x.to}`]), g.edge, (v) => { g.edge = v; ctx.rerender(); }), null, { wide: true }),
      h('div', { class: 'f wide' },
        checkInput('Learned (a classifier or an LLM judge)', g.learned, (v) => { g.learned = v || undefined; if (v) g.targets.forEach((t) => { t.decidable = false; }); ctx.rerender(); }, 'No certificate can say a learned guard never leaks; it gets a false-positive row too.'),
        checkInput('Closed output', g.closed_output, (v) => { g.closed_output = v || undefined; ctx.rerender(); }, 'It emits only from a closed set (enumerations), so it may wash taint.')),
      g.learned ? field('A false positive emits omission at', numberInput(g.fp_omission ?? 10, (v) => { g.fp_omission = v; ctx.update(); }, { min: 0, max: 10 })) : null),
    onEdge.length > 1 ? h('div', { class: 'inline' }, h('span', { class: 'small muted' }, `Position ${idx + 1} of ${onEdge.length} on ${g.edge}, in the order the guards cut it.`),
      button('Earlier', () => swap(onEdge[idx - 1]), { small: true, disabled: idx === 0 }), button('Later', () => swap(onEdge[idx + 1]), { small: true, disabled: idx === onEdge.length - 1 })) : null);
  };

  const targets = (ctx) => {
    const box = h('div', { class: 'block' });
    g.targets.forEach((t, i) => {
      const k = kindOf(t);
      const setKind = (nk) => {
        for (const x of ['mode', 'threshold', 'taint', 'conf', 'auth']) delete t[x];
        if (nk === 'mode') Object.assign(t, { mode: fields[0], threshold: 1 });
        if (nk === 'taint') t.taint = true;
        if (nk === 'conf') t.conf = conf[0];
        if (nk === 'auth') t.auth = auth.at(-1);
        ctx.rerender();
      };
      const decidable = !g.learned && t.decidable;
      box.appendChild(h('div', { class: 'card' },
        h('div', { class: 'edit-line' },
          field('Catches', selectInput([['mode', 'a failure mode'], ['taint', 'taint'], ['conf', 'confidentiality above'], ['auth', 'authority below']], k, setKind)),
          k === 'mode' ? field('Mode', selectInput(fields.map((f) => [f, f]), t.mode, (v) => { t.mode = v; ctx.update(); })) : null,
          k === 'mode' ? field('From magnitude', numberInput(t.threshold || 1, (v) => { t.threshold = v; ctx.update(); }, { min: 1, max: 10 })) : null,
          k === 'conf' ? field('Level', selectInput(levelOpts(conf), t.conf, (v) => { t.conf = v; ctx.update(); })) : null,
          k === 'auth' ? field('Level', selectInput(levelOpts(auth), t.auth, (v) => { t.auth = v; ctx.update(); })) : null,
          h('span', { class: 'spacer' }), button('Remove', () => { g.targets.splice(i, 1); ctx.rerender(); }, { small: true, ghost: true })),
        g.learned ? h('span', { class: 'small muted' }, 'A learned guard: its leak row is sometimes or always, never "never".')
          : checkInput('Decidable from the data on the edge', t.decidable, (v) => { t.decidable = v; ctx.rerender(); }, decidable ? 'A certificate may say its leak row never fires.' : 'Its leak row can only be sometimes or always.'),
        h('span', { class: 'small' }, catchSentence(t))));
    });
    box.appendChild(h('div', {}, button('+ Add a target', () => { g.targets.push({ mode: fields[0], threshold: 1, decidable: !g.learned }); ctx.rerender(); }, { small: true })));
    box.appendChild(h('p', { class: 'hint' }, 'Each target gets a leak row, "the target gets through", whose activation is the guard\'s quality. Everything the guard does not target passes unchanged.'));
    return box;
  };

  wizard({
    title: mode === 'add' ? 'New guard' : `Edit guard ${g.label || g.id}`, mode, size: 'lg', startAt,
    subtitle: mode === 'add' ? `On ${g.edge}: a guard cuts the edge in two and catches its targets unless its leak row fires.` : `cuts ${g.edge}`,
    saveLabel: mode === 'add' ? 'Add guard' : 'Save guard',
    steps: [
      { id: 'what', title: 'The guard', render: what, problems: () => [idProblem(data.newId, taken), g.edge ? null : 'Choose the edge it cuts.'].filter(Boolean) },
      { id: 'targets', title: 'What it catches', render: targets,
        problems: () => [
          g.targets.length ? null : 'Add at least one target: a guard that checks for nothing changes no verdict.',
          ...g.targets.filter((t) => 'taint' in t && !g.closed_output).map(() => 'Only a guard with a closed output can wash taint: tick "Closed output", or remove the taint target.'),
          ...g.targets.filter((t) => 'mode' in t && !(t.threshold >= 1 && t.threshold <= 10)).map(() => 'A threshold is a magnitude from 1 to 10.'),
        ].filter(Boolean) },
    ],
    preview: () => h('div', { class: 'preview' }, h('span', { class: 'section-title' }, 'What it does'),
      h('p', { class: 'sentence' }, g.targets.length ? `${g.label || data.newId} catches ${g.targets.map(targetText).join(', ')} on ${g.edge}; everything else passes unchanged.` : `${g.label || data.newId} checks for nothing yet.`)),
    onSave: async (ctx, { force } = {}) => {
      if (data.newId !== g.id && !ops.renameGuard(doc, g.id, data.newId)) return { problems: [`Cannot rename to ${data.newId}.`] };
      const r = await saveChecked(doc, { type: 'guard', id: data.newId }, force);
      if (r === true) toast(mode === 'add' ? `Guard ${data.newId} added on ${g.edge}.` : `Guard ${data.newId} saved.`);
      return r;
    },
  });
}

/** What catching a target does, in the words of Definition (Guardrail). */
export function catchSentence(t) {
  if ('mode' in t) { const th = t.threshold || 1; return `When it catches ${t.mode} ≥ ${th}, the message goes on with ${t.mode} capped at ${th - 1}; a message that exists only because a failure row created it is dropped, unless the guard lies on a cycle.`; }
  if ('taint' in t) return 'When it catches taint, the message goes on clean (its output is a closed set).';
  if ('conf' in t) return `When it catches confidentiality above ${t.conf}, the message goes on at ${t.conf} (redacted).`;
  return `When it catches authority below ${t.auth}, the message goes on with ${t.auth} (approved).`;
}

// ---------------------------------------------------------------- observation point
export function openObsDialog(oid, { edge: edgeId, startAt } = {}) {
  const doc = cloneDoc();
  const fields = modeFields(doc);
  const mode = oid ? 'edit' : 'add';
  let o = oid ? doc.observation_points.find((x) => x.id === oid) : null;
  if (oid && !o) return;
  if (!o) {
    const e = edge(doc, edgeId);
    const recv = e ? parseRef(e.to)[0] === 'sys' ? parseRef(e.to)[1] : parseRef(e.to)[0] : 'point';
    const id = uniqueId(`o_${recv}`, new Set(doc.observation_points.map((x) => x.id)));
    o = { id, edge: edgeId, label: id, tolerate: Object.fromEntries(topModes(doc).map((m) => [m, 1])) };
    doc.observation_points.push(o);
  }
  o.tolerate = o.tolerate || {};
  const data = { newId: o.id };
  const conf = doc.lattices.confidentiality, auth = doc.lattices.authority;
  const receiver = () => { const e = edge(doc, o.edge); const [ro] = e ? parseRef(e.to) : ['sys']; return ro !== 'sys' ? comp(doc, ro) : null; };

  const point = (ctx) => h('div', { class: 'fields2' },
    field('Name', textInput(o.label, (v) => { o.label = v; ctx.update(); }, { placeholder: 'e.g. bank statement' })),
    field('Id', textInput(data.newId, (v) => { data.newId = v.trim(); ctx.update(); }, { class: 'mono', spellcheck: 'false' }), 'Witnesses and verdict cells name the point by its id.'),
    field('Observes the edge', selectInput(doc.edges.map((x) => [x.id, `${x.id}: ${x.from} → ${x.to}`, doc.observation_points.some((y) => y !== o && y.edge === x.id)]), o.edge, (v) => { o.edge = v; ctx.rerender(); }),
      'It judges what the receiver gets, after every guard on the edge. One point per edge.', { wide: true }),
    field('Where the log comes from', textInput(o.log, (v) => { o.log = v || undefined; ctx.update(); }, { placeholder: 'e.g. the bank statement (CSV export)' }), null, { wide: true }));

  const judges = (ctx) => {
    const grid = h('div', { class: 'tolgrid big' });
    for (const f of fields) {
      const judged = f.name in o.tolerate;
      const th = o.tolerate[f.name];
      grid.append(
        h('label', { class: `inline${f.parent ? ' sub' : ''}` }, h('input', { type: 'checkbox', checked: judged, onchange: (ev) => { if (ev.target.checked) o.tolerate[f.name] = 1; else delete o.tolerate[f.name]; ctx.rerender(); } }), h('span', { class: 'mono' }, f.name)),
        judged ? h('span', { class: 'inline small' }, 'reached from', numberInput(th, (v) => { o.tolerate[f.name] = v; ctx.update(); }, { min: 1, max: 10, 'aria-label': `${f.name} threshold` })) : h('span', { class: 'small muted' }, 'not judged'),
        h('span', { class: 'small muted' }, judged ? (th <= 1 ? 'accepts none' : `accepts up to ${th - 1}`) : ''));
    }
    return h('div', { class: 'block' }, h('p', { class: 'hint' }, 'Tick each failure this point judges, and the magnitude from which it counts as reaching the point. 1 accepts none. Each ticked mode is a cell of the verdict table.'), grid);
  };

  const prov = (ctx) => {
    const r = receiver();
    const opts = (levels, mine, what) => [['', 'not judged'], ...(r ? [['receiver', `the receiver's ${what} (${mine})`]] : []), ...levels.map((l) => [l, l])];
    return h('div', { class: 'block' },
      checkInput('Flags any tainted message', o.taint === 'reject', (v) => { if (v) o.taint = 'reject'; else delete o.taint; ctx.update(); }, 'The receiver tolerates no text from outside the system.'),
      h('div', { class: 'fields2' },
        field('Confidentiality above', selectInput(opts(conf, r && (r.clearance || conf.at(-1)), 'clearance'), o.clearance || '', (v) => { if (v) o.clearance = v; else delete o.clearance; ctx.update(); })),
        field('Authority below', selectInput(opts(auth, r && (r.requires || auth[0]), 'required authority'), o.requires || '', (v) => { if (v) o.requires = v; else delete o.requires; ctx.update(); }))),
      h('p', { class: 'hint' }, r ? `Judged against its receiver ${r.id}: a message more confidential than the clearance, or with less authority than required, reaches this point.` : 'The receiver is outside the model, so name the levels it demands.'));
  };

  const judgesNothing = () => !Object.keys(o.tolerate).length && o.taint !== 'reject' && !o.clearance && !o.requires;
  wizard({
    title: mode === 'add' ? 'New observation point' : `Edit ${o.label || o.id}`, mode, size: 'lg', startAt,
    subtitle: 'An observation point is an edge where a log exists; it judges what the receiver gets.',
    saveLabel: mode === 'add' ? 'Add observation point' : 'Save',
    steps: [
      { id: 'point', title: 'The point', render: point,
        problems: () => [(() => { const t = new Set(doc.observation_points.filter((x) => x !== o).map((x) => x.id)); return idProblem(data.newId, t); })(),
          doc.observation_points.some((x) => x !== o && x.edge === o.edge) ? `${o.edge} already has an observation point.` : null].filter(Boolean) },
      { id: 'judges', title: 'Failures it judges', render: judges,
        problems: () => [judgesNothing() ? 'It judges nothing yet: tick a failure here or a provenance check in the next step.' : null,
          ...Object.entries(o.tolerate).filter(([, v]) => !(v >= 1 && v <= 10)).map(([k]) => `The threshold of ${k} is a magnitude from 1 to 10.`)].filter(Boolean) },
      { id: 'prov', title: 'Provenance', render: prov },
    ],
    onSave: async (ctx, { force } = {}) => {
      if (data.newId !== o.id && !ops.renameObs(doc, o.id, data.newId)) return { problems: [`Cannot rename to ${data.newId}.`] };
      const r = await saveChecked(doc, { type: 'obs', id: data.newId }, force);
      if (r === true) toast(mode === 'add' ? `Observation point ${data.newId} added.` : `${data.newId} saved.`);
      return r;
    },
  });
}

// ---------------------------------------------------------------- edge
export function openEdgeDialog(eid) {
  const doc = cloneDoc();
  const e = edge(doc, eid);
  if (!e) return;
  const [fo] = parseRef(e.from), [to] = parseRef(e.to);
  const fc = fo !== 'sys' && comp(doc, fo), tc = to !== 'sys' && comp(doc, to);
  wizard({
    title: `Edit edge ${eid}`, subtitle: `${e.from} → ${e.to}`, mode: 'edit', size: 'md',
    steps: [{ id: 'edge', title: 'Edge', render: (ctx) => h('div', { class: 'fields2' },
      field('Label', textInput(e.label, (v) => { e.label = v; ctx.update(); }, { placeholder: 'what flows here' }), null, { wide: true }),
      fc ? field(`From an output of ${fo}`, selectInput(fc.out.map((q) => [q, `${fo}.${q}`]), parseRef(e.from)[1], (v) => { ops.moveEdgeEnd(doc, eid, 'from', v); ctx.update(); })) : field('From', h('span', { class: 'mono' }, e.from)),
      tc ? field(`To an input of ${to}`, selectInput(tc.in.map((q) => [q, `${to}.${q}`]), parseRef(e.to)[1], (v) => { ops.moveEdgeEnd(doc, eid, 'to', v); ctx.update(); })) : field('To', h('span', { class: 'mono' }, e.to))) }],
    onSave: (ctx, { force } = {}) => saveChecked(doc, { type: 'edge', id: eid }, force),
  });
}

// ---------------------------------------------------------------- system port
export function openSysDialog(name) {
  const doc = cloneDoc();
  const data = { name };
  const dir = sysPorts(doc).ins.includes(name) ? 'input' : 'output';
  wizard({
    title: `Edit system ${dir} ${name}`, mode: 'edit', size: 'sm',
    steps: [{ id: 'sys', title: 'System port', render: (ctx) => h('div', { class: 'block' },
      field('Name', textInput(data.name, (v) => { data.name = v.trim(); ctx.update(); }, { class: 'mono' }), dir === 'input' ? 'Use cases name the input they enter at; they are renamed with it.' : null)),
    problems: () => [data.name === name ? null : idProblem(data.name, new Set([...Object.keys(doc.layout.sys), ...sysPorts(doc).ins, ...sysPorts(doc).outs]), 'The name')].filter(Boolean) }],
    onSave: (ctx, { force } = {}) => {
      if (data.name !== name) ops.renameSysPort(doc, name, data.name);
      return saveChecked(doc, { type: 'sys', id: `sys:${data.name}` }, force);
    },
  });
}

// ---------------------------------------------------------------- use case
export function openUseCaseDialog(ucId, { port } = {}) {
  const doc = cloneDoc();
  const ins = sysPorts(doc).ins;
  const fields = modeFields(doc).map((m) => m.name);
  const conf = doc.lattices.confidentiality, auth = doc.lattices.authority;
  const mode = ucId ? 'edit' : 'add';
  let u = ucId ? doc.use_cases.find((x) => x.id === ucId) : null;
  if (ucId && !u) return;
  if (!u) {
    let i = doc.use_cases.length + 1; while (doc.use_cases.some((x) => x.id === `uc${i}`)) i++;
    u = { id: `uc${i}`, label: '', entries: [{ port: port || ins[0], token: {} }] };
    doc.use_cases.push(u);
  }
  if (!u.entries) u.entries = [{ port: (u.entry || '').replace('sys.', ''), token: u.token || {} }];
  const data = { newId: u.id };

  const entries = (ctx) => {
    const box = h('div', { class: 'block' });
    u.entries.forEach((en, i) => {
      en.token = en.token || {};
      const t = en.token;
      const carries = Object.entries(t.modes || {});
      box.appendChild(h('div', { class: 'card' },
        h('div', { class: 'edit-line' },
          field('Enters at', selectInput(ins.map((p) => [p, `sys.${p}`]), en.port, (v) => { en.port = v; ctx.update(); })),
          field('Confidentiality', selectInput(levelOpts(conf), t.conf || conf[0], (v) => { t.conf = v; ctx.update(); })),
          field('Authority', selectInput(levelOpts(auth), t.auth || auth.at(-1), (v) => { t.auth = v; ctx.update(); })),
          h('span', { class: 'spacer' }), u.entries.length > 1 ? button('Remove', () => { u.entries.splice(i, 1); ctx.rerender(); }, { small: true, ghost: true }) : null),
        checkInput('Tainted (text from outside the system)', t.taint, (v) => { t.taint = v || undefined; ctx.update(); }),
        h('span', { class: 'f-label' }, 'Failures it already carries'),
        ...carries.map(([m, k]) => h('div', { class: 'edit-line' },
          selectInput(fields.map((f) => [f, f]), m, (v) => { const val = t.modes[m]; delete t.modes[m]; t.modes[v] = val; ctx.rerender(); }),
          h('span', { class: 'small muted' }, 'at'), numberInput(k, (v) => { t.modes[m] = v; ctx.update(); }, { min: 1, max: 10 }),
          button('Remove', () => { delete t.modes[m]; if (!Object.keys(t.modes).length) delete t.modes; ctx.rerender(); }, { small: true, ghost: true }))),
        h('div', {}, button('+ A failure it already carries', () => { t.modes = t.modes || {}; const f = fields.find((x) => !(x in t.modes)); if (f) t.modes[f] = 1; ctx.rerender(); }, { small: true }))));
    });
    box.appendChild(h('div', {}, button('+ Another input in the same use case', () => { u.entries.push({ port: ins[0], token: {} }); ctx.rerender(); }, { small: true, disabled: !ins.length })));
    return box;
  };

  wizard({
    title: mode === 'add' ? 'New use case' : `Edit use case ${u.id}`, mode, size: 'lg',
    subtitle: 'A use case is where messages enter the system and what they already carry: the all-clear token unless you say otherwise.',
    saveLabel: mode === 'add' ? 'Add use case' : 'Save',
    steps: [
      { id: 'uc', title: 'The use case', render: (ctx) => h('div', { class: 'fields2' },
        field('Id', textInput(data.newId, (v) => { data.newId = v.trim(); ctx.update(); }, { class: 'mono' }), 'Recognisers and certificate scopes name it.'),
        field('What happens', textInput(u.label, (v) => { u.label = v; ctx.update(); }, { placeholder: 'e.g. pay an incoming invoice under the mandate' }), null, { wide: true })),
      problems: () => [idProblem(data.newId, new Set(doc.use_cases.filter((x) => x !== u).map((x) => x.id)))].filter(Boolean) },
      { id: 'entries', title: 'Where it enters', render: entries,
        problems: () => [!ins.length ? 'The model has no system input yet: add one from the palette and wire it.' : null,
          !u.entries.length ? 'A use case enters at least one input.' : null,
          ...u.entries.filter((en) => !ins.includes(en.port)).map((en) => `sys.${en.port} is not a system input.`),
          ...u.entries.flatMap((en) => Object.entries((en.token || {}).modes || {}).filter(([, k]) => !(k >= 1 && k <= 10)).map(([m]) => `The magnitude of ${m} is from 1 to 10.`))].filter(Boolean) },
    ],
    onSave: async (ctx, { force } = {}) => {
      // certificate scopes and recognisers name use cases; rename them in the model's claims only
      u.id = data.newId;
      return saveChecked(doc, S.selection, force);
    },
  });
}

export async function deleteUseCase(ucId) {
  if (!await confirmDialog(`Delete use case ${ucId}?`, { title: 'Delete the use case', okText: 'Delete', danger: true })) return;
  const doc = cloneDoc();
  doc.use_cases = doc.use_cases.filter((u) => u.id !== ucId);
  commitDoc(doc, S.selection);
}

// ---------------------------------------------------------------- claim
export function openClaimDialog(index) {
  const doc = cloneDoc();
  const cells = (S.check && S.check.cells || []).map((c) => c.cell);
  const mode = index === undefined || index === null ? 'add' : 'edit';
  const cl = mode === 'edit' ? doc.claims[index] : { cell: cells[0] || '', verdict: 'guarantee', by: '' };
  if (mode === 'add') doc.claims.push(cl);
  wizard({
    title: mode === 'add' ? 'New claim' : 'Edit claim', mode: 'edit', size: 'md', saveLabel: mode === 'add' ? 'Add claim' : 'Save',
    subtitle: 'A claim is what someone says a cell\'s verdict is; the analysis says whether the evidence supports it.',
    steps: [{ id: 'claim', title: 'Claim', render: (ctx) => h('div', { class: 'fields2' },
      field('Cell (failure @ observation point)', selectInput((cells.includes(cl.cell) || !cl.cell ? cells : [cl.cell, ...cells]).map((c) => [c, c]), cl.cell, (v) => { cl.cell = v; ctx.update(); }), null, { wide: true }),
      field('Claimed verdict', selectInput([['guarantee', 'guarantee'], ['hope', 'hope'], ['exposed', 'exposed']], cl.verdict, (v) => { cl.verdict = v; ctx.update(); })),
      field('Claimed by', textInput(cl.by, (v) => { cl.by = v; ctx.update(); }, { placeholder: 'e.g. wallet team' })),
      field('Note', textInput(cl.note, (v) => { cl.note = v || undefined; ctx.update(); }), null, { wide: true })),
    problems: () => [cl.cell ? null : 'Choose the cell the claim is about (the model check lists the cells).'].filter(Boolean) }],
    onSave: (ctx, { force } = {}) => saveChecked(doc, S.selection, force),
  });
}

export async function deleteClaim(index) {
  if (!await confirmDialog('Delete this claim?', { title: 'Delete the claim', okText: 'Delete', danger: true })) return;
  const doc = cloneDoc();
  doc.claims.splice(index, 1);
  commitDoc(doc, S.selection);
}

// ---------------------------------------------------------------- the model's settings
export function openModelDialog({ startAt } = {}) {
  const doc = cloneDoc();
  const data = {
    modes: (doc.modes || []).map((m) => (typeof m === 'string' ? { name: m, subs: '' }
      : m.name ? { name: m.name, subs: (m.subkinds || []).join(', ') } : { name: Object.keys(m)[0], subs: (Object.values(m)[0] || []).join(', ') })),
    conf: doc.lattices.confidentiality.join('\n'), auth: doc.lattices.authority.join('\n'),
  };
  const lines = (s) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  const modeProblems = () => {
    const names = data.modes.flatMap((m) => [m.name.trim(), ...lines(m.subs)]);
    const p = [];
    if (!data.modes.length) p.push('A model needs at least one failure mode.');
    for (const n of names) if (!IDENT.test(n)) p.push(`"${n || '(empty)'}" is not an identifier.`);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) p.push(`${[...new Set(dup)].join(', ')} appear(s) twice.`);
    return [...new Set(p)];
  };
  const latProblems = () => [['Confidentiality', data.conf], ['Authority', data.auth]].flatMap(([n, s]) => {
    const l = lines(s);
    return [l.length ? null : `${n} needs at least one level.`, new Set(l).size === l.length ? null : `${n} lists a level twice.`];
  }).filter(Boolean);
  wizard({
    title: 'Model settings', subtitle: doc.name, mode: 'edit', size: 'lg', startAt,
    steps: [
      { id: 'general', title: 'General', render: (ctx) => h('div', { class: 'fields2' },
        field('Name', textInput(doc.name, (v) => { doc.name = v; ctx.update(); }), null, { wide: true }),
        field('Description', textInput(doc.description, (v) => { doc.description = v; ctx.update(); }, { multiline: true, rows: 5 }), null, { wide: true }),
        field('Worst-case defaults', checkInput('for every component (FPTC style)', doc.worst_case_defaults === 'all', (v) => { if (v) doc.worst_case_defaults = 'all'; else delete doc.worst_case_defaults; ctx.update(); }),
          'On: every component starts with one open row per output and failure mode (any message in, that failure at 10 out), so a component nobody modelled is never a guarantee; a certificate, a row of yours or a dropped default with a reason earns one. Off: only LLM components get them.', { wide: true })) },
      { id: 'modes', title: 'Failure modes', problems: modeProblems,
        hint: 'The behavioural failure modes. A mode may have sub-kinds (a failure of the parent mode): a guard that catches the parent catches them too. Renaming or removing a mode does not rename it in rows, guards or points: the check lists what then needs fixing.',
        render: (ctx) => h('div', { class: 'block' },
          ...data.modes.map((m, i) => h('div', { class: 'edit-line' },
            field('Mode', textInput(m.name, (v) => { m.name = v; ctx.update(); }, { class: 'mono' })),
            field('Sub-kinds (comma separated)', textInput(m.subs, (v) => { m.subs = v; ctx.update(); }, { class: 'mono', placeholder: 'e.g. oom, dup' }), null, { inline: true }),
            h('span', { class: 'spacer' }), button('Remove', () => { data.modes.splice(i, 1); ctx.rerender(); }, { small: true, ghost: true }))),
          h('div', {}, button('+ Add a mode', () => { data.modes.push({ name: '', subs: '' }); ctx.rerender(); }, { small: true }))) },
      { id: 'lattices', title: 'Levels', problems: latProblems, hint: 'One level per line, from the lowest to the highest.',
        render: (ctx) => h('div', { class: 'fields2' },
          field('Confidentiality', textInput(data.conf, (v) => { data.conf = v; ctx.update(); }, { multiline: true, rows: 5, class: 'mono' })),
          field('Authority', textInput(data.auth, (v) => { data.auth = v; ctx.update(); }, { multiline: true, rows: 5, class: 'mono' }))) },
    ],
    onSave: (ctx, { force } = {}) => {
      doc.modes = data.modes.map((m) => (lines(m.subs).length ? { [m.name.trim()]: lines(m.subs) } : m.name.trim()));
      doc.lattices.confidentiality = lines(data.conf);
      doc.lattices.authority = lines(data.auth);
      return saveChecked(doc, S.selection, force);
    },
  });
}
