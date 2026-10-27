// The inspector: what the selected element is, in words, with the actions that change it. Editing
// happens in dialogs (modeldialogs.js, rowdialog.js), so the panel stays a summary to read. With
// nothing selected it shows the model itself: its settings, use cases and claims.
// Each panel follows the definitions of the framework: a component with its ports, normal flow and
// rows, a port, an edge, a guardrail with its targets, an observation point with its toleration, a
// system port with the use cases it starts.
import { h, clear, add } from './lib.js';
import { S, on, comp, edge, parseRef, modeFields, topModes, sysPorts, emit, portEdges, targetText, useCasesAt, removeSelection } from './state.js';
import { button, confirmDialog } from './dialog.js';
import { rowSentence } from './rows.js';
import { openRowDialog } from './rowdialog.js';
import {
  openComponentDialog, openGuardDialog, openObsDialog, openEdgeDialog, openSysDialog, openUseCaseDialog, deleteUseCase,
  openClaimDialog, deleteClaim, openModelDialog, openAbsorbDialog, catchSentence,
} from './modeldialogs.js';
import { llmDefaultStatus } from './rows.js';

export class Inspector {
  constructor(host) {
    this.host = host;
    on('select', () => this.render());
    on('loaded', () => this.render());
    on('doc', () => this.render());
    on('check', () => this.renderGenerated());
  }

  render() {
    clear(this.host);
    this.deletable = null;
    if (!S.doc) return;
    const sel = S.selection;
    const d = S.doc;
    if (!sel) this.renderModel();
    else if (sel.type === 'component' && comp(d, sel.id)) this.renderComponent(comp(d, sel.id));
    else if (sel.type === 'port') this.renderPort(sel.id);
    else if (sel.type === 'sys' && (d.layout.sys[sel.id.slice(4)] || sysPorts(d).ins.includes(sel.id.slice(4)) || sysPorts(d).outs.includes(sel.id.slice(4)))) this.renderSys(sel.id.slice(4));
    else if (sel.type === 'edge' && edge(d, sel.id)) this.renderEdge(edge(d, sel.id));
    else if (sel.type === 'guard' && d.guards.find((g) => g.id === sel.id)) this.renderGuard(d.guards.find((g) => g.id === sel.id));
    else if (sel.type === 'obs' && d.observation_points.find((o) => o.id === sel.id)) this.renderObs(d.observation_points.find((o) => o.id === sel.id));
    else { S.selection = null; this.renderModel(); }
    this.genHost = h('div', { class: 'block' });
    this.host.appendChild(this.genHost);
    this.renderGenerated();
    if (this.deletable && S.selection) {
      const what = this.deletable;
      this.host.appendChild(h('div', { class: 'insp-foot' }, h('button', { class: 'linkish small danger', onclick: () => this.remove(what) }, `Delete ${what}…`)));
    }
  }

  /** The panel's head: the name, what it is, Edit and Delete. */
  head(title, chip, chipClass, onEdit, deletable = true) {
    this.deletable = deletable && S.selection ? title : null;
    return h('div', { class: 'insp-head' }, h('div', { class: 'insp-title' }, h('span', { class: 'title' }, title), chip ? h('span', { class: `kind-chip ${chipClass || ''}` }, chip) : null),
      onEdit ? button('Edit…', onEdit, { small: true, primary: true }) : null);
  }

  async remove(what) {
    const t = S.selection && S.selection.type;
    const also = t === 'component' || t === 'sys' ? ' Its edges, and the guards and observation points on them, go too.' : t === 'edge' ? ' The guards and the observation point on it go too.' : '';
    const ok = await confirmDialog(`Delete ${what}?${also}`, { title: 'Delete', okText: 'Delete', danger: true });
    if (ok) { removeSelection(); emit('select'); }
  }

