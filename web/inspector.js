// The inspector: edit whatever is selected on the canvas; with nothing selected, the model itself.
// Each panel follows the definitions of the framework: a component with its ports and normal flow
// (its rows are in the mapping table under the canvas), a port, an edge, a guardrail with its
// targets, an observation point with its toleration, a system port with the use cases it starts.
import { h, clear, toast } from './lib.js';
import { S, on, comp, edge, parseRef, modeFields, sysPorts, changed, renameComponent, renamePort, emit,
  addPort, removePort, portEdges, moveEdgeEnd, targetText, useCasesAt } from './state.js';

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
      ? h('select', { onchange: (e) => onInput(e.target.value) }, opts.options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value ?? '') ? true : undefined }, t)))
      : h(opts.textarea ? 'textarea' : 'input', { value: value ?? '', type: opts.type || 'text', class: opts.mono ? 'mono' : undefined, placeholder: opts.placeholder, onchange: (e) => onInput(e.target.value) });
    return h('label', { class: `field${opts.wide ? ' wide' : ''}` }, label, input);
  }
  check(label, value, onInput) {
    return h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onInput(e.target.checked) }), label);
  }
  section(title, ...rest) { return h('div', { class: 'block-head' }, h('span', { class: 'section-title' }, title), h('span', { class: 'spacer' }), ...rest); }

  render() {
    clear(this.host);
    if (!S.doc) return;
    const sel = S.selection;
    const d = S.doc;
    if (!sel) this.renderModel();
    else if (sel.type === 'component' && comp(d, sel.id)) this.renderComponent(comp(d, sel.id));
    else if (sel.type === 'port') this.renderPort(sel.id);
    else if (sel.type === 'sys') this.renderSys(sel.id.slice(4));
    else if (sel.type === 'edge' && edge(d, sel.id)) this.renderEdge(edge(d, sel.id));
    else if (sel.type === 'guard' && d.guards.find((g) => g.id === sel.id)) this.renderGuard(d.guards.find((g) => g.id === sel.id));
    else if (sel.type === 'obs' && d.observation_points.find((o) => o.id === sel.id)) this.renderObs(d.observation_points.find((o) => o.id === sel.id));
    else { S.selection = null; this.renderModel(); }
    this.genHost = h('div', { class: 'block' });
    this.host.appendChild(this.genHost);
    this.renderGenerated();
  }

  head(title, chip, chipClass, deletable = true) {
    return h('div', { class: 'insp-head' }, h('span', { class: 'title' }, title), chip ? h('span', { class: `kind-chip ${chipClass || ''}` }, chip) : null,
      h('span', { class: 'spacer' }), deletable && S.selection ? h('button', { class: 'btn small danger', onclick: () => import('./state.js').then((m) => { m.removeSelection(); emit('select'); }) }, 'Delete') : null);
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
      h('p', { class: 'hint' }, 'Select a component, a port, an edge, a guard or an eye on the canvas to edit it. Drag a palette item onto the canvas; drag from an output port (filled dot), or from the + handle for a new one, onto an input port or a component to wire them.'));
  }

  /** The starting token of one use-case entry: taint, confidentiality, authority, failures it already carries. */
  tokenEditor(en, opts = {}) {
    const d = S.doc;
    const fields = modeFields(d).map((m) => m.name);
    en.token = en.token || {};
    const t = en.token;
    const ins = sysPorts(d).ins;
    return h('div', { class: 'token' },
      opts.portSelect ? h('label', { class: 'tk' }, 'enters at', h('select', { onchange: (e) => { en.port = e.target.value; changed(); } }, ins.map((p) => h('option', { value: p, selected: p === en.port ? true : undefined }, `sys.${p}`)))) : null,
      h('label', { class: 'tk check' }, h('input', { type: 'checkbox', checked: !!t.taint, onchange: (e) => { t.taint = e.target.checked; changed(); } }), 'tainted (from outside)'),
      h('label', { class: 'tk' }, 'confidentiality', h('select', { onchange: (e) => { t.conf = e.target.value; changed(); } }, d.lattices.confidentiality.map((l) => h('option', { value: l, selected: (t.conf || d.lattices.confidentiality[0]) === l ? true : undefined }, l)))),
      h('label', { class: 'tk' }, 'authority', h('select', { onchange: (e) => { t.auth = e.target.value; changed(); } }, d.lattices.authority.map((l) => h('option', { value: l, selected: (t.auth || d.lattices.authority.at(-1)) === l ? true : undefined }, l)))),
      h('label', { class: 'tk' }, 'already carries', h('input', { placeholder: 'e.g. late=3', class: 'mono', value: Object.entries(t.modes || {}).map(([k, v]) => `${k}=${v}`).join(' '),
        onchange: (e) => {
          const bad = e.target.value.split(/[\s,]+/).filter((x) => x && !(x.includes('=') && fields.includes(x.split('=')[0])));
          if (bad.length) toast(`Not a failure mode of this model: ${bad.join(', ')}. Modes: ${fields.join(', ')}.`);
          t.modes = Object.fromEntries(e.target.value.split(/[\s,]+/).filter((x) => x.includes('=') && fields.includes(x.split('=')[0])).map((x) => [x.split('=')[0], Math.max(0, Math.min(10, Number(x.split('=')[1]) || 0))]));
          changed();
        } })),
      opts.onRemove ? h('button', { class: 'x', 'aria-label': 'remove entry', onclick: opts.onRemove }, '×') : null);
  }

  useCases() {
    const d = S.doc;
    const ins = sysPorts(d).ins;
    const box = h('div', { class: 'block' }, this.section('Use cases',
      h('button', { class: 'btn small', disabled: !ins.length || undefined, onclick: () => { d.use_cases.push({ id: `uc${d.use_cases.length + 1}`, label: '', entries: [{ port: ins[0], token: {} }] }); changed(); this.render(); } }, 'Add use case')),
    h('p', { class: 'hint' }, 'A use case is where messages enter and what they already carry: the all-clear token unless you say otherwise. Selecting a system input on the canvas edits the use cases that start there.'));
    for (const u of d.use_cases) {
      if (!u.entries) u.entries = [{ port: (u.entry || '').replace('sys.', ''), token: u.token || {} }];
      const card = h('div', { class: 'card' },
        h('div', { class: 'inline' }, h('input', { value: u.id, class: 'mono', style: 'width:110px', onchange: (e) => { u.id = e.target.value; changed(); } }),
          h('input', { value: u.label || '', placeholder: 'what happens', style: 'flex:1', onchange: (e) => { u.label = e.target.value; changed(); } }),
          h('button', { class: 'x', 'aria-label': 'remove use case', onclick: () => { d.use_cases = d.use_cases.filter((x) => x !== u); changed(); this.render(); } }, '×')));
      for (const en of u.entries) card.appendChild(this.tokenEditor(en, { portSelect: true, onRemove: () => { u.entries = u.entries.filter((x) => x !== en); changed(); this.render(); } }));
      card.appendChild(h('button', { class: 'btn small', onclick: () => { u.entries.push({ port: ins[0], token: {} }); changed(); this.render(); } }, 'Another input in the same use case'));
      box.appendChild(card);
    }
    if (!ins.length) box.appendChild(h('p', { class: 'hint' }, 'Add a system input (palette) and wire it: use cases start there.'));
    return box;
  }

  claims() {
    const d = S.doc;
    const cells = (S.check && S.check.cells || []).map((c) => c.cell);
    const box = h('div', { class: 'block' }, this.section('Claims',
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
    this.host.append(this.head(c.id, c.kind === 'llm' ? 'LLM component' : `${c.kind} component`, c.kind === 'llm' ? 'llm' : ''));
    this.host.append(h('div', { class: 'fields' },
      this.field('Id', c.id, (v) => { if (!renameComponent(c.id, v)) toast('Ids are identifiers and must be unique.'); else this.render(); }, { mono: true }),
      this.field('Kind', c.kind, (v) => { c.kind = v; changed(); this.render(); }, { options: KINDS.map((k) => [k, k]) }),
      this.field('Label', c.label, (v) => { c.label = v; changed(); }, { wide: true }),
      this.field('Version', c.version, (v) => { c.version = v || undefined; changed(); }, { mono: true }),
      this.field('Own authority', c.authority || auth.at(-1), (v) => { c.authority = v; changed(); }, { options: auth.map((l) => [l, l]) }),
      this.field('Clearance (most confidential it may receive)', c.clearance || conf.at(-1), (v) => { c.clearance = v; changed(); }, { options: conf.map((l) => [l, l]), wide: true }),
      this.field('Requires (authority before it acts)', c.requires || auth[0], (v) => { c.requires = v; changed(); }, { options: auth.map((l) => [l, l]), wide: true }),
      this.check('trusted (an untrusted component taints what it touches)', c.trusted !== undefined ? c.trusted : !['external', 'user'].includes(c.kind), (v) => { c.trusted = v; changed(); }),
      this.check('raises authority (acts on its own authority)', c.raises, (v) => { c.raises = v; changed(); })));
    this.host.append(this.ports(c), this.flow(c),
      h('div', { class: 'block' }, this.section('Mapping table', h('button', { class: 'btn small', onclick: () => emit('maptable:show') }, 'Show it')),
        h('p', { class: 'hint' }, `The rows of ${c.id} — what it does with each failure, and which failures it starts — are in the table under the canvas, together with the rows the engine generates${c.kind === 'llm' ? ' (the worst-case defaults of an LLM)' : ''}.`)));
  }

  ports(c) {
    const d = S.doc;
    const box = h('div', { class: 'block' }, this.section('Ports'));
    for (const side of ['in', 'out']) {
      const head = h('div', { class: 'inline' }, h('b', { class: 'small' }, side === 'in' ? `Inputs In(${c.id})` : `Outputs Out(${c.id})`), h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: () => { addPort(c.id, side); } }, side === 'in' ? '+ input port' : '+ output port'));
      box.appendChild(head);
      if (!c[side].length) box.appendChild(h('p', { class: 'hint' }, side === 'in' ? 'None yet. Wire something into the component, or add one here.' : 'None yet. Drag from the + handle, or add one here.'));
      for (const p of c[side]) {
        const es = portEdges(d, c.id, side, p);
        const peers = es.map((e) => (side === 'in' ? e.from : e.to)).join(', ');
        box.appendChild(h('div', { class: 'portrow' },
          h('span', { class: `pdot ${side}` }),
          h('input', { value: p, class: 'mono', onchange: (e) => { if (!renamePort(c.id, side, p, e.target.value)) toast('Port names are identifiers and must be unique on their side.'); this.render(); } }),
          h('button', { class: 'linkish small', title: 'select the port', onclick: () => { S.selection = { type: 'port', id: `${c.id}|${side}|${p}` }; emit('select'); emit('doc'); } }, es.length ? `${side === 'in' ? '←' : '→'} ${peers}` : 'unconnected'),
          h('button', { class: 'x', 'aria-label': `delete port ${p}`, title: es.length ? `delete the port and its ${es.length} edge(s)` : 'delete the port', onclick: () => removePort(c.id, side, p) }, '×')));
      }
    }
    return box;
  }

  flow(c) {
    if (!c.in.length || !c.out.length) return h('div');
    const flow = c.flow || Object.fromEntries(c.in.map((p) => [p, c.out.slice()]));
    const table = h('table', { class: 'flow-table' }, h('tr', {}, h('th', {}, 'in \\ out'), c.out.map((q) => h('th', {}, q))),
      c.in.map((p) => h('tr', {}, h('td', {}, p), c.out.map((q) => h('td', {}, h('input', { type: 'checkbox', 'aria-label': `${p} sends to ${q}`, checked: (flow[p] || []).includes(q),
        onchange: (e) => { c.flow = c.flow || JSON.parse(JSON.stringify(flow)); const l = new Set(c.flow[p] || []); if (e.target.checked) l.add(q); else l.delete(q); c.flow[p] = [...l]; changed(); } }))))));
    return h('div', { class: 'block' }, this.section('Normal flow'), h('p', { class: 'hint' }, 'For each input port, the output ports it sends a message to on the happy path.'), table);
  }

  // ---------------------------------------------------------------- a port
  renderPort(key) {
    const d = S.doc;
    const [cid, side, name] = key.split('|');
    const c = comp(d, cid);
    if (!c || !c[side].includes(name)) { S.selection = null; this.renderModel(); return; }
    const es = portEdges(d, cid, side, name);
    this.host.append(this.head(`${cid}.${name}`, side === 'in' ? 'input port' : 'output port', ''),
      h('div', { class: 'fields' },
        this.field('Name', name, (v) => { if (!renamePort(cid, side, name, v)) { toast('Port names are identifiers and must be unique on their side.'); return; } S.selection = { type: 'port', id: `${cid}|${side}|${v}` }; emit('select'); }, { mono: true }),
        h('div', { class: 'field' }, 'Component', h('button', { class: 'btn small', onclick: () => { S.selection = { type: 'component', id: cid }; emit('select'); emit('doc'); } }, cid))));
    const wires = h('div', { class: 'block' }, this.section(side === 'in' ? 'Edges into it' : 'Edges out of it'));
    if (!es.length) wires.appendChild(h('p', { class: 'hint' }, side === 'in' ? 'Unconnected: drag from an output port onto this dot.' : 'Unconnected: drag from this dot onto an input port or a component.'));
    for (const e of es) wires.appendChild(h('button', { class: 'btn small', style: 'justify-content:flex-start', onclick: () => { S.selection = { type: 'edge', id: e.id }; emit('select'); emit('doc'); } }, `${e.id}: ${e.from} → ${e.to}`));
    if (side === 'out' && es.length > 1) wires.appendChild(h('p', { class: 'hint' }, 'Every edge out of one port carries the same message.'));
    const flow = c.flow || Object.fromEntries(c.in.map((p) => [p, c.out.slice()]));
    const linked = side === 'in' ? (flow[name] || []) : c.in.filter((p) => (flow[p] || []).includes(name));
    const rows = (c.rows || []).filter((r) => (side === 'in' ? (r.when || {})[name] !== undefined || (r.when || {})['*'] !== undefined : (r.then || {})[name] !== undefined)).map((r) => r.id);
    this.host.append(wires,
      h('div', { class: 'block' }, this.section('Normal flow'), h('p', { class: 'hint' }, linked.length ? (side === 'in' ? `On the happy path it sends to ${linked.join(', ')}.` : `On the happy path it is fed by ${linked.join(', ')}.`) : (side === 'in' ? 'It sends nothing on the happy path: only rows can emit from what arrives here.' : 'No input feeds it on the happy path: only rows can emit here.'))),
      h('div', { class: 'block' }, this.section(side === 'in' ? 'Rows that read it' : 'Rows that emit on it'), h('p', { class: 'hint mono' }, rows.length ? rows.join(', ') : 'none')),
      h('button', { class: 'btn small danger', onclick: () => removePort(cid, side, name) }, es.length ? `Delete the port and its ${es.length} edge(s)` : 'Delete the port'));
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
      }, { mono: true })));
    if (dir === 'output') {
      this.host.append(h('p', { class: 'hint' }, 'What leaves the system here is not modelled further; put an observation point on the edge into it to judge failures there. Its receiver is outside the model, so the observation point names any clearance or authority it demands.'));
      return;
    }
    const wired = d.edges.some((e) => e.from === `sys.${name}`);
    const box = h('div', { class: 'block' }, this.section('Use cases that start here',
      h('button', { class: 'btn small', disabled: !wired || undefined, onclick: () => { let i = d.use_cases.length + 1; while (d.use_cases.some((u) => u.id === `uc${i}`)) i++; d.use_cases.push({ id: `uc${i}`, label: '', entries: [{ port: name, token: {} }] }); changed(); this.render(); } }, 'Add one')),
    h('p', { class: 'hint' }, 'Each use case sends one message in here. Its token is all-clear unless you say what it already carries: tainted for text from outside, a confidentiality, an authority, failures it brings along.'));
    if (!wired) box.appendChild(h('p', { class: 'hint' }, 'Wire this input to a component first: drag from its + handle.'));
    for (const u of useCasesAt(d, name)) {
      const card = h('div', { class: 'card' }, h('div', { class: 'inline' },
        h('input', { value: u.id, class: 'mono', style: 'width:100px', onchange: (e) => { u.id = e.target.value; changed(); emit('doc'); } }),
        h('input', { value: u.label || '', placeholder: 'what happens', style: 'flex:1', onchange: (e) => { u.label = e.target.value; changed(); } }),
        h('button', { class: 'x', 'aria-label': 'remove use case', onclick: () => { d.use_cases = d.use_cases.filter((x) => x !== u); changed(); this.render(); } }, '×')));
      for (const en of u.entries.filter((x) => x.port === name)) card.appendChild(this.tokenEditor(en));
      const others = u.entries.filter((x) => x.port !== name).map((x) => `sys.${x.port}`);
      if (others.length) card.appendChild(h('span', { class: 'small muted' }, `also enters at ${others.join(', ')}`));
      box.appendChild(card);
    }
    this.host.append(box);
  }

  // ---------------------------------------------------------------- an edge
  renderEdge(e) {
    const d = S.doc;
    const [fo, fp] = parseRef(e.from), [to, tp] = parseRef(e.to);
    const fc = fo !== 'sys' && comp(d, fo), tc = to !== 'sys' && comp(d, to);
    this.host.append(this.head(e.id, 'edge'),
      h('div', { class: 'fields' },
        this.field('Label', e.label, (v) => { e.label = v; changed(); }, { wide: true }),
        fc ? this.field(`From (an output port of ${fo})`, fp, (v) => moveEdgeEnd(e.id, 'from', v), { options: fc.out.map((q) => [q, `${fo}.${q}`]) }) : h('div', { class: 'field' }, 'From', h('span', { class: 'mono', style: 'color: var(--ink)' }, e.from)),
        tc ? this.field(`To (an input port of ${to})`, tp, (v) => moveEdgeEnd(e.id, 'to', v), { options: tc.in.map((q) => [q, `${to}.${q}`]) }) : h('div', { class: 'field' }, 'To', h('span', { class: 'mono', style: 'color: var(--ink)' }, e.to))));
    const guards = d.guards.filter((g) => g.edge === e.id);
    const o = d.observation_points.find((x) => x.edge === e.id);
    this.host.append(h('div', { class: 'block' }, this.section('Guards on this edge', h('button', { class: 'btn small', onclick: () => import('./state.js').then((m) => { m.addGuard(e.id); emit('select'); }) }, 'Add guard')),
      guards.length ? h('p', { class: 'hint' }, `In the order they cut it: ${[e.from, ...guards.map((g) => g.label || g.id), e.to].join(' → ')}.`) : null,
      guards.length ? guards.map((g) => h('button', { class: 'btn small', style: 'justify-content:flex-start', onclick: () => { S.selection = { type: 'guard', id: g.id }; emit('select'); emit('doc'); } }, `${g.label || 'unnamed guard'} (${g.id}): ${(g.targets || []).map(targetText).join(', ') || 'checks nothing yet'}`)) : h('p', { class: 'hint' }, 'None. A guard cuts the edge in two and catches its targets unless its leak row fires.')),
      h('div', { class: 'block' }, this.section('Observation point',
        o ? h('button', { class: 'btn small', onclick: () => { S.selection = { type: 'obs', id: o.id }; emit('select'); emit('doc'); } }, `Edit ${o.label || o.id}`)
          : h('button', { class: 'btn small', onclick: () => import('./state.js').then((m) => { m.addObs(e.id); emit('select'); }) }, 'Observe this edge')),
        h('p', { class: 'hint' }, 'An observation point judges what the receiver gets: after every guard on the edge.')));
  }

  // ---------------------------------------------------------------- a guard
  renderGuard(g) {
    const d = S.doc;
    const fields = modeFields(d).map((m) => m.name);
    const e = edge(d, g.edge);
    const onEdge = d.guards.filter((x) => x.edge === g.edge);
    const idx = onEdge.indexOf(g);
    this.host.append(this.head(g.label || 'unnamed guard', g.learned ? 'learned guardrail' : 'guardrail', 'guard'),
      h('div', { class: 'fields' },
        this.field('Name (what it is)', g.label, (v) => { g.label = v; changed(); emit('select'); }, { wide: true, placeholder: 'e.g. mandate check, schema validator, LLM judge' }),
        this.field('Id', g.id, (v) => { if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && !d.guards.some((x) => x.id === v) && !d.components.some((x) => x.id === v)) { g.id = v; changed({ type: 'guard', id: v }); this.render(); } else toast('Ids are identifiers, unique among components and guards.'); }, { mono: true }),
        this.field('Version (certificates name it)', g.version, (v) => { g.version = v || undefined; changed(); }, { mono: true }),
        this.field('Cuts the edge', g.edge, (v) => { g.edge = v; changed(); this.render(); }, { options: d.edges.map((x) => [x.id, `${x.id}: ${x.from} → ${x.to}`]), wide: true }),
        this.check('learned (a classifier or an LLM judge)', g.learned, (v) => { g.learned = v; if (v) (g.targets || []).forEach((t) => { t.decidable = false; }); changed(); this.render(); }),
        this.check('closed output (enumerations only: may wash taint)', g.closed_output, (v) => { g.closed_output = v; changed(); this.render(); }),
        g.learned ? this.field('A false positive emits omission', g.fp_omission ?? 10, (v) => { g.fp_omission = Number(v); changed(); }, { type: 'number' }) : null));
    if (onEdge.length > 1) {
      this.host.append(h('div', { class: 'inline small' }, h('span', { class: 'muted' }, `Position ${idx + 1} of ${onEdge.length} on ${g.edge}`),
        h('button', { class: 'btn small', disabled: idx === 0 || undefined, onclick: () => { swapGuards(d, g, onEdge[idx - 1]); changed(); this.render(); } }, 'Earlier'),
        h('button', { class: 'btn small', disabled: idx === onEdge.length - 1 || undefined, onclick: () => { swapGuards(d, g, onEdge[idx + 1]); changed(); this.render(); } }, 'Later')));
    }
    g.targets = g.targets || [];
    const box = h('div', { class: 'block' }, this.section('Checks for (its targets)',
      h('button', { class: 'btn small', onclick: () => { g.targets.push({ mode: fields[0], threshold: 1, decidable: !g.learned }); changed(); this.render(); } }, 'Add target')),
    h('p', { class: 'hint' }, 'A target is a failure the guard catches: a mode at or above a threshold, taint, confidentiality above a level, or authority below one. Each target has a leak row, “the target gets through”, whose activation is the guard\'s quality.'));
    if (!g.targets.length) box.appendChild(h('p', { class: 'problems' }, 'This guard checks for nothing yet, so it changes no verdict. Add the failure it catches.'));
    for (const t of g.targets) {
      const kind = 'mode' in t ? 'mode' : 'taint' in t ? 'taint' : 'conf' in t ? 'conf' : 'auth';
      const setKind = (k) => {
        for (const x of ['mode', 'threshold', 'taint', 'conf', 'auth']) delete t[x];
        if (k === 'mode') Object.assign(t, { mode: fields[0], threshold: 1 }); if (k === 'taint') t.taint = true;
        if (k === 'conf') t.conf = d.lattices.confidentiality[0]; if (k === 'auth') t.auth = d.lattices.authority.at(-1); changed(); this.render();
      };
      const decidable = !g.learned && t.decidable;
      const says = kind === 'taint' && !g.closed_output ? 'Taint may be washed only by a guard whose output is a closed set: tick “closed output”, or this target is ill-formed.'
        : decidable ? 'Decidable from the data on the edge: a certificate may say its leak row never fires (N | S | A).'
          : g.learned ? 'A learned guard: no certificate can say it never leaks (S | A); it can only mitigate.'
            : 'Not decidable from the edge: its leak row can be sometimes or always, never never (S | A).';
      box.appendChild(h('div', { class: 'card' }, h('div', { class: 'inline' },
        h('span', { class: 'small muted' }, 'catches'),
        h('select', { onchange: (e) => setKind(e.target.value) }, [['mode', 'a failure mode'], ['taint', 'taint'], ['conf', 'confidentiality above'], ['auth', 'authority below']].map(([v, tx]) => h('option', { value: v, selected: v === kind ? true : undefined }, tx))),
        kind === 'mode' ? h('select', { onchange: (e) => { t.mode = e.target.value; changed(); this.render(); } }, fields.map((f) => h('option', { value: f, selected: f === t.mode ? true : undefined }, f))) : null,
        kind === 'mode' ? h('span', { class: 'small muted' }, '≥') : null,
        kind === 'mode' ? h('input', { type: 'number', min: 1, max: 10, value: t.threshold || 1, 'aria-label': 'threshold', onchange: (e) => { t.threshold = Number(e.target.value); changed(); this.render(); } }) : null,
        kind === 'conf' ? h('select', { onchange: (e) => { t.conf = e.target.value; changed(); } }, d.lattices.confidentiality.map((l) => h('option', { value: l, selected: l === t.conf ? true : undefined }, l))) : null,
        kind === 'auth' ? h('select', { onchange: (e) => { t.auth = e.target.value; changed(); } }, d.lattices.authority.map((l) => h('option', { value: l, selected: l === t.auth ? true : undefined }, l))) : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'x', 'aria-label': 'remove target', onclick: () => { g.targets = g.targets.filter((x) => x !== t); changed(); this.render(); } }, '×')),
      g.learned ? null : this.check('decidable from the data on the edge', t.decidable, (v) => { t.decidable = v; changed(); this.render(); }),
      h('span', { class: 'small muted' }, says),
      h('span', { class: 'small' }, catchText(d, g, t))));
    }
    this.host.append(box,
      h('div', { class: 'block' }, this.section('Where it sits'),
        h('p', { class: 'hint' }, e ? `It cuts ${e.id} in two: ${e.from} → ${g.id}.in, and ${g.id}.out → ${e.to}. Everything it does not catch passes unchanged, and it neither taints nor lowers authority. Its full table is under the canvas.` : 'Its edge no longer exists.')));
  }

  // ---------------------------------------------------------------- an observation point
  renderObs(o) {
    const d = S.doc;
    const fields = modeFields(d);
    o.tolerate = o.tolerate || {};
    const e = edge(d, o.edge);
    const [ro] = e ? parseRef(e.to) : ['sys'];
    const recv = ro !== 'sys' ? comp(d, ro) : null;
    const guards = d.guards.filter((g) => g.edge === o.edge).map((g) => g.label || g.id);
    this.host.append(this.head(o.label || o.id, 'observation point'),
      h('div', { class: 'fields' },
        this.field('Name', o.label, (v) => { o.label = v; changed(); emit('select'); }),
        this.field('Id', o.id, (v) => { if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) { o.id = v; changed({ type: 'obs', id: v }); this.render(); } }, { mono: true }),
        this.field('Where the log comes from', o.log, (v) => { o.log = v; changed(); }, { wide: true, placeholder: 'e.g. the bank statement (CSV export)' })),
      h('p', { class: 'hint' }, e ? `It observes edge ${e.id}: what ${e.to} receives${guards.length ? `, after ${guards.join(', ')}` : ''}. A failure reaches it when the message is sent and its token is beyond the toleration below.` : ''));
    const box = h('div', { class: 'block' }, this.section('Toleration: the failures it judges'),
      h('p', { class: 'hint' }, 'For each judged mode, the magnitude from which the failure counts as reaching this point; it accepts anything below. 1 accepts none. Each judged mode is a cell of the verdict table; an unticked mode is not judged here.'));
    const grid = h('div', { class: 'tolgrid' });
    for (const f of fields) {
      const judged = f.name in o.tolerate;
      const th = o.tolerate[f.name];
      grid.append(
        h('label', { class: `inline${f.parent ? ' sub' : ''}` }, h('input', { type: 'checkbox', checked: judged, onchange: (ev) => { if (ev.target.checked) o.tolerate[f.name] = 1; else delete o.tolerate[f.name]; changed(); this.render(); } }), h('span', { class: 'mono small' }, f.name)),
        judged ? h('span', { class: 'inline small' }, 'reached at ≥', h('input', { type: 'number', min: 1, max: 10, value: th, 'aria-label': `${f.name} threshold`, onchange: (ev) => { o.tolerate[f.name] = Math.max(1, Math.min(10, Number(ev.target.value) || 1)); changed(); this.render(); } })) : h('span', { class: 'small muted' }, 'not judged'),
        h('span', { class: 'small muted' }, judged ? (th <= 1 ? 'accepts none' : `accepts up to ${th - 1}`) : ''));
    }
    box.appendChild(grid);
    const lvlOpts = (levels, recvLevel, what) => [['', 'not judged'], ...(recv ? [['receiver', `the receiver's ${what} (${recvLevel})`]] : []), ...levels.map((l) => [l, l])];
    const conf = d.lattices.confidentiality, auth = d.lattices.authority;
    this.host.append(box,
      h('div', { class: 'block' }, this.section('Provenance'),
        this.check('flags any tainted message', o.taint === 'reject', (v) => { o.taint = v ? 'reject' : 'accept'; changed(); emit('doc'); }),
        h('div', { class: 'fields' },
          this.field('Confidentiality above', o.clearance || '', (v) => { if (v) o.clearance = v; else delete o.clearance; changed(); emit('doc'); }, { options: lvlOpts(conf, recv && (recv.clearance || conf.at(-1)), 'clearance'), wide: true }),
          this.field('Authority below', o.requires || '', (v) => { if (v) o.requires = v; else delete o.requires; changed(); emit('doc'); }, { options: lvlOpts(auth, recv && (recv.requires || auth[0]), 'required authority'), wide: true })),
        h('p', { class: 'hint' }, recv ? `Against its receiver ${recv.id}: a message more confidential than the clearance, or with less authority than required, reaches this point.` : 'The receiver is outside the model, so name the levels it demands.')));
  }

  // ---------------------------------------------------------------- problems and cells
  renderGenerated() {
    if (!this.genHost) return;
    clear(this.genHost);
    const ch = S.check;
    if (!ch) return;
    if (!ch.ok) { this.genHost.appendChild(h('div', { class: 'problems' }, 'The model needs attention:', h('ul', {}, (ch.problems || []).map((p) => h('li', {}, p))))); return; }
    const sel = S.selection;
    if (sel && sel.type === 'obs') {
      const cells = (ch.cells || []).filter((c) => c.cell.endsWith(`@${sel.id}`));
      this.genHost.append(h('span', { class: 'section-title' }, 'Its cells and their cones'));
      if (!cells.length) this.genHost.append(h('p', { class: 'hint' }, 'No cell: it judges nothing yet.'));
      for (const c of cells) this.genHost.append(h('div', { class: 'card gen' }, h('div', { class: 'inline' }, h('b', { class: 'mono small' }, c.cell), h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, `${c.candidates} candidates · ${c.runs} runs`)),
        h('span', { class: 'mono small' }, c.rows.join(', ') || 'no open row can change it')));
    }
  }
}

function swapGuards(d, a, b) {
  const i = d.guards.indexOf(a), j = d.guards.indexOf(b);
  d.guards[i] = b; d.guards[j] = a;
}

/** What catching a target does, in the words of Definition (Guardrail). */
export function catchText(d, g, t) {
  const kind = 'mode' in t ? 'mode' : 'taint' in t ? 'taint' : 'conf' in t ? 'conf' : 'auth';
  if (kind === 'mode') {
    const th = t.threshold || 1;
    return `When it catches ${t.mode} ≥ ${th}, the message goes on with ${t.mode} capped at ${th - 1}; a message that exists only because a failure row created it is dropped, unless the guard lies on a cycle.`;
  }
  if (kind === 'taint') return 'When it catches taint, the message goes on clean (its output is a closed set).';
  if (kind === 'conf') return `When it catches confidentiality above ${t.conf}, the message goes on at ${t.conf} (redacted).`;
  return `When it catches authority below ${t.auth}, the message goes on with ${t.auth} (approved).`;
}
