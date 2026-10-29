// Rows of a component's mapping table, as plain data: the draft the row dialog edits, the
// conversion back to the model document, the checks the dialog runs before saving, and the
// sentence that says what a row does. No DOM here, so node can test it (web/tests/).
//
// A row in the document (docs/model-format.md, "Rows"):
//   {id, label?, when: {port | "*": "any" | {mode: threshold}}, then: {port: "as it is" | {mode: op}},
//    activation?: always | sometimes | never}
// with op one of "const k", "keep", "+k", "max". Its kind is read off its shape, as epa/model/load.py does.

export const KINDS = {
  failure: { title: 'Failure row', text: 'A condition on what arrives, and a failure the component sends on because of it.' },
  internal: { title: 'Internal fault', text: 'The component starts a failure on its own: no message needs to arrive.' },
  forwarding: { title: 'Forwarding', text: 'A message goes on to other output ports as it is, nothing added (a fork or a join).' },
  sink: { title: 'Sink', text: 'The component may absorb a failure that arrives: nothing goes on when the row fires.' },
};

export const OPS = {
  const: { label: 'at a fixed magnitude', needsK: true, needsMatch: false },
  keep: { label: 'at the matched magnitude', needsK: false, needsMatch: true },
  plus: { label: 'at the matched magnitude + k', needsK: true, needsMatch: true },
  max: { label: 'at the largest matched magnitude', needsK: false, needsMatch: true },
};

export const ACTIVATIONS = ['open', 'always', 'sometimes', 'never'];

const ASIS = ['as it is', 'as-is', 'asis'];
export const ID_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function isAsIs(em) {
  return em === null || em === undefined || (typeof em === 'string' && ASIS.includes(em.trim()))
    || (typeof em === 'object' && !Array.isArray(em) && !Object.keys(em).length);
}

/** "const 9" | 9 | "keep" | "+2" | "max" -> {op, k} (as _parse_op in epa/model/load.py) */
export function parseOp(op) {
  if (typeof op === 'number') return { op: 'const', k: clamp(op, 0, 10) };
  const s = String(op).trim();
  if (s === 'keep') return { op: 'keep', k: 0 };
  if (s === 'max') return { op: 'max', k: 0 };
  if (s.startsWith('+')) return { op: 'plus', k: Number(s.slice(1)) || 0 };
  if (s.startsWith('const')) return { op: 'const', k: clamp(Number(s.split(/\s+/)[1]) || 0, 0, 10) };
  if (/^\d+$/.test(s)) return { op: 'const', k: clamp(Number(s), 0, 10) };
  return { op: s, k: 0 };
}