  section(title, ...rest) { return h('div', { class: 'block-head' }, h('span', { class: 'section-title' }, title), h('span', { class: 'spacer' }), ...rest); }
  kv(pairs) { return h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])); }
  select(sel) { S.selection = sel; emit('select'); emit('doc'); }

  // ---------------------------------------------------------------- the model
  renderModel() {
    const d = S.doc;
    const fields = modeFields(d);
    const modesText = topModes(d).map((m) => { const subs = fields.filter((f) => f.parent === m).map((f) => f.name); return subs.length ? `${m} (${subs.join(', ')})` : m; }).join(', ');
    add(this.host, 
      this.head(d.name || 'model', 'model', '', () => openModelDialog(), false),
      d.description ? h('p', { class: 'desc' }, d.description) : null,
      this.kv([['Failure modes', modesText], ['Confidentiality', d.lattices.confidentiality.join(' < ')], ['Authority', d.lattices.authority.join(' < ')]]),
      this.useCases(), this.claims(),
      h('p', { class: 'hint' }, 'Select something on the canvas to see it here; double-click it to edit it. The outline on the left lists everything in the model.'));
  }

  useCases() {
    const d = S.doc;
    const ins = sysPorts(d).ins;
    const box = h('div', { class: 'block' }, this.section(`Use cases (${d.use_cases.length})`, button('Add…', () => openUseCaseDialog(null), { small: true, disabled: !ins.length, title: ins.length ? '' : 'add and wire a system input first' })));
    if (!d.use_cases.length) box.appendChild(h('p', { class: 'hint' }, ins.length ? 'None yet. A use case says where messages enter and what they already carry.' : 'Add a system input (palette) and wire it: use cases start there.'));
    for (const u of d.use_cases) box.appendChild(this.ucItem(u));
    return box;
  }

  ucItem(u) {
    const entries = (u.entries || [{ port: (u.entry || '').replace('sys.', ''), token: u.token || {} }]).map((en) => {
      const t = en.token || {};
      const bits = [t.taint ? 'tainted' : null, t.conf ? `conf ${t.conf}` : null, t.auth ? `auth ${t.auth}` : null, ...Object.entries(t.modes || {}).map(([m, k]) => `${m} ${k}`)].filter(Boolean);
      return `sys.${en.port}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    });
    return h('div', { class: 'item', role: 'button', tabindex: 0, onclick: () => openUseCaseDialog(u.id), onkeydown: (e) => { if (e.key === 'Enter') openUseCaseDialog(u.id); } },
      h('div', { class: 'inline' }, h('b', { class: 'mono' }, u.id), h('span', { class: 'grow small' }, u.label || ''),
        h('button', { class: 'x', 'aria-label': `delete use case ${u.id}`, onclick: (e) => { e.stopPropagation(); deleteUseCase(u.id); } }, '×')),
      h('span', { class: 'small muted' }, `enters at ${entries.join(' and ')}`));
  }

  claims() {
    const d = S.doc;
    const box = h('div', { class: 'block' }, this.section(`Claims (${d.claims.length})`, button('Add…', () => openClaimDialog(null), { small: true })));
    if (!d.claims.length) box.appendChild(h('p', { class: 'hint' }, 'None. A claim is what someone says a verdict is; the analysis checks it against the evidence.'));
    d.claims.forEach((cl, i) => box.appendChild(h('div', { class: 'item', role: 'button', tabindex: 0, onclick: () => openClaimDialog(i), onkeydown: (e) => { if (e.key === 'Enter') openClaimDialog(i); } },
      h('div', { class: 'inline' }, h('b', { class: 'mono small' }, cl.cell), h('span', { class: `v ${cl.verdict}` }, cl.verdict), h('span', { class: 'grow small muted' }, cl.by ? `by ${cl.by}` : ''),
        h('button', { class: 'x', 'aria-label': 'delete claim', onclick: (e) => { e.stopPropagation(); deleteClaim(i); } }, '×')))));
    return box;
  }

  // ---------------------------------------------------------------- a component
  renderComponent(c) {
    const d = S.doc;
    const llm = c.kind === 'llm';
    const conf = d.lattices.confidentiality, auth = d.lattices.authority;
    const trusted = c.trusted !== undefined ? c.trusted : !['external', 'user'].includes(c.kind);
    add(this.host, 
      this.head(c.id, llm ? 'LLM component' : `${c.kind} component`, llm ? 'llm' : '', () => openComponentDialog(c.id)),
      c.label ? h('p', { class: 'desc' }, c.label) : null,
      this.kv([c.version ? ['Version', h('span', { class: 'mono' }, c.version)] : null,
        ['Authority', `${c.authority || auth.at(-1)}${c.raises ? ', acts on its own authority' : ''}`],
        ['Clearance', c.clearance || conf.at(-1)], ['Requires', c.requires || auth[0]],
        ['Trusted', trusted ? 'yes' : 'no: it taints what it touches']]));

    // rows
    const rows = c.rows || [];
    const tops = topModes(d);
    const gen = llm ? c.out.length * tops.length : (c.in.length && c.out.length ? c.in.length : 0) + (c.absorbs || []).length;
    const rbox = h('div', { class: 'block' }, this.section(`Rows (${rows.length} yours, ${gen} the engine adds)`,
      button('Add row…', () => openRowDialog(c.id, null), { small: true, disabled: !(c.in.length || c.out.length) }),
      button('Table', () => emit('maptable:show'), { small: true, title: 'show the mapping table under the canvas' })));
    if (!rows.length) rbox.appendChild(h('p', { class: 'hint' }, llm ? 'No rows of your own: the LLM\'s worst-case defaults stand until you refine them.' : 'No rows of your own: failures pass through, nothing is started here.'));
    else rbox.appendChild(h('div', { class: 'chips' }, rows.map((r) => h('button', { class: 'rowchip', title: rowSentence(r, c), onclick: () => openRowDialog(c.id, r.id) }, r.id))));
    if (rows.length) rbox.appendChild(h('p', { class: 'hint' }, 'Click a row to edit it. The table under the canvas says what each one does.'));
    add(this.host, rbox);

    // ports and flow
    const flow = c.flow || Object.fromEntries(c.in.map((p) => [p, c.out.slice()]));
    const pbox = h('div', { class: 'block' }, this.section('Ports and normal flow', button('Edit…', () => openComponentDialog(c.id, { startAt: 'ports' }), { small: true })));
    for (const side of ['in', 'out']) {
      for (const p of c[side]) {
        const es = portEdges(d, c.id, side, p);
        pbox.appendChild(h('div', { class: 'portrow' }, h('span', { class: `pdot ${side}` }),
          h('button', { class: 'linkish mono small', title: 'select the port', onclick: () => this.select({ type: 'port', id: `${c.id}|${side}|${p}` }) }, p),
          h('span', { class: 'small muted grow ell' }, side === 'in' ? `← ${es.map((e) => e.from).join(', ') || 'unconnected'}${c.in.length && c.out.length ? ` · goes on to ${(flow[p] || []).join(', ') || 'nothing'}` : ''}`
            : `→ ${es.map((e) => e.to).join(', ') || 'unconnected'}`)));
      }
    }
    if (!c.in.length && !c.out.length) pbox.appendChild(h('p', { class: 'hint' }, 'No ports yet: drag from the + handle to wire the component.'));
    add(this.host, pbox);

    // what it absorbs, or the LLM defaults
    if (!llm) {
      const ab = c.absorbs || [];
      const abox = h('div', { class: 'block' }, this.section('What it absorbs', button('Edit…', () => openComponentDialog(c.id, { startAt: 'absorbs' }), { small: true })));
      if (!ab.length) abox.appendChild(h('p', { class: 'hint' }, 'Nothing: every failure passes through (assumption A6).'));
      for (const a of ab) {
        abox.appendChild(h('div', { class: 'item', role: 'button', tabindex: 0, onclick: () => openAbsorbDialog(c.id, a.port) },
          h('span', { class: 'small' }, h('b', { class: 'mono' }, a.port), `: ${[].concat(a.modes === 'all' ? ['every mode'] : a.modes || a.mode || []).join(', ')}`),
          h('span', { class: `small ${a.reason ? 'muted' : 'warn'}` }, a.reason || 'no reason given yet')));
      }
      add(this.host, abox);
    } else {
      const st = c.out.flatMap((q) => tops.map((m) => llmDefaultStatus(c, q, m)));
      const n = (s) => st.filter((x) => x.status === s).length;
      add(this.host, h('div', { class: 'block' }, this.section('Worst-case defaults', button('Review…', () => openComponentDialog(c.id, { startAt: 'defaults' }), { small: true })),
        h('p', { class: 'hint' }, `${n('active')} standing, ${n('refined')} refined by your rows, ${n('dropped')} dropped with a reason. Each output starts with one per failure mode: any message in, that failure at 10 out.`)));
    }
  }

  // ---------------------------------------------------------------- a port
  renderPort(key) {
    const d = S.doc;
    const [cid, side, name] = key.split('|');
    const c = comp(d, cid);
    if (!c || !c[side].includes(name)) { S.selection = null; this.renderModel(); return; }
    const es = portEdges(d, cid, side, name);
    const flow = c.flow || Object.fromEntries(c.in.map((p) => [p, c.out.slice()]));
    const linked = side === 'in' ? (flow[name] || []) : c.in.filter((p) => (flow[p] || []).includes(name));
    const rows = (c.rows || []).filter((r) => (side === 'in' ? (r.when || {})[name] !== undefined || (r.when || {})['*'] !== undefined : (r.then || {})[name] !== undefined));
    add(this.host, 
      this.head(`${cid}.${name}`, side === 'in' ? 'input port' : 'output port', '', () => openComponentDialog(cid, { startAt: 'ports' }), false),
      this.kv([['Component', h('button', { class: 'linkish', onclick: () => this.select({ type: 'component', id: cid }) }, cid)],
        [side === 'in' ? 'Edges into it' : 'Edges out of it', es.length ? h('div', {}, es.map((e) => h('div', {}, h('button', { class: 'linkish small', onclick: () => this.select({ type: 'edge', id: e.id }) }, `${e.id}: ${e.from} → ${e.to}`)))) : 'none: unconnected'],
        ['Normal flow', linked.length ? (side === 'in' ? `goes on to ${linked.join(', ')}` : `fed by ${linked.join(', ')}`) : (side === 'in' ? 'goes nowhere on the happy path' : 'nothing feeds it on the happy path')]]),
      h('div', { class: 'block' }, this.section(side === 'in' ? `Rows that read it (${rows.length})` : `Rows that emit on it (${rows.length})`),
        rows.length ? rows.map((r) => h('div', { class: 'item', role: 'button', tabindex: 0, onclick: () => openRowDialog(cid, r.id) }, h('b', { class: 'mono small' }, r.id), h('span', { class: 'small' }, rowSentence(r, c)))) : h('p', { class: 'hint' }, 'none')),
      side === 'out' && es.length > 1 ? h('p', { class: 'hint' }, 'Every edge out of one port carries the same message.') : null);
  }

  // ---------------------------------------------------------------- a system port
  renderSys(name) {
    const d = S.doc;
    const dir = sysPorts(d).ins.includes(name) ? 'input' : 'output';
    add(this.host, this.head(`sys.${name}`, `system ${dir}`, '', () => openSysDialog(name)));
    if (dir === 'output') {
      add(this.host, h('p', { class: 'hint' }, 'What leaves the system here is not modelled further; put an observation point on the edge into it to judge failures there. Its receiver is outside the model, so the observation point names any clearance or authority it demands.'));
      return;
    }
    const wired = d.edges.some((e) => e.from === `sys.${name}`);
    const ucs = useCasesAt(d, name);
    const box = h('div', { class: 'block' }, this.section(`Use cases that start here (${ucs.length})`, button('Add…', () => openUseCaseDialog(null, { port: name }), { small: true, disabled: !wired, title: wired ? '' : 'wire this input to a component first' })));
    if (!wired) box.appendChild(h('p', { class: 'hint' }, 'Wire this input to a component first: drag from its + handle.'));
    else if (!ucs.length) box.appendChild(h('p', { class: 'hint warn' }, 'No use case starts here, so nothing ever enters through it.'));
    for (const u of ucs) box.appendChild(this.ucItem(u));
    add(this.host, box);
  }

  // ---------------------------------------------------------------- an edge
  renderEdge(e) {
    const d = S.doc;
    const guards = d.guards.filter((g) => g.edge === e.id);
    const o = d.observation_points.find((x) => x.edge === e.id);
    add(this.host, 
      this.head(e.id, 'edge', '', () => openEdgeDialog(e.id)),
      this.kv([['From', h('span', { class: 'mono' }, e.from)], ['To', h('span', { class: 'mono' }, e.to)], e.label ? ['Label', e.label] : null]),
      h('div', { class: 'block' }, this.section(`Guards on it (${guards.length})`, button('Add guard…', () => openGuardDialog(null, { edge: e.id }), { small: true })),
        guards.length ? h('p', { class: 'hint' }, `In the order they cut it: ${[e.from, ...guards.map((g) => g.label || g.id), e.to].join(' → ')}.`) : h('p', { class: 'hint' }, 'None. A guard cuts the edge in two and catches its targets unless its leak row fires.'),
        guards.map((g) => h('div', { class: 'item', role: 'button', tabindex: 0, onclick: () => this.select({ type: 'guard', id: g.id }) },
          h('b', { class: 'small' }, `${g.label || 'unnamed guard'} `, h('span', { class: 'mono muted' }, g.id)), h('span', { class: 'small muted' }, (g.targets || []).map(targetText).join(', ') || 'checks nothing yet')))),
      h('div', { class: 'block' }, this.section('Observation point', o ? null : button('Observe this edge…', () => openObsDialog(null, { edge: e.id }), { small: true })),
        o ? h('div', { class: 'item', role: 'button', tabindex: 0, onclick: () => this.select({ type: 'obs', id: o.id }) }, h('b', { class: 'small' }, o.label || o.id), h('span', { class: 'small muted' }, judgesText(o)))
          : h('p', { class: 'hint' }, 'None. An observation point judges what the receiver gets, after every guard on the edge.')));
  }

  // ---------------------------------------------------------------- a guard
  renderGuard(g) {
    const d = S.doc;
    const e = edge(d, g.edge);
    const ts = g.targets || [];
    add(this.host, 
      this.head(g.label || 'unnamed guard', g.learned ? 'learned guardrail' : 'guardrail', 'guard', () => openGuardDialog(g.id)),
      this.kv([['Id', h('span', { class: 'mono' }, g.id)], g.version ? ['Version', h('span', { class: 'mono' }, g.version)] : null,
        ['Cuts', e ? h('button', { class: 'linkish small', onclick: () => this.select({ type: 'edge', id: e.id }) }, `${e.id}: ${e.from} → ${e.to}`) : 'an edge that no longer exists'],
        g.closed_output ? ['Output', 'a closed set: may wash taint'] : null]),
      h('div', { class: 'block' }, this.section(`What it catches (${ts.length})`, button('Edit…', () => openGuardDialog(g.id, { startAt: 'targets' }), { small: true })),
        ts.length ? ts.map((t) => h('div', { class: 'item static' }, h('b', { class: 'mono small' }, targetText(t)),
          h('span', { class: 'small muted' }, g.learned ? 'learned: its leak row is sometimes or always' : t.decidable ? 'decidable: a certificate may say it never leaks' : 'not decidable from the edge: sometimes or always'),
          h('span', { class: 'small' }, catchSentence(t))))
          : h('p', { class: 'problems' }, 'This guard checks for nothing yet, so it changes no verdict. Use Edit… to say what it catches.')));
  }

  // ---------------------------------------------------------------- an observation point
  renderObs(o) {
    const d = S.doc;
    const e = edge(d, o.edge);
    const [ro] = e ? parseRef(e.to) : ['sys'];
    const recv = ro !== 'sys' ? comp(d, ro) : null;
    const guards = d.guards.filter((g) => g.edge === o.edge).map((g) => g.label || g.id);
    const tol = Object.entries(o.tolerate || {});
    add(this.host, 
      this.head(o.label || o.id, 'observation point', '', () => openObsDialog(o.id)),
      this.kv([['Id', h('span', { class: 'mono' }, o.id)],
        ['Observes', e ? `what ${e.to} receives on ${e.id}${guards.length ? `, after ${guards.join(', ')}` : ''}` : 'an edge that no longer exists'],
        o.log ? ['Log', o.log] : null,
        ['Judges', tol.length ? h('div', { class: 'chips' }, tol.map(([m, th]) => h('span', { class: 'tag plain' }, `${m} ≥ ${th}`))) : 'no failure mode'],
        ['Provenance', [o.taint === 'reject' ? 'flags taint' : null, o.clearance ? `confidentiality above ${o.clearance === 'receiver' && recv ? `${recv.id}'s clearance` : o.clearance}` : null,
          o.requires ? `authority below ${o.requires === 'receiver' && recv ? `what ${recv.id} requires` : o.requires}` : null].filter(Boolean).join('; ') || 'not judged']]));
  }

  // ---------------------------------------------------------------- problems and cells
  renderGenerated() {
    if (!this.genHost) return;
    clear(this.genHost);
    const ch = S.check;
    if (!ch) return;
    if (!ch.ok) { this.genHost.appendChild(h('div', { class: 'problems' }, `The model needs attention (${(ch.problems || []).length}):`, h('ul', {}, (ch.problems || []).slice(0, 12).map((p) => h('li', {}, p))), (ch.problems || []).length > 12 ? h('span', {}, `… and ${ch.problems.length - 12} more`) : null)); return; }
    const sel = S.selection;
    if (sel && sel.type === 'obs') {
      const cells = (ch.cells || []).filter((c) => c.cell.endsWith(`@${sel.id}`));
      add(this.genHost, h('span', { class: 'section-title' }, `Its cells (${cells.length})`));
      if (!cells.length) add(this.genHost, h('p', { class: 'hint' }, 'No cell: it judges nothing yet.'));
      for (const c of cells) add(this.genHost, h('div', { class: 'card gen' }, h('div', { class: 'inline' }, h('b', { class: 'mono small' }, c.cell), h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, `${c.candidates} candidates · ${c.runs} runs`)),
        h('span', { class: 'mono small' }, c.rows.join(', ') || 'no open row can change it')));
    }
  }
}

export function judgesText(o) {
  const parts = Object.entries(o.tolerate || {}).map(([m, v]) => `${m} ≥ ${v}`);
  if (o.taint === 'reject') parts.push('taint');
  if (o.clearance) parts.push('confidentiality');
  if (o.requires) parts.push('authority');
  return parts.length ? `judges ${parts.join(', ')}` : 'judges nothing yet';
}
