// The mapping table of the selected component or guard, under the canvas.
//
// Definition (Component) gives every component a normal flow and a mapping table of rows: a when
// part (a pattern on one or more input ports, all of which must match) and a then part (failures
// emitted on output ports: const k, keep, +k, max). The table shows every row the analysis uses,
// each as one sentence:
//   * the analyst's rows: added and edited in the row dialog (rowdialog.js), never in place,
//   * the rows the engine adds, folded away until asked for:
//       pass-through - every failure a message brings goes on where the component forwards it
//         (assumption A6, pessimistic), except what the analyst declares absorbed, with a reason,
//       for an LLM component (for every component when the model says worst_case_defaults: all),
//         the worst-case defaults (Definition: LLM default table), which a row can refine and a
//         reason can drop,
//       the declared absorptions, each with its reason (a claim an auditor can dispute),
//   * for a guardrail, its fixed catching behaviour, one leak row per target and, if learned, its
//     false-positive row (Definition: Guardrail).
import { h, clear, toast } from './lib.js';
import { S, on, emit, comp, edge, topModes, targetText, cloneDoc, commitDoc, edgeName } from './state.js';
import { rowSentence, rowKind, KINDS, defaultStatus, hasDefaults } from './rows.js';
import { openRowDialog, deleteRow } from './rowdialog.js';
import { openAbsorbDialog, openDropDefaultDialog, refinePreset, openComponentDialog, openGuardDialog, catchSentence } from './modeldialogs.js';
import { button } from './dialog.js';

export class MapTable {
  constructor(host) {
    this.host = host;
    this.open = true;
    this.showGen = {};          // per component or guard: are the generated rows unfolded
    on('select', () => this.render());
    on('loaded', () => this.render());
    on('check', () => this.render());
    on('doc', () => this.render());
    on('maptable:show', () => { this.open = true; emit('maptable:toggled', true); this.render(); });
  }

  target() {
    const sel = S.selection;
    if (!sel || !S.doc) return null;
    if (sel.type === 'component') { const c = comp(S.doc, sel.id); return c ? { c } : null; }
    if (sel.type === 'port') { const [cid, side, name] = sel.id.split('|'); const c = comp(S.doc, cid); return c ? { c, port: { side, name } } : null; }
    if (sel.type === 'guard') { const g = S.doc.guards.find((x) => x.id === sel.id); return g ? { g } : null; }
    return null;
  }

  render() {
    clear(this.host);
    const t = this.target();
    this.host.hidden = !(this.open && t);
    if (this.host.hidden) return;
    if (t.g) this.renderGuard(t.g); else this.renderComponent(t.c, t.port);
  }

  head(title, chip, chipClass, meta, ...buttons) {
    this.host.append(h('div', { class: 'mt-head' }, h('b', {}, title), chip ? h('span', { class: `kind-chip ${chipClass || ''}` }, chip) : null,
      h('span', { class: 'mono small muted' }, meta), h('span', { class: 'spacer' }), ...buttons,
      h('button', { class: 'x', 'aria-label': 'close the mapping table', title: 'close', onclick: () => { this.open = false; emit('maptable:toggled', false); this.render(); } }, '×')));
  }

  table(cols, cls = '') {
    const body = h('tbody');
    const t = h('table', { class: `mt ${cls}` }, h('thead', {}, h('tr', {}, cols.map((x) => h('th', {}, x)))), body);
    return { t, body };
  }

