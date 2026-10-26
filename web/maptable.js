// The mapping table of the selected component or guard, under the canvas.
//
// Definition (Component) gives every component a normal flow and a mapping table of rows: a when
// part (a pattern on one or more input ports, all of which must match) and a then part (failures
// emitted on output ports: const k, keep, +k, max). The table shows every row the analysis uses:
//   * the analyst's rows (editable here),
//   * pass-through: every failure a message brings goes on where the component forwards it
//     (assumption A6, pessimistic), except what the analyst declares absorbed, with a reason,
//   * for an LLM component, the worst-case defaults (Definition: LLM default table),
//   * for a guardrail, its fixed catching behaviour, one leak row per target and, if learned, its
//     false-positive row (Definition: Guardrail),
//   * the declared absorptions, each with its reason (a claim an auditor can dispute).
import { h, clear, toast } from './lib.js';
import { S, on, emit, comp, edge, modeFields, topModes, changed, targetText } from './state.js';

const OPS = [['const', 'const'], ['keep', 'keep'], ['plus', '+k'], ['max', 'max']];

export class MapTable {
  constructor(host) {
    this.host = host;
    this.open = true;
    on('select', () => this.render());
    on('loaded', () => this.render());
    on('check', () => this.render());
    on('doc', () => { if (!this.editing) this.render(); });
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

  shell(title, chip, chipClass, meta, ...buttons) {
    const head = h('div', { class: 'mt-head' }, h('b', {}, title), chip ? h('span', { class: `kind-chip ${chipClass || ''}` }, chip) : null,
      h('span', { class: 'mono small muted' }, meta), h('span', { class: 'spacer' }), ...buttons,
      h('button', { class: 'x', 'aria-label': 'close the mapping table', title: 'close', onclick: () => { this.open = false; emit('maptable:toggled', false); this.render(); } }, '×'));
    const table = h('table', { class: 'mt' }, h('thead', {}, h('tr', {}, ['Row', 'When (every port listed must match)', 'Then it emits', 'Activation', 'Kind'].map((x) => h('th', {}, x)))));
    const body = h('tbody');
    table.appendChild(body);
    this.host.append(head);
    return { body, table };
  }

  // ---------------------------------------------------------------- a component
  renderComponent(c, port) {
    const d = S.doc;
    const fields = modeFields(d).map((m) => m.name);
    const llm = c.kind === 'llm';
    const { body, table } = this.shell(`Mapping table of ${c.id}`, llm ? 'LLM' : c.kind, llm ? 'llm' : '',
      `In(${c.id}) = {${c.in.join(', ')}} · Out(${c.id}) = {${c.out.join(', ')}}`,
      h('button', { class: 'btn small', disabled: !c.out.length || undefined, title: c.out.length ? '' : 'the component has no output port yet', onclick: () => this.addRow(c, fields) }, 'Add row'));
    const flow = c.flow || Object.fromEntries(c.in.map((p) => [p, c.out.slice()]));
    this.host.appendChild(h('div', { class: 'mt-flow' }, h('span', { class: 'section-title' }, 'Normal flow'),
      c.in.length ? c.in.map((p) => h('span', { class: 'mono small' }, `${p} → ${(flow[p] || []).join(', ') || 'nothing'}`)) : h('span', { class: 'small muted' }, 'no input port yet'),
      h('span', { class: 'small muted' }, llm ? 'An LLM passes nothing through: what it sends carries only the failures its rows emit, and the merged provenance of what arrived.'
        : 'A message goes on with every failure it brought (pass-through) unless the component absorbs it; a row adds a failure, a sink row may absorb one.')));
    const hl = (r) => port && (port.side === 'in' ? (r.when || {})[port.name] !== undefined || (r.when || {})['*'] !== undefined : (r.then || {})[port.name] !== undefined);
    // analyst rows
    for (const r of c.rows || []) body.appendChild(this.rowLine(c, r, fields, hl(r)));
    if (!(c.rows || []).length) body.appendChild(h('tr', { class: 'note' }, h('td', { colspan: 5 }, llm ? 'No rows of your own: the worst-case defaults below stand for this LLM until you refine them.' : 'No rows of your own yet. A row says which failure arriving where makes the component emit which failure where, or which failure it starts on its own.')));
    // pass-through
    if (!llm && c.in.length && c.out.length) body.appendChild(this.passLine(c, port));
    // LLM defaults
    if (llm) for (const q of c.out) for (const m of topModes(d)) body.appendChild(this.defaultLine(c, q, m, port));
    // declared absorptions
    for (const a of c.absorbs || []) body.appendChild(this.absorbedLine(c, a));
    this.host.appendChild(h('div', { class: 'mt-scroll' }, table));
  }

  rowLine(c, r, fields, highlight) {
    r.when = r.when || {}; r.then = r.then || {};
    const llm = c.kind === 'llm';
    const tr = h('tr', { class: `analyst${highlight ? ' hl' : ''}` });
    tr.appendChild(h('td', { class: 'rowid' },
      h('input', { value: r.id, class: 'mono', 'aria-label': 'row id', onchange: (e) => { if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(e.target.value)) { toast('Row ids are identifiers.'); return; } r.id = e.target.value; this.commit(); } }),
      h('input', { value: r.label || '', placeholder: 'what this failure is', 'aria-label': 'row description', onchange: (e) => { r.label = e.target.value; this.commit(); } })));
    // when
    const when = h('td', { class: 'when' });
    for (const [p, pat] of Object.entries(r.when)) {
      const isAny = pat === 'any' || pat === true || pat === null;
      const [m0, th0] = isAny ? [fields[0], 1] : Object.entries(pat)[0] || [fields[0], 1];
      when.appendChild(h('div', { class: 'cond' },
        h('select', { 'aria-label': 'input port', onchange: (e) => { const v = r.when[p]; delete r.when[p]; r.when[e.target.value] = e.target.value === '*' ? 'any' : v; this.commit(true); } },
          ['*', ...c.in].map((x) => h('option', { value: x, selected: x === p ? true : undefined }, x === '*' ? 'any input' : x))),
        h('span', { class: 'sep' }, ':'),
        h('select', { 'aria-label': 'pattern', onchange: (e) => { r.when[p] = e.target.value === 'any' ? 'any' : { [m0]: th0 }; this.commit(true); } },
          [['any', 'any message'], ['mode', 'failure ≥']].filter(([v]) => !(p === '*' && v === 'mode')).map(([v, t]) => h('option', { value: v, selected: (isAny ? 'any' : 'mode') === v ? true : undefined }, t))),
        isAny ? null : h('select', { 'aria-label': 'mode', onchange: (e) => { r.when[p] = { [e.target.value]: th0 }; this.commit(); } }, fields.map((f) => h('option', { value: f, selected: f === m0 ? true : undefined }, f))),
        isAny ? null : h('input', { type: 'number', min: 1, max: 10, value: th0, 'aria-label': 'threshold', onchange: (e) => { r.when[p] = { [m0]: Number(e.target.value) }; this.commit(); } }),
        h('button', { class: 'x', 'aria-label': 'remove condition', onclick: () => { delete r.when[p]; this.commit(true); } }, '×')));
    }
    const freePorts = c.in.filter((x) => !(x in r.when));
    if (!('*' in r.when) && freePorts.length) when.appendChild(h('button', { class: 'linkish small', onclick: () => { r.when[freePorts[0]] = 'any'; if (r.when['*']) delete r.when['*']; this.commit(true); } }, Object.keys(r.when).length ? '+ and on another port' : '+ condition'));
    if (!Object.keys(r.when).length) when.appendChild(h('span', { class: 'small muted' }, 'no condition: an internal fault, it fires with no message arriving'));
    tr.appendChild(when);
    // then
    const then = h('td', { class: 'then' });
    const asIs = (em) => !em || typeof em === 'string' || !Object.keys(em).length;
    for (const [q, emits] of Object.entries(r.then)) {
      if (asIs(emits)) {
        // the message is sent on as it is: it carries what arrived, nothing is added
        then.appendChild(h('div', { class: 'cond' },
          h('select', { 'aria-label': 'output port', onchange: (e) => { delete r.then[q]; r.then[e.target.value] = 'as it is'; this.commit(true); } },
            c.out.map((x) => h('option', { value: x, selected: x === q ? true : undefined }, x))),
          h('span', { class: 'sep' }, ':'), h('span', { class: 'small' }, 'as it is'),
          h('button', { class: 'x', 'aria-label': 'remove emission', onclick: () => { delete r.then[q]; this.commit(true); } }, '×')));
        continue;
      }
      for (const [m, op] of Object.entries(emits || {})) {
        const o = String(op).trim();
        const kind = o.startsWith('const') || /^\d+$/.test(o) ? 'const' : o.startsWith('+') ? 'plus' : o;
        const k = kind === 'const' ? Number(o.replace('const', '').trim()) : kind === 'plus' ? Number(o.slice(1)) : 0;
        const setOp = (nk, nv) => { r.then[q][m] = nk === 'const' ? `const ${nv}` : nk === 'plus' ? `+${nv}` : nk; this.commit(true); };
        then.appendChild(h('div', { class: 'cond' },
          h('select', { 'aria-label': 'output port', onchange: (e) => { const v = r.then[q][m]; delete r.then[q][m]; if (!Object.keys(r.then[q]).length) delete r.then[q]; (r.then[e.target.value] = r.then[e.target.value] || {})[m] = v; this.commit(true); } },
            c.out.map((x) => h('option', { value: x, selected: x === q ? true : undefined }, x))),
          h('span', { class: 'sep' }, ':'),
          h('select', { 'aria-label': 'emitted mode', onchange: (e) => { const v = r.then[q][m]; delete r.then[q][m]; r.then[q][e.target.value] = v; this.commit(true); } }, fields.map((f) => h('option', { value: f, selected: f === m ? true : undefined }, f))),
          h('select', { 'aria-label': 'operator', onchange: (e) => setOp(e.target.value, e.target.value === 'plus' ? 2 : 5) },
            OPS.map(([v, t]) => h('option', { value: v, selected: v === kind ? true : undefined }, t))),
          ['const', 'plus'].includes(kind) ? h('input', { type: 'number', min: 0, max: 10, value: k, 'aria-label': 'magnitude', onchange: (e) => setOp(kind, Number(e.target.value)) }) : null,
          h('button', { class: 'x', 'aria-label': 'remove emission', onclick: () => { delete r.then[q][m]; if (!Object.keys(r.then[q]).length) delete r.then[q]; this.commit(true); } }, '×')));
      }
    }
    if (c.out.length) then.appendChild(h('button', { class: 'linkish small', onclick: () => { const q = c.out.find((x) => !asIs(r.then[x]) || !(x in r.then)) || c.out[0]; if (asIs(r.then[q])) r.then[q] = {}; const f = fields.find((x) => !(x in r.then[q])) || fields[0]; r.then[q][f] = 'const 5'; this.commit(true); } }, '+ emission'));
    const freeOut = c.out.filter((x) => !(x in r.then));
    if (freeOut.length) then.appendChild(h('button', { class: 'linkish small', title: 'send the message on this port as it is (a forwarding row when no failure is involved)', onclick: () => { r.then[freeOut[0]] = 'as it is'; this.commit(true); } }, '+ as it is'));
    if (!Object.keys(r.then).length) then.appendChild(h('span', { class: 'small muted' }, 'no emission: a sink, it absorbs the failures it matches'));
    const needsMode = Object.values(r.then).some((em) => !asIs(em) && Object.values(em).some((op) => /^(keep|max|\+)/.test(String(op).trim())));
    const hasMode = Object.values(r.when).some((pat) => pat && typeof pat === 'object');
    if (needsMode && !hasMode) then.appendChild(h('span', { class: 'small warn' }, 'keep, +k and max need a failure in the when part'));
    tr.appendChild(then);
    // activation
    const acts = [['open', llm ? 'open: S | A' : 'open: N | S | A'], ['always', 'always (fixed)'], ['sometimes', 'sometimes (fixed)'], ...(llm ? [] : [['never', 'never (fixed)']])];
    tr.appendChild(h('td', { class: 'act-cell' }, h('select', { 'aria-label': 'activation', onchange: (e) => { if (e.target.value === 'open') delete r.activation; else r.activation = e.target.value; this.commit(); } },
      acts.map(([v, t]) => h('option', { value: v, selected: (r.activation || 'open') === v ? true : undefined }, t))),
    h('span', { class: 'small muted' }, r.activation ? 'fixed in the model' : llm ? 'LLM rule: never “never”' : 'a candidate choice')));
    const failIn = Object.values(r.when).some((pat) => pat && typeof pat === 'object');
    const kindTag = !Object.keys(r.then).length ? 'sink' : !Object.keys(r.when).length ? 'internal fault'
      : (!failIn && Object.values(r.then).every(asIs)) ? 'forwarding' : 'analyst';
    tr.appendChild(h('td', {}, h('span', { class: 'tag plain' }, kindTag),
      h('button', { class: 'x', 'aria-label': `delete row ${r.id}`, title: 'delete the row', onclick: () => { c.rows = c.rows.filter((x) => x !== r); this.commit(true); } }, '×')));
    return tr;
  }

