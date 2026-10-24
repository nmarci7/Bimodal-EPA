// The inspector: edit whatever is selected on the canvas; with nothing selected, the model itself.
import { h, clear } from './lib.js';
import { S, on, comp, edge, parseRef, modeFields, topModes, sysPorts, changed, renameComponent, renamePort, addGuard, addObs, removeSelection, emit } from './state.js';

const ACT = [['open', 'open (a candidate choice)'], ['always', 'always (fixed)'], ['sometimes', 'sometimes (fixed)'], ['never', 'never (fixed)']];
const KINDS = ['llm', 'deterministic', 'tool', 'store', 'external', 'user'];

export class Inspector {
  constructor(host) {
    this.host = host;
    on('select', () => this.render());
    on('loaded', () => this.render());
    on('check', () => this.renderGenerated());
  }

  field(label, value, onInput, opts = {}) {
    const input = opts.options
      ? h('select', { onchange: (e) => onInput(e.target.value) }, opts.options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) ? true : undefined }, t)))
      : h(opts.textarea ? 'textarea' : 'input', { value: value ?? '', type: opts.type || 'text', class: opts.mono ? 'mono' : undefined, onchange: (e) => onInput(e.target.value) });
    return h('label', { class: `field${opts.wide ? ' wide' : ''}` }, label, input);
  }
  check(label, value, onInput) {
    return h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onInput(e.target.checked) }), label);
  }

  render() {
    clear(this.host);
    if (!S.doc) return;
    const sel = S.selection;
    if (!sel) this.renderModel();
    else if (sel.type === 'component') this.renderComponent(comp(S.doc, sel.id));
    else if (sel.type === 'sys') this.renderSys(sel.id.slice(4));
    else if (sel.type === 'edge') this.renderEdge(edge(S.doc, sel.id));
    else if (sel.type === 'guard') this.renderGuard(S.doc.guards.find((g) => g.id === sel.id));
    else if (sel.type === 'obs') this.renderObs(S.doc.observation_points.find((o) => o.id === sel.id));
    this.genHost = h('div', { class: 'block' });
    this.host.appendChild(this.genHost);
    this.renderGenerated();
  }

  head(title, chip, chipClass) {
    return h('div', { class: 'insp-head' }, h('span', { class: 'title' }, title), chip ? h('span', { class: `kind-chip ${chipClass || ''}` }, chip) : null,
      h('span', { class: 'spacer' }), S.selection ? h('button', { class: 'btn small danger', onclick: () => { removeSelection(); emit('select'); } }, 'Delete') : null);
  }

  // ---------------------------------------------------------------- the model
  renderModel() {
    const d = S.doc;
    const lat = d.lattices;
    const modesText = (d.modes || []).map((m) => (typeof m === 'string' ? m : Object.entries(m).map(([k, v]) => `${k}: ${(v || []).join(', ')}`).join(''))).join('\n');
    this.host.append(
      h('div', { class: 'insp-head' }, h('span', { class: 'title' }, d.name || 'model'), h('span', { class: 'kind-chip' }, 'model')),
      h('div', { class: 'fields' },
        this.field('Name', d.name, (v) => { d.name = v; changed(); }),
        this.field('Description', d.description, (v) => { d.description = v; changed(); }, { wide: true, textarea: true }),
        this.field('Failure modes (one per line; "commission: oom, dup" adds sub-kinds)', modesText, (v) => {
          d.modes = v.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
            if (!l.includes(':')) return l;
            const [k, rest] = l.split(':'); return { [k.trim()]: rest.split(',').map((x) => x.trim()).filter(Boolean) };
          });
          changed();
        }, { wide: true, textarea: true, mono: true }),
        this.field('Confidentiality levels (low → high)', lat.confidentiality.join(', '), (v) => { lat.confidentiality = v.split(',').map((x) => x.trim()).filter(Boolean); changed(); }, { wide: true, mono: true }),
        this.field('Authority levels (low → high)', lat.authority.join(', '), (v) => { lat.authority = v.split(',').map((x) => x.trim()).filter(Boolean); changed(); }, { wide: true, mono: true })),
      this.useCases(), this.claims(),
      h('p', { class: 'hint' }, 'Select a component, an edge, a guard or an eye on the canvas to edit it. Drag a palette item onto the canvas; drag from the round handle on a component to another one to connect them.'));
  }

  useCases() {
    const d = S.doc;
    const ins = sysPorts(d).ins;
    const fields = modeFields(d).map((m) => m.name);
    const box = h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'section-title' }, 'Use cases'),
      h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => { d.use_cases.push({ id: `uc${d.use_cases.length + 1}`, label: '', entries: ins.length ? [{ port: ins[0], token: {} }] : [] }); changed(); this.render(); } }, 'Add use case')));
    for (const u of d.use_cases) {
      if (!u.entries) u.entries = [{ port: (u.entry || '').replace('sys.', ''), token: u.token || {} }];
      const card = h('div', { class: 'card' },
        h('div', { class: 'inline' }, h('input', { value: u.id, class: 'mono', style: 'width:110px', onchange: (e) => { u.id = e.target.value; changed(); } }),
          h('input', { value: u.label || '', placeholder: 'what happens', style: 'flex:1', onchange: (e) => { u.label = e.target.value; changed(); } }),
          h('button', { class: 'x', 'aria-label': 'remove use case', onclick: () => { d.use_cases = d.use_cases.filter((x) => x !== u); changed(); this.render(); } }, '×')));
      for (const en of u.entries) {
        en.token = en.token || {};
        const t = en.token;
        card.appendChild(h('div', { class: 'inline' },
          h('select', { onchange: (e) => { en.port = e.target.value; changed(); } }, ins.map((p) => h('option', { value: p, selected: p === en.port ? true : undefined }, `sys.${p}`))),
          h('label', { class: 'inline small' }, h('input', { type: 'checkbox', checked: !!t.taint, onchange: (e) => { t.taint = e.target.checked; changed(); } }), 'tainted'),
          h('select', { title: 'confidentiality', onchange: (e) => { t.conf = e.target.value; changed(); } }, d.lattices.confidentiality.map((l) => h('option', { value: l, selected: (t.conf || d.lattices.confidentiality[0]) === l ? true : undefined }, l))),
          h('select', { title: 'authority', onchange: (e) => { t.auth = e.target.value; changed(); } }, d.lattices.authority.map((l) => h('option', { value: l, selected: (t.auth || d.lattices.authority.at(-1)) === l ? true : undefined }, l))),
          h('input', { placeholder: 'failures, e.g. oom=9', class: 'mono', style: 'width:120px', value: Object.entries(t.modes || {}).map(([k, v]) => `${k}=${v}`).join(' '),
            onchange: (e) => { t.modes = Object.fromEntries(e.target.value.split(/[\s,]+/).filter((x) => x.includes('=') && fields.includes(x.split('=')[0])).map((x) => [x.split('=')[0], Number(x.split('=')[1])])); changed(); } }),
          h('button', { class: 'x', 'aria-label': 'remove entry', onclick: () => { u.entries = u.entries.filter((x) => x !== en); changed(); this.render(); } }, '×')));
      }
      card.appendChild(h('button', { class: 'btn small', onclick: () => { u.entries.push({ port: ins[0], token: {} }); changed(); this.render(); } }, 'Add an entry'));
      box.appendChild(card);
    }
    if (!ins.length) box.appendChild(h('p', { class: 'hint' }, 'Add a system input (palette) and connect it: use cases start there.'));
    return box;
  }

  claims() {
    const d = S.doc;
    const cells = (S.check && S.check.cells || []).map((c) => c.cell);
    const box = h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'section-title' }, 'Claims'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => { d.claims.push({ cell: cells[0] || '', verdict: 'guarantee', by: '' }); changed(); this.render(); } }, 'Add claim')));
    for (const cl of d.claims) {
      box.appendChild(h('div', { class: 'inline' },
        h('select', { onchange: (e) => { cl.cell = e.target.value; changed(); } }, (cells.includes(cl.cell) ? cells : [cl.cell, ...cells]).map((c) => h('option', { value: c, selected: c === cl.cell ? true : undefined }, c))),
        h('select', { onchange: (e) => { cl.verdict = e.target.value; changed(); } }, ['guarantee', 'hope', 'exposed'].map((v) => h('option', { value: v, selected: v === cl.verdict ? true : undefined }, v))),
        h('input', { value: cl.by || '', placeholder: 'who claims it', style: 'width:110px', onchange: (e) => { cl.by = e.target.value; changed(); } }),
        h('button', { class: 'x', 'aria-label': 'remove claim', onclick: () => { d.claims = d.claims.filter((x) => x !== cl); changed(); this.render(); } }, '×')));
    }
    return box;
  }

  // ---------------------------------------------------------------- a component
  renderComponent(c) {
    const d = S.doc;
    const conf = d.lattices.confidentiality, auth = d.lattices.authority;
    this.host.append(this.head(c.id, c.kind === 'llm' ? 'LLM' : c.kind, c.kind === 'llm' ? 'llm' : ''));
    this.host.append(h('div', { class: 'fields' },
      this.field('Id', c.id, (v) => { if (!renameComponent(c.id, v)) import('./lib.js').then((m) => m.toast('Ids are identifiers and must be unique.')); else this.render(); }, { mono: true }),
      this.field('Kind', c.kind, (v) => { c.kind = v; changed(); this.render(); }, { options: KINDS.map((k) => [k, k]) }),
      this.field('Label', c.label, (v) => { c.label = v; changed(); }, { wide: true }),
      this.field('Version', c.version, (v) => { c.version = v || undefined; changed(); }, { mono: true }),
      c.kind === 'llm' ? null : this.field('Passes unchanged ("all" or modes)', Array.isArray(c.pass) ? c.pass.join(', ') : (c.pass || ''), (v) => { c.pass = v.trim() === 'all' ? 'all' : v.split(',').map((x) => x.trim()).filter(Boolean); changed(); }, { mono: true }),
      this.field('Authority', c.authority || auth.at(-1), (v) => { c.authority = v; changed(); }, { options: auth.map((l) => [l, l]) }),
      this.field('Clearance', c.clearance || conf.at(-1), (v) => { c.clearance = v; changed(); }, { options: conf.map((l) => [l, l]) }),
      this.check('trusted (an untrusted component taints what it touches)', c.trusted !== undefined ? c.trusted : !['external', 'user'].includes(c.kind), (v) => { c.trusted = v; changed(); }),
      this.check('raises authority (acts on its own authority)', c.raises, (v) => { c.raises = v; changed(); })));
    this.host.append(this.ports(c), this.flow(c), this.rows(c));
    if (c.kind === 'llm') this.host.append(this.defaults(c));
  }

  ports(c) {
    const box = h('div', { class: 'block' }, h('span', { class: 'section-title' }, 'Ports'));
    for (const side of ['in', 'out']) {
      box.appendChild(h('div', { class: 'inline' }, h('span', { class: 'small muted', style: 'width:28px' }, side),
        c[side].map((p) => h('input', { value: p, class: 'mono', style: 'width:110px', onchange: (e) => { if (!renamePort(c.id, side, p, e.target.value)) import('./lib.js').then((m) => m.toast('Port names are identifiers and must be unique.')); this.render(); } })),
        c[side].length ? null : h('span', { class: 'small muted' }, side === 'in' ? 'connect something to it' : 'connect it to something')));
    }
    return box;
  }

  flow(c) {
    if (!c.in.length || !c.out.length) return h('div');
    const flow = c.flow || Object.fromEntries(c.in.map((p) => [p, c.out.slice()]));
    const table = h('table', { class: 'flow-table' }, h('tr', {}, h('th', {}, 'in \\ out'), c.out.map((q) => h('th', {}, q))),
      c.in.map((p) => h('tr', {}, h('td', {}, p), c.out.map((q) => h('td', {}, h('input', { type: 'checkbox', checked: (flow[p] || []).includes(q),
        onchange: (e) => { c.flow = c.flow || JSON.parse(JSON.stringify(flow)); const l = new Set(c.flow[p] || []); if (e.target.checked) l.add(q); else l.delete(q); c.flow[p] = [...l]; changed(); } }))))));
    return h('div', { class: 'block' }, h('span', { class: 'section-title' }, 'Normal flow'), h('p', { class: 'hint' }, 'Which input sends a message to which output on the happy path.'), table);
  }

  rows(c) {
    const fields = modeFields(S.doc).map((m) => m.name);
    const box = h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'section-title' }, 'Rows'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => {
        const ids = new Set(S.doc.components.flatMap((x) => (x.rows || []).map((r) => r.id)));
        let i = 1; while (ids.has(`${c.id}_r${i}`)) i++;
        c.rows.push({ id: `${c.id}_r${i}`, when: { [c.in[0] || '*']: 'any' }, then: c.out[0] ? { [c.out[0]]: { [fields[0]]: 'const 5' } } : {} });
        changed(); this.render();
      } }, 'Add row')));
    if (c.kind === 'llm') box.appendChild(h('p', { class: 'hint' }, 'LLM rows are never "never": a candidate may only make them sometimes or always.'));
    for (const r of c.rows) box.appendChild(this.rowCard(c, r, fields));
    return box;
  }

  rowCard(c, r, fields) {
    r.when = r.when || {}; r.then = r.then || {};
    const card = h('div', { class: 'card' });
    card.appendChild(h('div', { class: 'inline' },
      h('input', { value: r.id, class: 'mono', style: 'width:130px', onchange: (e) => { r.id = e.target.value; changed(); } }),
      h('select', { onchange: (e) => { if (e.target.value === 'open') delete r.activation; else r.activation = e.target.value; changed(); } },
        ACT.filter(([v]) => !(c.kind === 'llm' && v === 'never')).map(([v, t]) => h('option', { value: v, selected: (r.activation || 'open') === v ? true : undefined }, t))),
      h('button', { class: 'x', 'aria-label': 'remove row', onclick: () => { c.rows = c.rows.filter((x) => x !== r); changed(); this.render(); } }, '×')));
    card.appendChild(h('input', { value: r.label || '', placeholder: 'what this failure is, in words', style: 'height:30px;border:1px solid var(--line2);border-radius:6px;padding:0 8px', onchange: (e) => { r.label = e.target.value; changed(); } }));
    // when
    card.appendChild(h('span', { class: 'small muted' }, 'when'));
    for (const [port, pat] of Object.entries(r.when)) {
      const isAny = pat === 'any' || pat === true || pat === null;
      const [m0, th0] = isAny ? [fields[0], 1] : Object.entries(pat)[0] || [fields[0], 1];
      card.appendChild(h('div', { class: 'inline' },
        h('select', { onchange: (e) => { const v = r.when[port]; delete r.when[port]; r.when[e.target.value] = v; changed(); this.render(); } },
          ['*', ...c.in].map((p) => h('option', { value: p, selected: p === port ? true : undefined }, p === '*' ? 'any input' : p))),
        h('select', { onchange: (e) => { r.when[port] = e.target.value === 'any' ? 'any' : { [m0]: th0 }; changed(); this.render(); } },
          [['any', 'any message'], ['mode', 'a failure ≥']].map(([v, t]) => h('option', { value: v, selected: (isAny ? 'any' : 'mode') === v ? true : undefined }, t))),
        isAny ? null : h('select', { onchange: (e) => { r.when[port] = { [e.target.value]: th0 }; changed(); } }, fields.map((f) => h('option', { value: f, selected: f === m0 ? true : undefined }, f))),
        isAny ? null : h('input', { type: 'number', min: 1, max: 10, value: th0, onchange: (e) => { r.when[port] = { [m0]: Number(e.target.value) }; changed(); } }),
        h('button', { class: 'x', 'aria-label': 'remove condition', onclick: () => { delete r.when[port]; changed(); this.render(); } }, '×')));
    }
    card.appendChild(h('button', { class: 'btn small', onclick: () => { const free = ['*', ...c.in].find((p) => !(p in r.when)); if (free) { r.when[free] = 'any'; changed(); this.render(); } } }, 'and when…'));
    // then
    card.appendChild(h('span', { class: 'small muted' }, 'then emit'));
    for (const [port, emits] of Object.entries(r.then)) {
      for (const [m, op] of Object.entries(emits || {})) {
        const o = String(op).trim();
        const kind = o.startsWith('const') || /^\d+$/.test(o) ? 'const' : o.startsWith('+') ? 'plus' : o;
        const k = kind === 'const' ? Number(o.replace('const', '').trim()) : kind === 'plus' ? Number(o.slice(1)) : 0;
        const setOp = (nk, nv) => { r.then[port][m] = nk === 'const' ? `const ${nv}` : nk === 'plus' ? `+${nv}` : nk; changed(); };
        card.appendChild(h('div', { class: 'inline' },
          h('select', { onchange: (e) => { const v = r.then[port][m]; delete r.then[port][m]; if (!Object.keys(r.then[port]).length) delete r.then[port]; (r.then[e.target.value] = r.then[e.target.value] || {})[m] = v; changed(); this.render(); } },
            c.out.map((p) => h('option', { value: p, selected: p === port ? true : undefined }, p))),
          h('select', { onchange: (e) => { const v = r.then[port][m]; delete r.then[port][m]; r.then[port][e.target.value] = v; changed(); this.render(); } }, fields.map((f) => h('option', { value: f, selected: f === m ? true : undefined }, f))),
          h('select', { onchange: (e) => { setOp(e.target.value, e.target.value === 'plus' ? 2 : 5); this.render(); } },
            [['const', 'const'], ['keep', 'keep'], ['plus', '+k'], ['max', 'max']].map(([v, t]) => h('option', { value: v, selected: v === kind ? true : undefined }, t))),
          ['const', 'plus'].includes(kind) ? h('input', { type: 'number', min: 0, max: 10, value: k, onchange: (e) => setOp(kind, Number(e.target.value)) }) : null,
          h('button', { class: 'x', 'aria-label': 'remove emission', onclick: () => { delete r.then[port][m]; if (!Object.keys(r.then[port]).length) delete r.then[port]; changed(); this.render(); } }, '×')));
      }
    }
    if (c.out.length) card.appendChild(h('button', { class: 'btn small', onclick: () => { const p = c.out[0]; r.then[p] = r.then[p] || {}; const f = fields.find((x) => !(x in r.then[p])) || fields[0]; r.then[p][f] = 'const 5'; changed(); this.render(); } }, 'and emit…'));
    return card;
  }

  defaults(c) {
    const box = h('div', { class: 'block' }, h('span', { class: 'section-title' }, 'Worst-case defaults'),
      h('p', { class: 'hint' }, 'Every output port starts with "any message ⇒ mode const 10" for each mode. A row of yours on the same port and mode refines it; dropping one needs a recorded reason.'));
    c.drop_defaults = c.drop_defaults || [];
    for (const q of c.out) {
      for (const m of topModes(S.doc)) {
        const refined = (c.rows || []).some((r) => r.then && r.then[q] && m in r.then[q]);
        const drop = c.drop_defaults.find((x) => x.port === q && x.mode === m);
        const line = h('div', { class: 'card gen' }, h('div', { class: 'inline' }, h('b', { class: 'mono small' }, `${q} · ${m}`), h('span', { class: 'spacer' }),
          refined ? h('span', { class: 'small muted' }, 'refined by a row') : drop ? h('button', { class: 'btn small', onclick: () => { c.drop_defaults = c.drop_defaults.filter((x) => x !== drop); changed(); this.render(); } }, 'Restore')
            : h('button', { class: 'btn small', onclick: () => { c.drop_defaults.push({ port: q, mode: m, reason: '' }); changed(); this.render(); } }, 'Drop…')));
        if (drop) line.appendChild(h('input', { value: drop.reason, placeholder: 'the structural reason (required)', style: 'height:30px;border:1px solid var(--line2);border-radius:6px;padding:0 8px', onchange: (e) => { drop.reason = e.target.value; changed(); } }));
        box.appendChild(line);
      }
    }
    return box;
  }

  // ---------------------------------------------------------------- a system port
  renderSys(name) {
    const d = S.doc, p = d.layout.sys[name] || {};
    const sp = sysPorts(d);
    const dir = sp.ins.includes(name) ? 'input' : 'output';
    this.host.append(this.head(`sys.${name}`, `system ${dir}`),
      h('div', { class: 'fields' }, this.field('Name', name, (v) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return;
        for (const e of d.edges) { if (e.from === `sys.${name}`) e.from = `sys.${v}`; if (e.to === `sys.${name}`) e.to = `sys.${v}`; }
        for (const u of d.use_cases) for (const en of u.entries || []) if (en.port === name) en.port = v;
        d.layout.sys[v] = p; delete d.layout.sys[name];
        changed({ type: 'sys', id: `sys:${v}` }); this.render();
      }, { mono: true })),
      h('p', { class: 'hint' }, dir === 'input' ? 'A use case starts its tokens on the edges that leave this input.' : 'What leaves the system here is not modelled further; put an observation point on the edge into it to judge failures there.'));
  }

  // ---------------------------------------------------------------- an edge
  renderEdge(e) {
    const d = S.doc;
    this.host.append(this.head(e.id, 'edge'),
      h('div', { class: 'fields' },
        this.field('Label', e.label, (v) => { e.label = v; changed(); }, { wide: true }),
        h('div', { class: 'field wide' }, 'From → to', h('span', { class: 'mono', style: 'color: var(--ink)' }, `${e.from} → ${e.to}`))));
    const guards = d.guards.filter((g) => g.edge === e.id);
    const o = d.observation_points.find((x) => x.edge === e.id);
    this.host.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'section-title' }, 'Guards on this edge'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => { addGuard(e.id); emit('select'); } }, 'Add guard')),
      guards.length ? guards.map((g) => h('button', { class: 'btn small', onclick: () => { S.selection = { type: 'guard', id: g.id }; emit('select'); } }, `${g.label || g.id} (${g.id})`)) : h('p', { class: 'hint' }, 'None. A guard cuts the edge and catches its targets unless its leak row fires.')),
      h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'section-title' }, 'Observation point'), h('span', { class: 'spacer' }),
        o ? h('button', { class: 'btn small', onclick: () => { S.selection = { type: 'obs', id: o.id }; emit('select'); } }, `Edit ${o.id}`)
          : h('button', { class: 'btn small', onclick: () => { addObs(e.id); emit('select'); } }, 'Observe this edge')),
        h('p', { class: 'hint' }, 'An observation point judges failures on what the receiver gets: after every guard on the edge.')));
  }

  // ---------------------------------------------------------------- a guard
  renderGuard(g) {
    const d = S.doc;
    const fields = modeFields(d).map((m) => m.name);
    this.host.append(this.head(g.id, g.learned ? 'learned guard' : 'guard', 'guard'),
      h('div', { class: 'fields' },
        this.field('Id', g.id, (v) => { if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && !d.guards.some((x) => x.id === v) && !d.components.some((x) => x.id === v)) { g.id = v; changed({ type: 'guard', id: v }); this.render(); } }, { mono: true }),
        this.field('Label', g.label, (v) => { g.label = v; changed(); }),
        this.field('Version', g.version, (v) => { g.version = v || undefined; changed(); }, { mono: true }),
        this.field('On edge', g.edge, (v) => { g.edge = v; changed(); }, { options: d.edges.map((e) => [e.id, e.id]) }),
        this.check('learned (a classifier or an LLM judge)', g.learned, (v) => { g.learned = v; if (v) (g.targets || []).forEach((t) => { t.decidable = false; }); changed(); this.render(); }),
        this.check('closed output (enumerations only: may wash taint)', g.closed_output, (v) => { g.closed_output = v; changed(); }),
        g.learned ? this.field('False-positive omission', g.fp_omission ?? 10, (v) => { g.fp_omission = Number(v); changed(); }, { type: 'number' }) : null));
    const box = h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'section-title' }, 'Targets'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => { g.targets = g.targets || []; g.targets.push({ mode: fields[0], threshold: 1, decidable: !g.learned }); changed(); this.render(); } }, 'Add target')),
      h('p', { class: 'hint' }, 'Each target gets a leak row: the target gets through. Never only if the target is decidable from the data on the edge.'));
    for (const t of g.targets || []) {
      const kind = 'mode' in t ? 'mode' : 'taint' in t ? 'taint' : 'conf' in t ? 'conf' : 'auth';
      const setKind = (k) => { for (const x of ['mode', 'threshold', 'taint', 'conf', 'auth']) delete t[x];
        if (k === 'mode') Object.assign(t, { mode: fields[0], threshold: 1 }); if (k === 'taint') t.taint = true;
        if (k === 'conf') t.conf = d.lattices.confidentiality[0]; if (k === 'auth') t.auth = d.lattices.authority.at(-1); changed(); this.render(); };
      box.appendChild(h('div', { class: 'card' }, h('div', { class: 'inline' },
        h('select', { onchange: (e) => setKind(e.target.value) }, [['mode', 'a failure mode'], ['taint', 'taint'], ['conf', 'confidentiality above'], ['auth', 'authority below']].map(([v, tx]) => h('option', { value: v, selected: v === kind ? true : undefined }, tx))),
        kind === 'mode' ? h('select', { onchange: (e) => { t.mode = e.target.value; changed(); } }, fields.map((f) => h('option', { value: f, selected: f === t.mode ? true : undefined }, f))) : null,
        kind === 'mode' ? h('input', { type: 'number', min: 1, max: 10, value: t.threshold || 1, onchange: (e) => { t.threshold = Number(e.target.value); changed(); } }) : null,
        kind === 'conf' ? h('select', { onchange: (e) => { t.conf = e.target.value; changed(); } }, d.lattices.confidentiality.map((l) => h('option', { value: l, selected: l === t.conf ? true : undefined }, l))) : null,
        kind === 'auth' ? h('select', { onchange: (e) => { t.auth = e.target.value; changed(); } }, d.lattices.authority.map((l) => h('option', { value: l, selected: l === t.auth ? true : undefined }, l))) : null,
        h('button', { class: 'x', 'aria-label': 'remove target', onclick: () => { g.targets = g.targets.filter((x) => x !== t); changed(); this.render(); } }, '×')),
        g.learned ? h('span', { class: 'small muted' }, 'not decidable: learned guard') : this.check('decidable from the edge', t.decidable, (v) => { t.decidable = v; changed(); })));
    }
    this.host.append(box);
  }

  // ---------------------------------------------------------------- an observation point
  renderObs(o) {
    const d = S.doc;
    const fields = modeFields(d);
    o.tolerate = o.tolerate || {};
    this.host.append(this.head(o.id, 'observation point'),
      h('div', { class: 'fields' },
        this.field('Id', o.id, (v) => { if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) { o.id = v; changed({ type: 'obs', id: v }); this.render(); } }, { mono: true }),
        this.field('Label', o.label, (v) => { o.label = v; changed(); }),
        this.field('What is logged there', o.log, (v) => { o.log = v; changed(); }, { wide: true }),
        this.check('tolerates no taint', o.taint === 'reject', (v) => { o.taint = v ? 'reject' : 'accept'; changed(); }),
        this.field('Receiver clearance', o.clearance || '', (v) => { if (v) o.clearance = v; else delete o.clearance; changed(); }, { options: [['', 'not assessed'], ...d.lattices.confidentiality.map((l) => [l, l])] }),
        this.field('Authority required', o.requires || '', (v) => { if (v) o.requires = v; else delete o.requires; changed(); }, { options: [['', 'not assessed'], ...d.lattices.authority.map((l) => [l, l])] })));
    const box = h('div', { class: 'block' }, h('span', { class: 'section-title' }, 'Tolerations'), h('p', { class: 'hint' }, 'For each assessed mode, the lowest magnitude this point no longer accepts. Each ticked mode is a cell of the verdict table.'));
    for (const f of fields) {
      const on = f.name in o.tolerate;
      box.appendChild(h('div', { class: 'inline' },
        h('label', { class: 'inline', style: `width:150px;${f.parent ? 'padding-left:14px' : ''}` }, h('input', { type: 'checkbox', checked: on, onchange: (e) => { if (e.target.checked) o.tolerate[f.name] = 1; else delete o.tolerate[f.name]; changed(); this.render(); } }), h('span', { class: 'mono small' }, f.name)),
        on ? h('input', { type: 'number', min: 1, max: 10, value: o.tolerate[f.name], onchange: (e) => { o.tolerate[f.name] = Number(e.target.value); changed(); } }) : null));
    }
    this.host.append(box);
  }

  // ---------------------------------------------------------------- generated rows and problems
  renderGenerated() {
    if (!this.genHost) return;
    clear(this.genHost);
    const ch = S.check;
    if (!ch) return;
    if (!ch.ok) { this.genHost.appendChild(h('div', { class: 'problems' }, 'The model needs attention:', h('ul', {}, (ch.problems || []).map((p) => h('li', {}, p))))); return; }
    const sel = S.selection;
    const rows = Object.values(ch.summary.rows || {});
    let mine = [];
    if (sel && sel.type === 'component') mine = rows.filter((r) => r.comp === sel.id && r.kind !== 'row');
    if (sel && sel.type === 'guard') mine = rows.filter((r) => r.comp === sel.id);
    if (mine.length) {
      this.genHost.append(h('span', { class: 'section-title' }, 'Generated rows'));
      for (const r of mine) {
        const tag = r.kind === 'leak' ? (r.decidable ? 'N | S | A' : 'S | A') : 'S | A · LLM rule';
        this.genHost.append(h('div', { class: 'card gen' }, h('div', { class: 'inline' }, h('b', { class: 'mono small' }, r.id), h('span', { class: 'spacer' }), h('span', { class: `act${r.llm ? ' llm' : ''}` }, tag)),
          h('span', { class: 'small muted' }, r.label || '')));
      }
    }
    if (sel && sel.type === 'obs') {
      const cells = (ch.cells || []).filter((c) => c.cell.endsWith(`@${sel.id}`));
      if (cells.length) {
        this.genHost.append(h('span', { class: 'section-title' }, 'Cells and their cones'));
        for (const c of cells) this.genHost.append(h('div', { class: 'card gen' }, h('div', { class: 'inline' }, h('b', { class: 'mono small' }, c.cell), h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, `${c.candidates} candidates · ${c.runs} runs`)),
          h('span', { class: 'mono small' }, c.rows.join(', ') || 'no row can change it')));
      }
    }
  }
}
