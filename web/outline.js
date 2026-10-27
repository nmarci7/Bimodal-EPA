// The outline: everything in the model as lists, beside the canvas. Click an item to select it
// (the canvas brings it into view), double-click to edit it. "All rows" lists every row of every
// component, each in one sentence.
import { h, clear, add } from './lib.js';
import { S, on, emit, sysPorts, targetText } from './state.js';
import { openDialog, button } from './dialog.js';
import { rowSentence, rowKind, KINDS } from './rows.js';
import { openRowDialog } from './rowdialog.js';
import { openComponentDialog, openGuardDialog, openObsDialog, openUseCaseDialog } from './modeldialogs.js';
import { judgesText } from './inspector.js';

const KIND_DOT = { llm: 'llm', deterministic: '', tool: '', store: 'store', external: 'ext', user: 'ext' };

export class Outline {
  constructor(host) {
    this.host = host;
    this.filter = '';
    this.input = h('input', { type: 'search', class: 'ol-search', placeholder: 'Filter by name…', 'aria-label': 'filter the outline', oninput: (e) => { this.filter = e.target.value.trim().toLowerCase(); this.renderList(); } });
    this.list = h('div', { class: 'ol-list' });
    host.append(h('div', { class: 'ol-top' }, this.input, button('All rows…', () => allRowsDialog(), { small: true, title: 'every row of every component' })), this.list);
    for (const ev of ['doc', 'loaded', 'select', 'check']) on(ev, () => this.renderList());
  }

  match(...xs) { return !this.filter || xs.some((x) => String(x || '').toLowerCase().includes(this.filter)); }

  item(sel, title, sub, opts = {}) {
    const cur = S.selection && S.selection.type === sel.type && S.selection.id === sel.id;
    return h('div', { class: `ol-item${cur ? ' on' : ''}`, role: 'button', tabindex: 0, title: 'click to select, double-click to edit',
      onclick: () => { S.selection = sel; emit('select'); emit('doc'); emit('reveal', sel); },
      ondblclick: () => opts.edit && opts.edit(),
      onkeydown: (e) => { if (e.key === 'Enter') { S.selection = sel; emit('select'); emit('doc'); emit('reveal', sel); } } },
    opts.dot !== undefined ? h('i', { class: `odot ${opts.dot}` }) : null,
    h('span', { class: 'ol-t' }, title), opts.badge ? h('span', { class: `ol-b${opts.warn ? ' warn' : ''}` }, opts.badge) : null,
    sub ? h('span', { class: 'ol-s' }, sub) : null);
  }

  group(title, items, empty) {
    const g = h('div', { class: 'ol-group' }, h('h3', {}, `${title} (${items.length})`));
    if (!items.length) g.appendChild(h('p', { class: 'hint' }, this.filter ? 'no match' : empty));
    add(g, items);
    return g;
  }