  passLine(c, port) {
    // one line per input port: a mode passes unless it is declared absorbed there
    const d = S.doc;
    const tops = topModes(d);
    const lines = [];
    for (const p of c.in) {
      const absorbed = new Set((c.absorbs || []).filter((a) => a.port === p).flatMap((a) => (a.modes === 'all' ? tops : [].concat(a.modes || a.mode || []))));
      const toggle = (m) => {
        c.absorbs = c.absorbs || [];
        if (absorbed.has(m)) {
          for (const a of c.absorbs.filter((x) => x.port === p)) {
            const ms = a.modes === 'all' ? tops.slice() : [].concat(a.modes || a.mode || []);
            a.modes = ms.filter((x) => x !== m); delete a.mode;
          }
          c.absorbs = c.absorbs.filter((a) => a.modes.length);
        } else {
          const a = c.absorbs.find((x) => x.port === p);
          if (a) { a.modes = (a.modes === 'all' ? tops.slice() : [].concat(a.modes || a.mode || [])).concat([m]); delete a.mode; }
          else c.absorbs.push({ port: p, modes: [m], reason: '' });
        }
        this.commit(true);
      };
      const chips = h('div', { class: 'chips' }, tops.map((m) => h('button', { class: `mchip${absorbed.has(m) ? '' : ' on'}`, 'aria-pressed': String(!absorbed.has(m)),
        title: absorbed.has(m) ? `${m} is absorbed at ${p} (click to let it pass)` : `${m} passes from ${p} (click to absorb it, with a reason)`, onclick: () => toggle(m) }, m)));
      const hl = port && port.side === 'in' && port.name === p ? ' hl' : '';
      lines.push(h('tr', { class: `gen${hl}` },
        h('td', { class: 'mono small' }, `pass.${c.id}.${p}`),
        h('td', {}, h('span', { class: 'small' }, `${p}: m ≥ 1, for each mode m that passes:`), chips),
        h('td', { class: 'small' }, `every output ${p} is forwarded to: m keep`),
        h('td', { class: 'small' }, 'always', h('br'), h('span', { class: 'muted' }, 'A6: pass-through by default')),
        h('td', {}, h('span', { class: 'tag plain' }, 'pass-through'))));
    }
    const frag = document.createDocumentFragment();
    lines.forEach((l) => frag.appendChild(l));
    return frag;
  }