  // ---------------------------------------------------------------- a component
  renderComponent(c, port) {
    const llm = c.kind === 'llm';
    const tops = topModes(S.doc);
    const canAdd = c.in.length || c.out.length;
    this.head(`Rows of ${c.id}`, llm ? 'LLM' : c.kind, llm ? 'llm' : '', `In = {${c.in.join(', ')}} · Out = {${c.out.join(', ')}}`,
      button('Edit component…', () => openComponentDialog(c.id), { small: true }),
      button('Add row…', () => openRowDialog(c.id, null), { small: true, primary: true, disabled: !canAdd, title: canAdd ? 'add a row step by step' : 'the component has no port yet: wire it first' }));
    const flow = c.flow || Object.fromEntries(c.in.map((p) => [p, c.out.slice()]));
    this.host.appendChild(h('div', { class: 'mt-flow' }, h('span', { class: 'section-title' }, 'Normal flow'),
      c.in.length ? c.in.map((p) => h('span', { class: 'mono small' }, `${p} → ${(flow[p] || []).join(', ') || 'nothing'}`)) : h('span', { class: 'small muted' }, 'no input port yet'),
      h('button', { class: 'linkish small', onclick: () => openComponentDialog(c.id, { startAt: 'flow' }) }, 'edit'),
      h('span', { class: 'small muted grow' }, llm ? 'An LLM passes nothing through: what it sends carries only the failures its rows emit.'
        : 'A message goes on with every failure it brought, unless the component absorbs it.')));
    const touches = (r) => port && (port.side === 'in' ? (r.when || {})[port.name] !== undefined || (r.when || {})['*'] !== undefined : (r.then || {})[port.name] !== undefined);

    // the analyst's rows
    const mine = this.table(['Row', 'What it does', 'Activation', '']);
    for (const r of c.rows || []) {
      const kind = rowKind(r);
      const tr = h('tr', { class: `analyst${touches(r) ? ' hl' : ''}`, ondblclick: () => openRowDialog(c.id, r.id), title: 'double-click to edit' },
        h('td', { class: 'rowid' }, h('div', { class: 'mono b' }, r.id), r.label ? h('div', { class: 'small muted' }, r.label) : null),
        h('td', {}, kind !== 'failure' ? [h('span', { class: 'tag plain' }, KINDS[kind].title.toLowerCase()), ' '] : null, h('span', { class: 'sent' }, rowSentence(r, c))),
        h('td', { class: 'small' }, actShort(r, c)),
        h('td', { class: 'acts' },
          h('button', { class: 'linkish small', onclick: () => openRowDialog(c.id, r.id) }, 'Edit'),
          h('button', { class: 'linkish small', onclick: () => openRowDialog(c.id, null, { from: r }) }, 'Copy'),
          h('button', { class: 'linkish small danger', onclick: () => deleteRow(c.id, r.id) }, 'Delete')));
      mine.body.appendChild(tr);
    }
    if (!(c.rows || []).length) {
      mine.body.appendChild(h('tr', { class: 'note' }, h('td', { colspan: 4 }, llm
        ? 'No rows of your own: the worst-case defaults (below) stand for this LLM until you refine them. Add a row to say more precisely what it does.'
        : 'No rows of your own yet. A row says which failure arriving where makes the component send which failure where, which failure it starts on its own, or where it forwards a message.',
      ' ', canAdd ? h('button', { class: 'linkish small', onclick: () => openRowDialog(c.id, null) }, 'Add the first row…') : null)));
    }
    this.host.appendChild(h('div', { class: 'mt-scroll' }, mine.t, this.generated(c, port, tops)));
  }