  renderList() {
    clear(this.list);
    const d = S.doc;
    if (!d) return;
    const ch = S.check;
    if (ch && !ch.ok) this.list.appendChild(h('div', { class: 'problems small' }, `${(ch.problems || []).length} problem(s) in the model: see the inspector.`));
    const comps = d.components.filter((c) => this.match(c.id, c.label, c.kind)).map((c) => this.item({ type: 'component', id: c.id }, c.id, c.label || c.kind,
      { dot: KIND_DOT[c.kind] || '', badge: `${(c.rows || []).length} row${(c.rows || []).length === 1 ? '' : 's'}`, edit: () => openComponentDialog(c.id) }));
    const guards = d.guards.filter((g) => this.match(g.id, g.label, g.edge)).map((g) => this.item({ type: 'guard', id: g.id }, g.label || 'unnamed guard',
      `${g.id} · ${(g.targets || []).map(targetText).join(', ') || 'checks nothing yet'}`, { dot: 'guard', warn: !(g.targets || []).length, badge: (g.targets || []).length ? null : 'empty', edit: () => openGuardDialog(g.id) }));
    const obs = d.observation_points.filter((o) => this.match(o.id, o.label, o.log)).map((o) => this.item({ type: 'obs', id: o.id }, o.label || o.id, `${o.id} · ${judgesText(o)}`, { dot: 'obs', edit: () => openObsDialog(o.id) }));
    const sp = sysPorts(d);
    const ports = [...sp.ins.map((n) => ['in', n]), ...sp.outs.map((n) => ['out', n])].filter(([, n]) => this.match(n))
      .map(([dir, n]) => this.item({ type: 'sys', id: `sys:${n}` }, `sys.${n}`, dir === 'in' ? 'system input' : 'system output', { dot: dir === 'in' ? 'sysin' : 'sysout' }));
    const ucs = d.use_cases.filter((u) => this.match(u.id, u.label)).map((u) => {
      const at = (u.entries || []).map((en) => en.port);
      return this.item({ type: 'sys', id: `sys:${at[0]}` }, u.id, `${u.label || ''}${u.label ? ' · ' : ''}enters at ${at.map((p) => `sys.${p}`).join(', ')}`, { dot: 'uc', edit: () => openUseCaseDialog(u.id) });
    });
    this.list.append(
      this.group('Components', comps, 'None yet: drag one from Add.'),
      this.group('Guards', guards, 'None yet: drop one onto an edge.'),
      this.group('Observation points', obs, 'None yet: drop one onto an edge.'),
      this.group('System ports', ports, 'None yet.'),
      this.group('Use cases', ucs, 'None yet.'));
  }
}

/** Every analyst row of the model, by component, in one window. */
export function allRowsDialog() {
  const d = S.doc;
  const body = h('div', { class: 'block' });
  const filter = h('input', { type: 'search', class: 'ol-search', placeholder: 'Filter rows by id, component, port or failure…', 'aria-label': 'filter rows' });
  const host = h('div', { class: 'block' });
  const draw = () => {
    clear(host);
    const q = filter.value.trim().toLowerCase();
    let n = 0;
    for (const c of d.components) {
      const rows = (c.rows || []).filter((r) => !q || [c.id, r.id, r.label, rowSentence(r, c)].some((x) => String(x || '').toLowerCase().includes(q)));
      if (!rows.length) continue;
      n += rows.length;
      host.appendChild(h('div', { class: 'rows-comp' },
        h('div', { class: 'block-head' }, h('b', { class: 'mono' }, c.id), h('span', { class: `kind-chip ${c.kind === 'llm' ? 'llm' : ''}` }, c.kind), h('span', { class: 'spacer' }),
          button('Add row…', () => { dlg.close(); openRowDialog(c.id, null); }, { small: true })),
        rows.map((r) => h('div', { class: 'item', role: 'button', tabindex: 0, onclick: () => { dlg.close(); openRowDialog(c.id, r.id); } },
          h('div', { class: 'inline' }, h('b', { class: 'mono small' }, r.id), h('span', { class: 'tag plain' }, KINDS[rowKind(r)].title.toLowerCase()),
            r.activation ? h('span', { class: 'tag plain' }, r.activation) : null, h('span', { class: 'small muted' }, r.label || '')),
          h('span', { class: 'small' }, rowSentence(r, c))))));
    }
    if (!n) host.appendChild(h('p', { class: 'hint' }, q ? 'No row matches.' : 'No component has rows of its own yet. Select a component and use Add row….'));
  };
  filter.addEventListener('input', draw);
  body.append(filter, host);
  const total = d.components.reduce((a, c) => a + (c.rows || []).length, 0);
  const dlg = openDialog({ title: 'All rows', subtitle: `${total} rows written by the analyst, in ${d.components.filter((c) => (c.rows || []).length).length} components. Click a row to edit it.`, size: 'lg', body });
  dlg.setActions([h('span', { class: 'spacer' }), button('Close', () => dlg.close(), { primary: true })]);
  draw();
}