  defaultLine(c, q, m, port) {
    c.drop_defaults = c.drop_defaults || [];
    // a row replaces the default only with the same trigger - any input, any message - and the same mode
    // on the same port; any other row that emits it there goes beside the default
    const anyMsg = (r) => { const w = r.when || {}; const ks = Object.keys(w); return ks.length === 1 && (ks[0] === '*' || (c.in.length === 1 && ks[0] === c.in[0])) && w[ks[0]] === 'any'; };
    const refinedBy = (c.rows || []).filter((r) => r.then && r.then[q] && typeof r.then[q] === 'object' && m in r.then[q] && anyMsg(r)).map((r) => r.id);
    const beside = (c.rows || []).filter((r) => r.then && r.then[q] && typeof r.then[q] === 'object' && !anyMsg(r) && Object.keys(r.then[q]).length).map((r) => r.id);
    const drop = c.drop_defaults.find((x) => x.port === q && x.mode === m);
    const status = refinedBy.length ? 'refined' : drop ? 'dropped' : 'active';
    const hl = port && port.side === 'out' && port.name === q ? ' hl' : (port && port.side === 'in' ? ' hl' : '');
    const kindCell = h('td', {}, h('span', { class: 'tag llm' }, 'worst-case default'));
    if (status === 'active') {
      kindCell.append(h('button', { class: 'linkish small', onclick: () => {
        const ids = new Set((c.rows || []).map((r) => r.id)); let id = `${c.id}_${q}_${m}`; let i = 2; while (ids.has(id)) id = `${c.id}_${q}_${m}${i++}`;
        c.rows.push({ id, label: '', when: { [c.in.length === 1 ? c.in[0] : '*']: 'any' }, then: { [q]: { [m]: 'const 10' } } });
        this.commit(true);
      } }, 'refine'), h('button', { class: 'linkish small', onclick: () => { c.drop_defaults.push({ port: q, mode: m, reason: '' }); this.commit(true); } }, 'drop…'));
    } else if (status === 'dropped') {
      kindCell.append(h('button', { class: 'linkish small', onclick: () => { c.drop_defaults = c.drop_defaults.filter((x) => x !== drop); this.commit(true); } }, 'restore'),
        h('input', { value: drop.reason || '', placeholder: 'the structural reason (required)', class: 'reason', onchange: (e) => { drop.reason = e.target.value; this.commit(); } }));
    }
    return h('tr', { class: `gen ${status}${hl}` },
      h('td', { class: 'mono small' }, `default.${c.id}.${q}.${m}`),
      h('td', { class: 'small' }, 'any input: any message'),
      h('td', { class: 'small' }, h('span', { class: 'mono' }, `${q}: ${m} const 10`)),
      h('td', { class: 'small' }, status === 'refined' ? h('span', { class: 'muted' }, `replaced by ${refinedBy.join(', ')}`) : status === 'dropped' ? h('span', { class: 'muted' }, 'dropped, with a reason')
        : h('span', {}, 'open: S | A', h('br'), h('span', { class: 'muted' }, beside.length ? `LLM rule; ${beside.join(', ')} beside it` : 'LLM rule'))),
      kindCell);
  }