export function formatOp({ op, k }) {
  if (op === 'const') return `const ${k}`;
  if (op === 'plus') return `+${k}`;
  return op;
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/** The kind of a row, read off its shape (epa/model/load.py: sink, fwd, row; a row with no `when` is an internal fault). */
export function rowKind(row) {
  const when = row.when || {};
  const then = row.then || {};
  const failureIn = Object.values(when).some((p) => p && typeof p === 'object');
  if (!Object.keys(then).length) return 'sink';
  if (!Object.keys(when).length) return 'internal';
  if (!failureIn && Object.values(then).every(isAsIs)) return 'forwarding';
  return 'failure';
}

// ---------------------------------------------------------------- draft <-> document row

/** The editable form of a row: lists instead of keyed maps, so the dialog can hold half-made entries. */
export function toDraft(row) {
  const r = row || {};
  const when = Object.entries(r.when || {}).map(([port, pat]) => {
    if (pat && typeof pat === 'object') {
      const [mode, threshold] = Object.entries(pat)[0] || ['', 1];
      return { port, any: false, mode, threshold: Number(threshold) || 1 };
    }
    return { port, any: true, mode: '', threshold: 1 };
  });
  const then = [];
  for (const [port, em] of Object.entries(r.then || {})) {
    if (isAsIs(em)) { then.push({ port, asis: true, mode: '', op: 'const', k: 5 }); continue; }
    for (const [mode, op] of Object.entries(em)) then.push({ port, asis: false, mode, ...parseOp(op) });
  }
  const kind = row ? rowKind(r) : 'failure';
  return {
    id: r.id || '', label: r.label || '', activation: r.activation || defaultActivation(kind),
    kind, when, then,
  };
}

/** A forwarding row is always forwarded unless it says otherwise; every other row starts open. */
export function defaultActivation(kind) { return kind === 'forwarding' ? 'always' : 'open'; }

/** The document row the draft stands for. Fields of the original that the dialog does not edit are kept. */
export function fromDraft(draft, original) {
  const when = {};
  if (draft.kind !== 'internal') {
    for (const c of draft.when) when[c.port] = c.any ? 'any' : { [c.mode]: Number(c.threshold) };
  }
  const then = {};
  if (draft.kind !== 'sink') {
    for (const e of draft.then) {
      if (e.asis) { then[e.port] = 'as it is'; continue; }
      if (!then[e.port] || typeof then[e.port] !== 'object') then[e.port] = {};
      then[e.port][e.mode] = formatOp(e);
    }
  }
  // the order the analyst reads: id, label, when, then, activation, then anything the dialog does not edit
  const row = { id: draft.id.trim() };
  if (draft.label && draft.label.trim()) row.label = draft.label.trim();
  row.when = when;
  row.then = then;
  const act = draft.activation || 'open';
  if (act !== defaultActivation(draft.kind)) row.activation = act;
  for (const [k, v] of Object.entries(original || {})) {
    if (!['id', 'label', 'when', 'then', 'activation'].includes(k)) row[k] = v;
  }
  return row;
}

/** Reshape a draft for another kind, keeping what still fits. */
export function setKind(draft, kind, comp, fields) {
  const d = { ...draft, kind, when: draft.when.map((x) => ({ ...x })), then: draft.then.map((x) => ({ ...x })) };
  // a forwarding row's activation defaults to always; leaving that kind takes the default with it
  if (draft.kind === 'forwarding' && kind !== 'forwarding' && d.activation === 'always') d.activation = 'open';
  const inPort = comp.in[0] || '*';
  const outPort = comp.out[0] || '';
  if (kind === 'internal') {
    d.when = [];
    d.then = d.then.filter((e) => !e.asis).map((e) => ({ ...e, op: 'const', k: e.op === 'const' ? e.k : 5 }));
    if (!d.then.length && outPort) d.then = [{ port: outPort, asis: false, mode: fields[0], op: 'const', k: 5 }];
  } else {
    if (!d.when.length) d.when = [{ port: inPort, any: true, mode: '', threshold: 1 }];
    if (kind === 'forwarding') {
      d.when = d.when.map((c) => ({ ...c, any: true }));
      const ports = [...new Set(d.then.map((e) => e.port))];
      d.then = (ports.length ? ports : [outPort]).filter(Boolean).map((port) => ({ port, asis: true, mode: '', op: 'const', k: 5 }));
      if (d.activation === 'open') d.activation = 'always';
    } else if (kind === 'sink') {
      d.then = [];
      if (!d.when.some((c) => !c.any)) {
        const c0 = d.when.find((c) => c.port !== '*') || { port: comp.in[0] || '' };
        d.when = [{ port: c0.port, any: false, mode: fields[0], threshold: 1 }];
      }
    } else if (kind === 'failure') {
      if (!d.then.length && outPort) d.then = [{ port: outPort, asis: false, mode: fields[0], op: 'const', k: 5 }];
    }
  }
  return d;
}

// ---------------------------------------------------------------- checks

/**
 * What stands in the way of saving the draft, in the words of the model's rules, by wizard step:
 * {kind, trigger, effect, name}. draftProblems() gives them as one list.
 * ctx: {comp: {id, kind, in, out}, fields: [mode names], takenIds: Set of other row ids}
 */
export function draftProblemsByStep(draft, ctx) {
  const P = { kind: [], trigger: [], effect: [], name: [] };
  const { comp, fields } = ctx;
  const llm = comp.kind === 'llm';
  const k = draft.kind;
  if (!KINDS[k]) P.kind.push('Choose what kind of row this is.');
  if (k === 'sink' && llm) P.kind.push('An LLM component passes nothing through, so a sink row has nothing to absorb.');
  if (k !== 'internal' && !comp.in.length) P.kind.push(`${comp.id} has no input port yet: only an internal fault can fire without a message.`);
  if (k !== 'sink' && !comp.out.length) P.kind.push(`${comp.id} has no output port yet: wire it to something first, or make this a sink.`);

  if (k !== 'internal') {
    const T = P.trigger;
    if (!draft.when.length) T.push('Add at least one condition: what has to arrive for the row to fire.');
    const ports = draft.when.map((c) => c.port);
    if (ports.includes('*') && ports.length > 1) T.push('"Any input" stands alone: name the ports instead.');
    if (new Set(ports).size !== ports.length) T.push('Each input port can appear in only one condition.');
    for (const c of draft.when) {
      if (c.port !== '*' && !comp.in.includes(c.port)) T.push(`${comp.id} has no input port ${c.port || '(none chosen)'}.`);
      if (!c.any) {
        if (c.port === '*') T.push('"Any input" matches any message only; name the port to match a failure.');
        if (!fields.includes(c.mode)) T.push(`Choose the failure mode the condition on ${c.port} matches.`);
        if (!(c.threshold >= 1 && c.threshold <= 10)) T.push('A threshold is a magnitude from 1 to 10.');
      }
    }
    if (k === 'sink' && !draft.when.some((c) => !c.any)) T.push('A sink names the failure it absorbs: make one condition "a failure of at least".');
    if (k === 'forwarding' && draft.when.some((c) => !c.any)) T.push('A forwarding row matches any message; a failure condition makes it a failure row.');
  }

  if (k !== 'sink') {
    const E = P.effect;
    if (!draft.then.length) E.push(k === 'forwarding' ? 'Choose the output ports the message goes on to.' : 'Add at least one emission: what the component sends on.');
    const matched = draft.when.some((c) => !c.any) && k !== 'internal';
    const seen = new Set();
    for (const e of draft.then) {
      if (!comp.out.includes(e.port)) E.push(`${comp.id} has no output port ${e.port || '(none chosen)'}.`);
      if (e.asis) {
        if (k === 'internal') E.push('An internal fault has no incoming message to send on as it is: emit a failure.');
        if (draft.then.some((x) => x !== e && x.port === e.port)) E.push(`On ${e.port} the message is either sent as it is or with failures added, not both.`);
        continue;
      }
      if (k === 'forwarding') { E.push('A forwarding row adds no failure: send the message as it is.'); continue; }
      if (!fields.includes(e.mode)) E.push(`Choose the failure mode sent on ${e.port}.`);
      const key = `${e.port}|${e.mode}`;
      if (seen.has(key)) E.push(`${e.mode} on ${e.port} is emitted twice.`);
      seen.add(key);
      const op = OPS[e.op];
      if (!op) E.push(`Unknown operator ${e.op}.`);
      else {
        if (op.needsMatch && !matched) E.push(`"${op.label}" needs a failure in the condition: without one there is no matched magnitude.`);
        if (k === 'internal' && e.op !== 'const') E.push('An internal fault emits a fixed magnitude.');
        if (e.op === 'const' && !(e.k >= 0 && e.k <= 10)) E.push('A magnitude is from 0 to 10.');
        if (e.op === 'plus' && !(e.k >= 1 && e.k <= 10)) E.push('+k adds 1 to 10.');
      }
    }
  }

  const N = P.name;
  const id = (draft.id || '').trim();
  if (!id) N.push('Give the row an id.');
  else if (!ID_RE.test(id)) N.push('The id must start with a letter or _ and use only letters, digits, _ and dots.');
  else if (ctx.takenIds && ctx.takenIds.has(id)) N.push(`Another row is already called ${id}.`);
  const emitsFailure = k !== 'sink' && draft.then.some((e) => !e.asis);
  if (llm && emitsFailure && draft.activation === 'never') N.push('An LLM row that emits a failure is never "never" (the LLM rule): leave it open, or fix it to sometimes or always.');
  if (!ACTIVATIONS.includes(draft.activation)) N.push('Choose an activation.');
  for (const key of Object.keys(P)) P[key] = [...new Set(P[key])];
  return P;
}

export function draftProblems(draft, ctx) {
  const P = draftProblemsByStep(draft, ctx);
  return [...P.kind, ...P.trigger, ...P.effect, ...P.name];
}

/** The activations the dialog offers, with the ones the LLM rule forbids marked. */
export function activationChoices(draft, comp) {
  const llm = comp.kind === 'llm';
  const emitsFailure = draft.kind !== 'sink' && draft.then.some((e) => !e.asis);
  return ACTIVATIONS.map((a) => ({
    value: a,
    disabled: a === 'never' && llm && emitsFailure,
    text: activationText(a, llm && emitsFailure, draft.kind),
  }));
}

export function activationText(act, llmRow, kind) {
  if (act === 'open' || !act) {
    if (kind === 'forwarding') return 'open: the evidence decides whether the message is forwarded';
    return llmRow ? 'open: sometimes or always, the evidence decides (an LLM row is never "never")'
      : 'open: never, sometimes or always, the evidence decides';
  }
  return { always: 'always: fires whenever its condition holds', sometimes: 'sometimes: may or may not fire', never: 'never: switched off in the model' }[act] || act;
}

// ---------------------------------------------------------------- sentences

function condText(port, pat) {
  const where = port === '*' ? 'any input' : port;
  if (pat && typeof pat === 'object') {
    const [m, th] = Object.entries(pat)[0] || ['?', 1];
    return `${m} ≥ ${th} on ${where}`;
  }
  return `a message on ${where}`;
}

function emitText(mode, op) {
  const { op: o, k } = parseOp(op);
  if (o === 'const') return `${mode} at ${k}`;
  if (o === 'keep') return `${mode} at the matched magnitude`;
  if (o === 'max') return `${mode} at the largest matched magnitude`;
  if (o === 'plus') return `${mode} at the matched magnitude + ${k}`;
  return `${mode} ${op}`;
}

function list(xs) { return xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`; }

/** What a row does, in one sentence, for the table, the outline and the dialog's preview. */
export function rowSentence(row, comp) {
  const kind = rowKind(row);
  const name = comp ? comp.id : 'the component';
  const when = list(Object.entries(row.when || {}).map(([p, pat]) => condText(p, pat)));
  const sends = [];
  for (const [q, em] of Object.entries(row.then || {})) {
    if (isAsIs(em)) sends.push(`the message as it is on ${q}`);
    else sends.push(`${list(Object.entries(em).map(([m, op]) => emitText(m, op)))} on ${q}`);
  }
  if (kind === 'internal') return `On its own, with no message arriving, ${name} sends ${list(sends)}.`;
  if (kind === 'sink') return `When ${when} arrives, ${name} absorbs it: nothing goes on.`;
  if (kind === 'forwarding') return `When ${when} arrives, ${name} forwards it as it is to ${list(Object.keys(row.then || {}))}.`;
  return `When ${when} arrives, ${name} sends ${list(sends)}.`;
}

/** A compact YAML rendering of one row, for the dialog's preview (flow style, as in docs/model-format.md). */
export function rowYaml(row) {
  const flow = (v) => {
    if (v === null || v === undefined) return '{}';
    if (typeof v === 'string') return /^[A-Za-z_][\w.]*$/.test(v) ? v : JSON.stringify(v);
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) return `[${v.map(flow).join(', ')}]`;
    return `{${Object.entries(v).map(([k, x]) => `${/^[A-Za-z_][\w.]*$/.test(k) ? k : JSON.stringify(k)}: ${flow(x)}`).join(', ')}}`;
  };
  const lines = [`- id: ${flow(row.id)}`];
  if (row.label) lines.push(`  label: ${JSON.stringify(row.label)}`);
  lines.push(`  when: ${flow(row.when || {})}`);
  lines.push(`  then: ${flow(row.then || {})}`);
  if (row.activation) lines.push(`  activation: ${row.activation}`);
  for (const [k, v] of Object.entries(row)) if (!['id', 'label', 'when', 'then', 'activation'].includes(k)) lines.push(`  ${k}: ${flow(v)}`);
  return lines.join('\n');
}

/** A fresh row id for a component: c_r1, c_r2, ... unused anywhere in the model. */
export function freshRowId(compId, taken, base) {
  let stem = (base || `${compId}_r`).replace(/[^A-Za-z0-9_.]/g, '_');
  if (!/^[A-Za-z_]/.test(stem)) stem = `r_${stem}`;
  if (base && !taken.has(stem)) return stem;
  let i = 1;
  while (taken.has(`${stem}${i}`)) i++;
  return `${stem}${i}`;
}

/** Every row id of the model (analyst rows only; generated rows have dotted ids of their own). */
export function allRowIds(doc) {
  return new Set((doc.components || []).flatMap((c) => (c.rows || []).map((r) => r.id)));
}

// ---------------------------------------------------------------- worst-case defaults

/** Whether a component gets the worst-case defaults: every LLM does; with `worst_case_defaults: all`
 * (a new model's setting, FPTC style) every component does (epa/model/defaults.py, has_defaults). */
export function hasDefaults(doc, c) {
  return c.kind === 'llm' || (!!doc && doc.worst_case_defaults === 'all');
}

/**
 * The state of one worst-case default of a component (docs/model-format.md): on output port q,
 * mode m at 10 for any message. Only a row with the same trigger (any input or the only input,
 * any message) that emits m on q replaces it; other rows emitting on q go beside it.
 * -> {status: active | refined | dropped, refinedBy: [row ids], beside: [row ids], drop}
 */
export function defaultStatus(c, q, m) {
  const anyMsg = (r) => {
    const w = r.when || {};
    const ks = Object.keys(w);
    return ks.length === 1 && (ks[0] === '*' || (c.in.length === 1 && ks[0] === c.in[0])) && w[ks[0]] === 'any';
  };
  const emitsOn = (r) => r.then && r.then[q] && typeof r.then[q] === 'object';
  const refinedBy = (c.rows || []).filter((r) => emitsOn(r) && m in r.then[q] && anyMsg(r)).map((r) => r.id);
  const beside = (c.rows || []).filter((r) => emitsOn(r) && !anyMsg(r) && Object.keys(r.then[q]).length).map((r) => r.id);
  const drop = (c.drop_defaults || []).find((x) => x.port === q && x.mode === m) || null;
  return { status: refinedBy.length ? 'refined' : drop ? 'dropped' : 'active', refinedBy, beside, drop };
}
