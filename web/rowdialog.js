// The row dialog: add a row to a component's mapping table step by step, or edit one (the same
// steps, as tabs). Rows are explained in docs/model-format.md ("Rows"); the checks and the sentence
// come from rows.js, and Save asks the server's model check before the row goes in.
import { h, toast } from './lib.js';
import { S, comp, modeFields, cloneDoc, commitDoc, newProblems, emit } from './state.js';
import { wizard, field, textInput, numberInput, selectInput, choiceCards, button, confirmDialog } from './dialog.js';
import * as R from './rows.js';

/**
 * Open the row dialog.
 *   cid      the component
 *   rowId    a row to edit, or null for a new one
 *   opts     {preset: partial draft (e.g. refining an LLM default), from: a row to copy, startAt: step id}
 */
export function openRowDialog(cid, rowId, opts = {}) {
  const c0 = comp(S.doc, cid);
  if (!c0) return;
  const fields = modeFields(S.doc).map((m) => m.name);
  const original = rowId ? (c0.rows || []).find((r) => r.id === rowId) : null;
  const mode = original ? 'edit' : 'add';
  const taken = R.allRowIds(S.doc);
  if (original) taken.delete(original.id);
  const info = { comp: c0, fields, takenIds: taken };

  let draft;
  if (original) draft = R.toDraft(original);
  else if (opts.from) { draft = R.toDraft(opts.from); draft.id = R.freshRowId(cid, taken, `${opts.from.id}_copy`); }
  else {
    draft = R.toDraft(null);
    draft.when = [{ port: c0.in.length === 1 ? c0.in[0] : (c0.in[0] || '*'), any: true, mode: '', threshold: 1 }];
    draft.then = c0.out[0] ? [{ port: c0.out[0], asis: false, mode: fields[0], op: 'const', k: 5 }] : [];
    draft.id = R.freshRowId(cid, taken);
    if (!c0.in.length) draft = R.setKind(draft, 'internal', c0, fields);
    if (opts.preset) draft = { ...draft, ...opts.preset };
  }
  const data = { draft };
  const P = () => R.draftProblemsByStep(data.draft, info);
  const llm = c0.kind === 'llm';

  // ---------------------------------------------------------------- step: kind
  const renderKind = (ctx) => {
    const d = data.draft;
    const opt = (value) => {
      const why = value === 'sink' && llm ? 'An LLM passes nothing through, so it has nothing to absorb.'
        : value !== 'internal' && !c0.in.length ? `${cid} has no input port yet.`
          : value !== 'sink' && !c0.out.length ? `${cid} has no output port yet.` : '';
      return { value, title: R.KINDS[value].title, text: R.KINDS[value].text, disabled: !!why, why };
    };
    return h('div', { class: 'block' },
      choiceCards(['failure', 'internal', 'forwarding', 'sink'].map(opt), d.kind, (v) => { data.draft = R.setKind(data.draft, v, c0, fields); ctx.rerender(); }),
      llm ? h('p', { class: 'hint' }, `${cid} is an LLM component: whatever it sends carries only the failures its rows emit, and its rows are never "never".`) : null);
  };

  // ---------------------------------------------------------------- step: when
  const renderTrigger = (ctx) => {
    const d = data.draft;
    const box = h('div', { class: 'block' });
    const portOpts = (cur) => [['*', 'any input', d.when.length > 1 && cur !== '*'], ...c0.in.map((p) => [p, p, d.when.some((x) => x.port === p && x.port !== cur)])];
    d.when.forEach((cnd, i) => {
      const line = h('div', { class: 'edit-line' },
        field('Input port', selectInput(portOpts(cnd.port), cnd.port, (v) => { cnd.port = v; if (v === '*') cnd.any = true; ctx.rerender(); })),
        field('What arrives', selectInput([['any', 'any message'], ['mode', 'a failure of at least', cnd.port === '*' || d.kind === 'forwarding']], cnd.any ? 'any' : 'mode',
          (v) => { cnd.any = v === 'any'; if (!cnd.any && !cnd.mode) cnd.mode = fields[0]; ctx.rerender(); })),
        cnd.any ? null : field('Failure mode', selectInput(fields.map((f) => [f, f]), cnd.mode, (v) => { cnd.mode = v; ctx.update(); })),
        cnd.any ? null : field('Magnitude ≥', numberInput(cnd.threshold, (v) => { cnd.threshold = v; ctx.update(); }, { min: 1, max: 10 })),
        h('span', { class: 'spacer' }),
        d.when.length > 1 || d.kind === 'failure' ? button('Remove', () => { d.when.splice(i, 1); ctx.rerender(); }, { small: true, ghost: true, title: 'remove this condition' }) : null);
      box.appendChild(line);
    });
    const free = c0.in.filter((p) => !d.when.some((x) => x.port === p));
    if (free.length && !d.when.some((x) => x.port === '*')) {
      box.appendChild(h('div', {}, button(d.when.length ? '+ And a condition on another input' : '+ Add a condition', () => { d.when.push({ port: free[0], any: true, mode: '', threshold: 1 }); ctx.rerender(); }, { small: true })));
    }
    box.appendChild(h('p', { class: 'hint' }, d.when.length > 1 ? 'Every condition must hold at once: the row fires when all the listed ports receive what they say.'
      : '"A failure of at least" matches a message carrying that failure at the given magnitude or more (magnitudes run from 1 to 10). "Any input" matches a message on any input port.'));
    return box;
  };

  // ---------------------------------------------------------------- step: then
  const renderEffect = (ctx) => {
    const d = data.draft;
    const box = h('div', { class: 'block' });
    if (d.kind === 'forwarding') {
      box.appendChild(h('p', { class: 'hint' }, 'Tick the output ports the message goes on to, as it arrived.'));
      for (const q of c0.out) {
        const on = d.then.some((e) => e.port === q);
        box.appendChild(h('label', { class: 'f-check' }, h('input', { type: 'checkbox', checked: on, onchange: (ev) => {
          if (ev.target.checked) d.then.push({ port: q, asis: true, mode: '', op: 'const', k: 5 }); else d.then = d.then.filter((e) => e.port !== q);
          ctx.update();
        } }), h('span', { class: 'mono' }, q)));
      }
      return box;
    }
    const matched = d.kind !== 'internal' && d.when.some((c) => !c.any);
    d.then.forEach((em, i) => {
      const what = em.asis ? '__asis' : em.mode;
      const opOpts = Object.entries(R.OPS).map(([k, o]) => [k, o.label, d.kind === 'internal' ? k !== 'const' : o.needsMatch && !matched]);
      box.appendChild(h('div', { class: 'edit-line' },
        field('Output port', selectInput(c0.out.map((q) => [q, q]), em.port, (v) => { em.port = v; ctx.update(); })),
        field('Sends', selectInput([...fields.map((f) => [f, f]), ...(d.kind === 'internal' ? [] : [['__asis', 'the message as it is']])], what,
          (v) => { if (v === '__asis') em.asis = true; else { em.asis = false; em.mode = v; } ctx.rerender(); })),
        em.asis ? null : field('How strong', selectInput(opOpts, em.op, (v) => { em.op = v; if (v === 'plus' && !(em.k >= 1)) em.k = 1; ctx.rerender(); })),
        !em.asis && R.OPS[em.op] && R.OPS[em.op].needsK ? field(em.op === 'plus' ? '+ k' : 'Magnitude', numberInput(em.k, (v) => { em.k = v; ctx.update(); }, { min: em.op === 'plus' ? 1 : 0, max: 10 })) : null,
        h('span', { class: 'spacer' }),
        button('Remove', () => { d.then.splice(i, 1); ctx.rerender(); }, { small: true, ghost: true, title: 'remove this emission' })));
    });
    box.appendChild(h('div', { class: 'inline' },
      button('+ Add an emission', () => { const q = c0.out[0]; const f = fields.find((x) => !d.then.some((e) => e.port === q && e.mode === x)) || fields[0]; d.then.push({ port: q, asis: false, mode: f, op: 'const', k: 5 }); ctx.rerender(); }, { small: true, disabled: !c0.out.length })));
    box.appendChild(h('p', { class: 'hint' }, matched
      ? 'The matched magnitude is the magnitude of the failure the condition matched (the largest, if it matches several). A magnitude runs from 0 to 10.'
      : d.kind === 'internal' ? 'An internal fault starts its failures at a fixed magnitude, from 0 to 10.'
        : 'With "any message" in the condition there is no matched failure, so the row sends a fixed magnitude. "The message as it is" sends it on unchanged; a guard may still drop it, because it exists only because the row fired.'));
    return box;
  };

  // ---------------------------------------------------------------- step: name and activation
  const renderName = (ctx) => {
    const d = data.draft;
    const renamed = original && d.id.trim() !== original.id;
    const users = original ? certsNaming(original.id) : [];
    return h('div', { class: 'block' },
      h('div', { class: 'fields2' },
        field('Id', textInput(d.id, (v) => { d.id = v; ctx.update(); }, { class: 'mono', spellcheck: 'false' }), renamed && users.length ? `Certificates ${users.join(', ')} name ${original.id}: they will no longer match.` : 'Certificates and the verdicts name the row by this id.'),
        field('Description', textInput(d.label, (v) => { d.label = v; ctx.update(); }, { placeholder: 'e.g. re-plans on a stale view and pays again' }), 'Optional: what this failure is, in words.')),
      h('span', { class: 'f-label' }, 'Activation'),
      choiceCards(R.activationChoices(d, c0).map((a) => ({ value: a.value, title: a.value === 'open' ? 'Open' : a.value[0].toUpperCase() + a.value.slice(1), text: a.text,
        disabled: a.disabled, why: a.disabled ? 'The LLM rule: a row of an LLM that emits a failure is never "never".' : '' })), d.activation, (v) => { d.activation = v; ctx.rerender(); }),
      h('p', { class: 'hint' }, 'Leave a row open unless the model fixes it on purpose: the analysis then keeps every activation as a candidate and lets the evidence choose.'));
  };

  // ---------------------------------------------------------------- preview and save
  const preview = () => {
    const row = R.fromDraft(data.draft, original);
    const ok = !R.draftProblems(data.draft, info).length;
    return h('div', { class: 'preview' },
      h('div', { class: 'preview-head' }, h('span', { class: 'section-title' }, 'What it does'), h('span', { class: `tag ${ok ? 'plain' : 'warn-tag'}` }, R.KINDS[data.draft.kind] ? R.KINDS[data.draft.kind].title.toLowerCase() : '?')),
      h('p', { class: 'sentence' }, ok || row.id ? R.rowSentence(row, c0) : '…'),
      h('p', { class: 'small muted' }, `Activation: ${R.activationText(data.draft.activation, llm && data.draft.then.some((e) => !e.asis), data.draft.kind)}.`),
      h('details', { class: 'yaml-peek' }, h('summary', {}, 'As YAML'), h('pre', { class: 'code' }, R.rowYaml(row))));
  };

  const onSave = async (ctx, { force } = {}) => {
    const row = R.fromDraft(data.draft, original);
    const doc = cloneDoc();
    const c = comp(doc, cid);
    c.rows = c.rows || [];
    if (original) c.rows[c.rows.findIndex((r) => r.id === original.id)] = row;
    else c.rows.push(row);
    if (!force) {
      const warn = original && row.id !== original.id ? certsNaming(original.id).map((x) => `certificate ${x} names the old id ${original.id}`) : [];
      const fresh = await newProblems(doc);
      if (warn.length || fresh.length) return { problems: [...warn, ...fresh], canForce: true, title: 'Before this row goes in:' };
    }
    commitDoc(doc, { type: 'component', id: cid });
    emit('maptable:show');
    toast(mode === 'add' ? `Row ${row.id} added to ${cid}.` : `Row ${row.id} saved.`);
    return true;
  };

  wizard({
    title: mode === 'add' ? `New row for ${cid}` : `Edit row ${original.id}`,
    subtitle: mode === 'add' ? `A row says which failure arriving where makes ${cid} send which failure where, which failure it starts, or where it forwards a message.` : `${cid} · ${R.KINDS[R.rowKind(original)].title.toLowerCase()}`,
    mode, size: 'lg', data, startAt: opts.startAt,
    saveLabel: mode === 'add' ? 'Add row' : 'Save row',
    steps: [
      { id: 'kind', title: 'Kind', hint: 'What sort of behaviour does this row describe?', render: renderKind, problems: () => P().kind },
      { id: 'trigger', title: 'When', hint: `What has to arrive at ${cid} for the row to fire.`, render: renderTrigger, problems: () => P().trigger, skip: () => data.draft.kind === 'internal' },
      { id: 'effect', title: 'Then', hint: () => (data.draft.kind === 'forwarding' ? 'Where the message goes on.' : `What ${cid} sends on when the row fires.`), render: renderEffect, problems: () => P().effect, skip: () => data.draft.kind === 'sink' },
      { id: 'name', title: 'Name and activation', hint: 'How the row is called, and whether the model fixes how often it fires.', render: renderName, problems: () => P().name },
    ],
    preview, onSave,
  });
}

/** Ask, then delete a row. */
export async function deleteRow(cid, rowId) {
  const users = certsNaming(rowId);
  const ok = await confirmDialog(`Delete row ${rowId} of ${cid}?`, {
    title: 'Delete the row', okText: 'Delete', danger: true,
    detail: users.length ? h('p', { class: 'hint' }, `Certificate(s) ${users.join(', ')} name this row; they will be rejected as naming an unknown row.`) : null,
  });
  if (!ok) return;
  const doc = cloneDoc();
  const c = comp(doc, cid);
  c.rows = (c.rows || []).filter((r) => r.id !== rowId);
  commitDoc(doc, { type: 'component', id: cid });
  toast(`Row ${rowId} deleted.`);
}

/** Certificates in the register that state the activation of this row by its id. */
function certsNaming(rowId) {
  return (S.evidence.certificates || []).filter((c) => Object.keys(c.rows || {}).includes(rowId)).map((c) => c.id);
}