  absorbedLine(c, a) {
    const ms = a.modes === 'all' ? ['every mode'] : [].concat(a.modes || a.mode || []);
    return h('tr', { class: 'gen absorbed' },
      h('td', { class: 'small' }, '—'),
      h('td', { class: 'small' }, h('span', { class: 'mono' }, `${a.port}: ${ms.join(', ')} ≥ 1`)),
      h('td', { class: 'small' }, 'nothing: absorbed here'),
      h('td', { class: 'small' }, h('input', { value: a.reason || '', placeholder: 'why it stops here (required)', class: 'reason',
        onchange: (e) => { a.reason = e.target.value; this.commit(); } })),
      h('td', {}, h('span', { class: 'tag absorbed' }, 'absorbed'),
        h('button', { class: 'linkish small', onclick: () => { c.absorbs = (c.absorbs || []).filter((x) => x !== a); this.commit(true); } }, 'pass it through')));
  }

  addRow(c, fields) {
    const ids = new Set(S.doc.components.flatMap((x) => (x.rows || []).map((r) => r.id)));
    let i = 1; while (ids.has(`${c.id}_r${i}`)) i++;
    c.rows.push({ id: `${c.id}_r${i}`, when: { [c.in[0] || '*']: 'any' }, then: c.out[0] ? { [c.out[0]]: { [fields[0]]: 'const 5' } } : {} });
    this.commit(true);
  }