  generated(c, port, tops) {
    const llm = c.kind === 'llm';
    const gen = this.table(['Row', 'What it does', 'Activation', ''], 'gen-table');
    let n = 0;
    if (!llm && c.in.length && c.out.length) {
      const flow = c.flow || Object.fromEntries(c.in.map((p) => [p, c.out.slice()]));
      for (const p of c.in) {
        const absorbed = new Set((c.absorbs || []).filter((a) => a.port === p).flatMap((a) => (a.modes === 'all' ? tops : [].concat(a.modes || a.mode || []))));
        const passing = tops.filter((m) => !absorbed.has(m));
        const to = (flow[p] || []);
        n++;
        gen.body.appendChild(h('tr', { class: `gen${port && port.side === 'in' && port.name === p ? ' hl' : ''}` },
          h('td', { class: 'mono small' }, `pass.${c.id}.${p}`),
          h('td', { class: 'small' }, to.length ? `Every failure arriving on ${p} goes on to ${to.join(', ')} unchanged` : `Nothing arriving on ${p} goes on (no normal flow from it)`,
            to.length && absorbed.size ? `, except ${[...absorbed].join(', ')}, which stop here.` : to.length ? '.' : '', ' ', h('span', { class: 'muted' }, `Passes: ${passing.join(', ') || 'nothing'}.`)),
          h('td', { class: 'small' }, 'always', h('div', { class: 'muted' }, 'A6: pass-through')),
          h('td', { class: 'acts' }, h('button', { class: 'linkish small', onclick: () => openAbsorbDialog(c.id, p) }, absorbed.size ? 'Absorbed…' : 'Absorb…'))));
      }
    }
    if (hasDefaults(S.doc, c)) {
      for (const q of c.out) {
        for (const m of tops) {
          const st = defaultStatus(c, q, m);
          n++;
          const hl = port && ((port.side === 'out' && port.name === q) || port.side === 'in') ? ' hl' : '';
          gen.body.appendChild(h('tr', { class: `gen ${st.status}${hl}` },
            h('td', { class: 'mono small' }, `default.${c.id}.${q}.${m}`),
            h('td', { class: 'small' }, h('span', { class: 'tag llm' }, 'worst case'), ' ', `On any message, ${c.id} sends ${m} at 10 on ${q}.`,
              st.status === 'active' && st.beside.length ? h('div', { class: 'muted' }, `${st.beside.join(', ')} emit on ${q} beside it.`) : null,
              st.status === 'dropped' ? h('div', { class: 'muted' }, `Dropped: ${st.drop.reason || 'no reason given yet'}`) : null),
            h('td', { class: 'small' }, st.status === 'refined' ? h('span', { class: 'muted' }, `replaced by ${st.refinedBy.join(', ')}`) : st.status === 'dropped' ? h('span', { class: 'muted' }, 'dropped') : llm ? 'open: S | A' : 'open: N | S | A'),
            h('td', { class: 'acts' },
              st.status === 'active' ? [h('button', { class: 'linkish small', onclick: () => openRowDialog(c.id, null, { preset: refinePreset(c.id, q, m), startAt: 'effect' }) }, 'Refine…'),
                h('button', { class: 'linkish small', onclick: () => openDropDefaultDialog(c.id, q, m) }, 'Drop…')] : null,
              st.status === 'dropped' ? h('button', { class: 'linkish small', onclick: () => restoreDefault(c.id, q, m) }, 'Restore') : null,
              st.status === 'refined' ? h('button', { class: 'linkish small', onclick: () => openRowDialog(c.id, st.refinedBy[0]) }, 'Edit row') : null)));
        }
      }
    }
    for (const a of c.absorbs || []) {
      const ms = a.modes === 'all' ? ['every mode'] : [].concat(a.modes || a.mode || []);
      n++;
      gen.body.appendChild(h('tr', { class: 'gen absorbed' },
        h('td', { class: 'mono small' }, `absorbs.${c.id}.${a.port}`),
        h('td', { class: 'small' }, `${ms.join(', ')} arriving on ${a.port} ${ms.length > 1 ? 'stop' : 'stops'} here. `, h('span', { class: a.reason ? 'muted' : 'warn' }, a.reason ? `Reason: ${a.reason}` : 'No reason given yet (required).')),
        h('td', { class: 'small' }, 'always', h('div', { class: 'muted' }, 'declared')),
        h('td', { class: 'acts' }, h('button', { class: 'linkish small', onclick: () => openAbsorbDialog(c.id, a.port) }, 'Edit…'))));
    }
    if (!n) return null;
    const key = c.id;
    const open = this.showGen[key] !== undefined ? this.showGen[key] : false;
    const det = h('details', { class: 'gen-fold', open: open || undefined },
      h('summary', {}, h('span', { class: 'section-title' }, `Rows the engine adds (${n})`), ' ',
        h('span', { class: 'small muted' }, llm ? 'the worst-case defaults of an LLM: refine or drop them here'
          : hasDefaults(S.doc, c) ? 'pass-through for every input, what you declared absorbed, and the worst-case defaults: refine or drop them here'
            : 'pass-through for every input, and what you declared absorbed')),
      gen.t);
    det.addEventListener('toggle', () => { this.showGen[key] = det.open; });
    return det;
  }