  commit(rerender) {
    this.editing = !rerender;
    changed();
    this.editing = false;
    if (rerender) this.render();
  }

  // ---------------------------------------------------------------- a guardrail
  renderGuard(g) {
    const d = S.doc;
    const e = edge(d, g.edge);
    const { body, table } = this.shell(`Mapping table of ${g.label || 'unnamed guard'} (${g.id})`, g.learned ? 'learned guardrail' : 'guardrail', 'guard',
      `In(${g.id}) = {in} · Out(${g.id}) = {out} · cuts ${g.edge}${e ? `: ${e.from} → ${e.to}` : ''}`);
    this.host.appendChild(h('div', { class: 'mt-flow' }, h('span', { class: 'section-title' }, 'Normal flow'), h('span', { class: 'mono small' }, 'in → out'),
      h('span', { class: 'small muted' }, 'Everything about a guardrail is fixed by its definition except one leak row per target, whose activation is the guard\'s quality.')));
    const ts = g.targets || [];
    if (!ts.length) body.appendChild(h('tr', { class: 'note' }, h('td', { colspan: 5 }, 'No target yet: the guard passes everything and changes no verdict. Add what it checks for in the inspector.')));
    for (const t of ts) {
      const key = 'mode' in t ? t.mode : 'taint' in t ? 'taint' : 'conf' in t ? 'conf' : 'auth';
      const cond = 'mode' in t ? `in: ${t.mode} ≥ ${t.threshold || 1}` : 'taint' in t ? 'in: tainted' : 'conf' in t ? `in: confidentiality above ${t.conf}` : `in: authority below ${t.auth}`;
      const onCycle = !!(S.check && S.check.ok && S.check.summary.components[g.id] && S.check.summary.components[g.id].on_cycle);
      const caught = 'mode' in t ? `out: ${t.mode} capped at ${(t.threshold || 1) - 1}; ${onCycle ? 'on a cycle, so nothing is dropped' : 'a message only a failure row created is dropped'}`
        : 'taint' in t ? 'out: clean' : 'conf' in t ? `out: confidentiality ${t.conf} (redacted)` : `out: authority ${t.auth} (approved)`;
      const decidable = !g.learned && t.decidable;
      body.append(
        h('tr', { class: 'gen' }, h('td', { class: 'mono small' }, `catch.${g.id}.${key}`), h('td', { class: 'small' }, `${cond}, and the leak row does not fire`),
          h('td', { class: 'small' }, caught), h('td', { class: 'small' }, 'always', h('br'), h('span', { class: 'muted' }, 'definition')), h('td', {}, h('span', { class: 'tag guard' }, 'catch'))),
        h('tr', { class: 'gen leak' }, h('td', { class: 'mono small' }, `leak.${g.id}.${key}`), h('td', { class: 'small' }, cond),
          h('td', { class: 'small' }, `out: the ${targetText(t)} failure gets through unchanged`),
          h('td', { class: 'small' }, decidable ? 'open: N | S | A' : 'open: S | A', h('br'), h('span', { class: 'muted' }, decidable ? 'decidable: may be certified never' : g.learned ? 'learned guard' : 'not decidable from the edge')),
          h('td', {}, h('span', { class: 'tag guard' }, 'leak row'))));
    }
    if (g.learned) {
      body.appendChild(h('tr', { class: 'gen' }, h('td', { class: 'mono small' }, `fp.${g.id}`), h('td', { class: 'small' }, 'in: any message'),
        h('td', { class: 'small' }, `out: omission const ${g.fp_omission ?? 10} (it refuses a harmless message)`), h('td', { class: 'small' }, 'open: S | A', h('br'), h('span', { class: 'muted' }, 'learned guard')), h('td', {}, h('span', { class: 'tag guard' }, 'false positive'))));
    }
    body.appendChild(h('tr', { class: 'gen' }, h('td', { class: 'mono small' }, `pass.${g.id}`), h('td', { class: 'small' }, 'in: every failure it does not target'),
      h('td', { class: 'small' }, 'out: unchanged; provenance unchanged (it neither taints nor lowers authority)'), h('td', { class: 'small' }, 'always', h('br'), h('span', { class: 'muted' }, 'definition')), h('td', {}, h('span', { class: 'tag plain' }, 'pass-through'))));
    this.host.appendChild(h('div', { class: 'mt-scroll' }, table));
  }
}