  // ---------------------------------------------------------------- a guardrail
  renderGuard(g) {
    const d = S.doc;
    const e = edge(d, g.edge);
    this.head(`Rows of ${g.label || 'unnamed guard'} (${g.id})`, g.learned ? 'learned guardrail' : 'guardrail', 'guard',
      `cuts ${e ? edgeName(e) : g.edge}`, button('Edit guard…', () => openGuardDialog(g.id), { small: true, primary: true }));
    this.host.appendChild(h('div', { class: 'mt-flow' }, h('span', { class: 'section-title' }, 'Normal flow'), h('span', { class: 'mono small' }, 'in → out'),
      h('span', { class: 'small muted grow' }, 'Everything about a guardrail is fixed by its definition except one leak row per target, whose activation is the guard\'s quality.')));
    const { t, body } = this.table(['Row', 'What it does', 'Activation', '']);
    const ts = g.targets || [];
    if (!ts.length) body.appendChild(h('tr', { class: 'note' }, h('td', { colspan: 4 }, 'No target yet: the guard passes everything and changes no verdict. ', h('button', { class: 'linkish small', onclick: () => openGuardDialog(g.id, { startAt: 'targets' }) }, 'Add what it catches…'))));
    const onCycle = !!(S.check && S.check.ok && S.check.summary.components[g.id] && S.check.summary.components[g.id].on_cycle);
    for (const tg of ts) {
      const key = 'mode' in tg ? tg.mode : 'taint' in tg ? 'taint' : 'conf' in tg ? 'conf' : 'auth';
      const decidable = !g.learned && tg.decidable;
      body.append(
        h('tr', { class: 'gen' }, h('td', { class: 'mono small' }, `catch.${g.id}.${key}`),
          h('td', { class: 'small' }, catchSentence(tg).replace('unless the guard lies on a cycle', onCycle ? 'but this guard lies on a cycle, so nothing is dropped' : 'unless the guard lies on a cycle')),
          h('td', { class: 'small' }, 'always', h('div', { class: 'muted' }, 'definition')), h('td', {})),
        h('tr', { class: 'gen leak' }, h('td', { class: 'mono small' }, `leak.${g.id}.${key}`),
          h('td', { class: 'small' }, h('span', { class: 'tag guard' }, 'leak'), ' ', `A message with ${targetText(tg)} gets through unchanged.`),
          h('td', { class: 'small' }, decidable ? 'open: N | S | A' : 'open: S | A', h('div', { class: 'muted' }, decidable ? 'decidable: may be certified never' : g.learned ? 'learned guard' : 'not decidable from the edge')),
          h('td', {})));
    }
    if (g.learned) {
      body.appendChild(h('tr', { class: 'gen' }, h('td', { class: 'mono small' }, `fp.${g.id}`),
        h('td', { class: 'small' }, h('span', { class: 'tag guard' }, 'false positive'), ' ', `It refuses a harmless message: omission at ${g.fp_omission ?? 10}.`),
        h('td', { class: 'small' }, 'open: S | A', h('div', { class: 'muted' }, 'learned guard')), h('td', {})));
    }
    body.appendChild(h('tr', { class: 'gen' }, h('td', { class: 'mono small' }, `pass.${g.id}`),
      h('td', { class: 'small' }, 'Every failure it does not target goes on unchanged; it neither taints nor lowers authority.'),
      h('td', { class: 'small' }, 'always', h('div', { class: 'muted' }, 'definition')), h('td', {})));
    this.host.appendChild(h('div', { class: 'mt-scroll' }, t));
  }
}

function actShort(r, c) {
  const kind = rowKind(r);
  const act = r.activation || (kind === 'forwarding' ? 'always' : 'open');
  if (act === 'open') return h('span', {}, c.kind === 'llm' && kind !== 'forwarding' && kind !== 'sink' ? 'open: S | A' : 'open: N | S | A', h('div', { class: 'muted' }, 'the evidence decides'));
  return h('span', {}, act, h('div', { class: 'muted' }, r.activation ? 'fixed in the model' : 'forwarding default'));
}

function restoreDefault(cid, q, m) {
  const doc = cloneDoc();
  const c = comp(doc, cid);
  c.drop_defaults = (c.drop_defaults || []).filter((x) => !(x.port === q && x.mode === m));
  if (!c.drop_defaults.length) delete c.drop_defaults;
  commitDoc(doc, { type: 'component', id: cid });
  toast(`Default ${m} on ${q} restored.`);
}
