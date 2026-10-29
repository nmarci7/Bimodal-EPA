// The reasoner state: the model document, the evidence, the last analysis, the selection.
import { api, store } from './lib.js';

const listeners = {};
export function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
export function emit(ev, data) { (listeners[ev] || []).forEach((fn) => fn(data)); }

export const DEFAULT_MODES = ['omission', 'commission', 'early', 'late', 'value'];

export const S = {
  doc: null,
  check: null,
  caseId: null,
  bundle: null,
  stage: null,
  evidence: emptyEvidence(),
  analysis: null,
  selection: null,
  view: 'model',
};

export function emptyEvidence() {
  return { files: [], witnesses: [], certificates: [], decisions: [], recognisers: {}, deployments: null, lookups: {} };
}

/** A new model: the FPTC failure classes (omission, commission, early, late, value coarse/subtle) and
 * worst-case defaults for every component, as epa/model/edit.py (blank, NEW_MODES) starts one. */
export function blankDoc() {
  return {
    name: 'new-system', description: '', worst_case_defaults: 'all',
    modes: ['omission', { commission: [] }, 'early', 'late', { value: ['coarse', 'subtle'] }],
    lattices: { confidentiality: ['public', 'internal', 'confidential'], authority: ['none', 'user', 'admin'] },
    components: [], guards: [], edges: [], use_cases: [], observation_points: [], claims: [],
    layout: { sys: {} },
  };
}

export function normaliseDoc(doc) {
  const d = doc || blankDoc();
  for (const k of ['components', 'guards', 'edges', 'use_cases', 'observation_points', 'claims']) d[k] = d[k] || [];
  d.modes = d.modes || DEFAULT_MODES.slice();
  d.lattices = d.lattices || {};
  d.lattices.confidentiality = d.lattices.confidentiality || ['public', 'internal', 'confidential'];
  d.lattices.authority = d.lattices.authority || ['none', 'user', 'admin'];
  d.layout = d.layout || {};
  d.layout.sys = d.layout.sys || {};
  for (const g of d.guards) { if (g.on && !g.edge) { g.edge = g.on; delete g.on; } }
  for (const c of d.components) {
    c.in = c.in || []; c.out = c.out || []; c.rows = c.rows || [];
    // older documents named what passes; now everything passes unless it is absorbed, with a reason
    if (c.pass !== undefined) {
      const tops = topModes(d);
      const kept = c.pass === 'all' ? tops : [].concat(c.pass || []);
      const gone = c.kind === 'llm' ? [] : tops.filter((m) => !kept.includes(m));
      if (gone.length) c.absorbs = (c.absorbs || []).concat(c.in.map((p) => ({ port: p, modes: gone, reason: '' })));
      delete c.pass;
    }
  }
  autoLayout(d);
  return d;
}

// ---------------------------------------------------------------- modes
export function modeFields(doc) {
  const out = [];
  for (const m of doc.modes || []) {
    if (typeof m === 'string') out.push({ name: m, parent: null });
    else if (m && typeof m === 'object') {
      if (m.name) { out.push({ name: m.name, parent: null }); (m.subkinds || []).forEach((s) => out.push({ name: s, parent: m.name })); }
      else for (const [k, subs] of Object.entries(m)) { out.push({ name: k, parent: null }); (subs || []).forEach((s) => out.push({ name: s, parent: k })); }
    }
  }
  return out;
}
export function topModes(doc) { return modeFields(doc).filter((m) => !m.parent).map((m) => m.name); }

// ---------------------------------------------------------------- references
export function parseRef(ref) { const i = (ref || '').indexOf('.'); return i < 0 ? [ref, ''] : [ref.slice(0, i), ref.slice(i + 1)]; }
export function nodeIdOfRef(ref) { const [o, p] = parseRef(ref); return o === 'sys' ? `sys:${p}` : o; }
export function sysPorts(doc) {
  const ins = new Set(), outs = new Set();
  for (const e of doc.edges) {
    const [fo, fp] = parseRef(e.from); const [to, tp] = parseRef(e.to);
    if (fo === 'sys') ins.add(fp);
    if (to === 'sys') outs.add(tp);
  }
  for (const [name, v] of Object.entries(doc.layout.sys || {})) { if (v.dir === 'in') ins.add(name); if (v.dir === 'out') outs.add(name); }
  return { ins: [...ins], outs: [...outs] };
}
export function comp(doc, id) { return doc.components.find((c) => c.id === id); }
export function edge(doc, id) { return doc.edges.find((e) => e.id === id); }
export function uniqueId(base, taken) {
  let id = base.replace(/[^A-Za-z0-9_]/g, '_'); if (!/^[A-Za-z_]/.test(id)) id = 'x_' + id;
  if (!taken.has(id)) return id;
  let i = 2; while (taken.has(`${id}${i}`)) i++; return `${id}${i}`;
}
function allIds(doc) {
  return new Set([...doc.components.map((c) => c.id), ...doc.guards.map((g) => g.id), 'sys']);
}

// ---------------------------------------------------------------- edits
const KIND_LABEL = { llm: 'LLM · discretionary', deterministic: 'deterministic', tool: 'tool', store: 'store', external: 'external', user: 'user' };
export function addComponent(kind, x, y) {
  const d = S.doc;
  const id = uniqueId(kind === 'llm' ? 'planner' : kind, allIds(d));
  const c = { id, kind, label: KIND_LABEL[kind] || kind, in: [], out: [], rows: [], pos: { x: Math.round(x), y: Math.round(y) } };
  // failures pass through a non-LLM component until the analyst declares otherwise (A6, pessimistic)
  d.components.push(c);
  changed({ type: 'component', id });
  return c;
}
export function addSysPort(dir, x, y) {
  const d = S.doc;
  const taken = new Set(Object.keys(d.layout.sys)); sysPorts(d).ins.concat(sysPorts(d).outs).forEach((n) => taken.add(n));
  const name = uniqueId(dir === 'in' ? 'input' : 'output', taken);
  d.layout.sys[name] = { x: Math.round(x), y: Math.round(y), dir };
  changed({ type: 'sys', id: `sys:${name}` });
}
function uniquePort(list, base) { const t = new Set(list); return uniqueId(base, t); }

/** Connect two ends. An end is {node, port?}: a component (with an existing port, or none for a
 *  new one) or a system port node 'sys:<name>'. Returns {ok, id} or {ok: false, why}. */
export function connectPorts(from, to) {
  const d = S.doc;
  if (!from || !to || !from.node || !to.node) return { ok: false, why: 'Drop onto a component, a port or a system output.' };
  if (from.node === to.node) return { ok: false, why: 'A component cannot be wired to itself here; add a store or a loop component.' };
  const fsys = from.node.startsWith('sys:'), tsys = to.node.startsWith('sys:');
  if (fsys && tsys) return { ok: false, why: 'Two system ports cannot be wired directly.' };
  let fromRef, toRef;
  if (fsys) {
    const name = from.node.slice(4);
    if ((d.layout.sys[name] || {}).dir === 'out' || sysPorts(d).outs.includes(name)) return { ok: false, why: 'A system output only receives.' };
    fromRef = `sys.${name}`;
  } else {
    const a = comp(d, from.node);
    let q = from.port;
    if (!q) {
      q = uniquePort(a.out, tsys ? to.node.slice(4) : `to_${to.node}`);
      a.out.push(q);
      if (a.flow) for (const p of a.in) { a.flow[p] = a.flow[p] || []; a.flow[p].push(q); }
    }
    fromRef = `${a.id}.${q}`;
  }
  if (tsys) {
    const name = to.node.slice(4);
    if ((d.layout.sys[name] || {}).dir === 'in' || sysPorts(d).ins.includes(name)) return { ok: false, why: 'A system input only sends.' };
    toRef = `sys.${name}`;
  } else {
    const b = comp(d, to.node);
    let p = to.port;
    if (!p) {
      p = uniquePort(b.in, fsys ? from.node.slice(4) : `from_${from.node}`);
      b.in.push(p);
      if (b.flow) b.flow[p] = b.out.slice();
    }
    toRef = `${b.id}.${p}`;
  }
  if (d.edges.some((e) => e.from === fromRef && e.to === toRef)) return { ok: false, why: 'These two ports are already wired.' };
  const taken = new Set(d.edges.map((e) => e.id));
  const id = uniqueId(`e_${from.node.replace('sys:', '')}_${to.node.replace('sys:', '')}`, taken);
  d.edges.push({ id, from: fromRef, to: toRef, label: '' });
  // the first wire out of a system input gives the model its first use case
  if (fsys && !d.use_cases.length) d.use_cases.push({ id: 'uc1', label: '', entries: [{ port: from.node.slice(4), token: {} }] });
  changed({ type: 'edge', id });
  return { ok: true, id };
}
export function connect(fromNode, toNode) { const r = connectPorts({ node: fromNode }, { node: toNode }); return r.ok ? r.id : null; }

export function addPort(cid, side) {
  const name = ops.addPort(S.doc, cid, side);
  changed({ type: 'port', id: `${cid}|${side}|${name}` });
  return name;
}
export function portEdges(d, cid, side, name) { const ref = `${cid}.${name}`; return d.edges.filter((e) => (side === 'in' ? e.to : e.from) === ref); }
export function removePort(cid, side, name) {
  ops.removePort(S.doc, cid, side, name);
  changed({ type: 'component', id: cid });
}
/** Re-attach one end of an edge to another port of the same component. */
export function moveEdgeEnd(eid, end, port) {
  ops.moveEdgeEnd(S.doc, eid, end, port);
  changed({ type: 'edge', id: eid });
}

// ---------------------------------------------------------------- summaries for the canvas
const fmtLevel = (x) => x;
export function targetText(t) {
  if ('mode' in t) return `${t.mode} ≥ ${t.threshold || 1}`;
  if ('taint' in t) return 'taint';
  if ('conf' in t) return `conf > ${fmtLevel(t.conf)}`;
  if ('auth' in t) return `auth < ${fmtLevel(t.auth)}`;
  return '?';
}
export function guardSummary(d, g) {
  const ts = g.targets || [];
  if (!ts.length) return { empty: true, text: 'checks nothing yet', long: 'no target: add what it checks for' };
  const parts = ts.map(targetText);
  const text = parts.length > 2 ? `${parts.slice(0, 2).join(', ')} +${parts.length - 2}` : parts.join(', ');
  return { empty: false, text, long: `catches ${parts.join(', ')}${g.learned ? ' (learned: none can be certified never)' : ''}` };
}
export function obsSummary(d, o) {
  const parts = Object.entries(o.tolerate || {}).map(([m, v]) => `${m}≥${v}`);
  if (o.taint === 'reject') parts.push('taint');
  if (o.clearance) parts.push(o.clearance === 'receiver' ? 'conf>clearance' : `conf>${o.clearance}`);
  if (o.requires) parts.push(o.requires === 'receiver' ? 'auth<required' : `auth<${o.requires}`);
  if (!parts.length) return { empty: true, text: 'judges nothing', long: 'nothing: tick the failures it judges' };
  const text = parts.length > 2 ? `${parts.slice(0, 2).join(' · ')} +${parts.length - 2}` : parts.join(' · ');
  return { empty: false, text, long: parts.join(', ') };
}
export function useCasesAt(d, port) { return (d.use_cases || []).filter((u) => (u.entries || [{ port: (u.entry || '').replace('sys.', '') }]).some((en) => en.port === port)); }

export function addGuard(edgeId) {
  const d = S.doc;
  const id = uniqueId('g', allIds(d));
  d.guards.push({ id, label: '', edge: edgeId, targets: [] });
  changed({ type: 'guard', id });
  return id;
}
export function addObs(edgeId) {
  const d = S.doc;
  const there = d.observation_points.find((o) => o.edge === edgeId);
  if (there) return there.id;
  const e = edge(d, edgeId);
  const recv = e ? nodeIdOfRef(e.to).replace('sys:', '') : edgeId.replace(/^e_/, '');
  const id = uniqueId(`o_${recv}`, new Set(d.observation_points.map((o) => o.id)));
  // a toleration is total in the definition: every mode starts judged, accepting nothing
  const tolerate = Object.fromEntries(topModes(d).map((m) => [m, 1]));
  d.observation_points.push({ id, edge: edgeId, label: id, tolerate });
  changed({ type: 'obs', id });
  return id;
}
export function removeSelection() {
  const d = S.doc, sel = S.selection;
  if (!sel) return;
  if (sel.type === 'component') {
    const id = sel.id;
    const gone = d.edges.filter((e) => nodeIdOfRef(e.from) === id || nodeIdOfRef(e.to) === id).map((e) => e.id);
    d.components = d.components.filter((c) => c.id !== id);
    dropEdges(gone);
  } else if (sel.type === 'sys') {
    const name = sel.id.slice(4);
    const gone = d.edges.filter((e) => e.from === `sys.${name}` || e.to === `sys.${name}`).map((e) => e.id);
    delete d.layout.sys[name];
    dropEdges(gone);
  } else if (sel.type === 'edge') dropEdges([sel.id]);
  else if (sel.type === 'guard') d.guards = d.guards.filter((g) => g.id !== sel.id);
  else if (sel.type === 'obs') d.observation_points = d.observation_points.filter((o) => o.id !== sel.id);
  S.selection = null;
  changed(null);
}
function dropEdges(ids) { ops.dropEdges(S.doc, ids); }
export function renameComponent(oldId, newId) {
  if (!ops.renameComponent(S.doc, oldId, newId)) return false;
  S.selection = { type: 'component', id: newId };
  changed(S.selection);
  return true;
}
export function renamePort(cid, side, oldP, newP) {
  if (!ops.renamePort(S.doc, cid, side, oldP, newP)) return false;
  changed(S.selection);
  return true;
}

// ---------------------------------------------------------------- edits on a given document
// The canvas edits S.doc directly. A dialog edits a copy (cloneDoc), checks it with the server, and
// commits it in one go (saveChecked), so Cancel leaves the model as it was.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ops = {
  addPort(d, cid, side) {
    const c = comp(d, cid);
    const name = uniquePort(c[side], side === 'in' ? 'in' : 'out');
    c[side].push(name);
    if (c.flow) { if (side === 'in') c.flow[name] = c.out.slice(); else for (const p of c.in) (c.flow[p] = c.flow[p] || []).push(name); }
    return name;
  },
  removePort(d, cid, side, name) {
    const c = comp(d, cid);
    ops.dropEdges(d, portEdges(d, cid, side, name).map((e) => e.id));
    c[side] = c[side].filter((p) => p !== name);
    if (c.flow) { if (side === 'in') delete c.flow[name]; else for (const k of Object.keys(c.flow)) c.flow[k] = c.flow[k].filter((q) => q !== name); }
    c.rows = (c.rows || []).filter((r) => !(side === 'in' ? (r.when || {})[name] : (r.then || {})[name]));
    if (side === 'out') c.drop_defaults = (c.drop_defaults || []).filter((x) => x.port !== name);
    if (side === 'in') c.absorbs = (c.absorbs || []).filter((a) => a.port !== name);
  },
  moveEdgeEnd(d, eid, end, port) {
    const e = edge(d, eid);
    const [o] = parseRef(e[end]);
    e[end] = `${o}.${port}`;
  },
  dropEdges(d, ids) {
    // ports belong to their component (Definition: Component), so removing an edge leaves them in
    // place, unconnected, until the analyst deletes them or wires them again
    const set = new Set(ids);
    d.edges = d.edges.filter((e) => !set.has(e.id));
    d.guards = d.guards.filter((g) => !set.has(g.edge));
    d.observation_points = d.observation_points.filter((o) => !set.has(o.edge));
  },
  renameComponent(d, oldId, newId) {
    if (!newId || oldId === newId) return oldId === newId;
    if (!IDENT.test(newId) || allIds(d).has(newId)) return false;
    const c = comp(d, oldId); c.id = newId;
    for (const e of d.edges) {
      if (parseRef(e.from)[0] === oldId) e.from = `${newId}.${parseRef(e.from)[1]}`;
      if (parseRef(e.to)[0] === oldId) e.to = `${newId}.${parseRef(e.to)[1]}`;
    }
    return true;
  },
  renamePort(d, cid, side, oldP, newP) {
    const c = comp(d, cid);
    if (oldP === newP) return true;
    if (!IDENT.test(newP) || c[side].includes(newP)) return false;
    c[side] = c[side].map((p) => (p === oldP ? newP : p));
    for (const e of d.edges) {
      const key = side === 'out' ? 'from' : 'to';
      if (e[key] === `${cid}.${oldP}`) e[key] = `${cid}.${newP}`;
    }
    if (c.flow) {
      if (side === 'in' && c.flow[oldP]) { c.flow[newP] = c.flow[oldP]; delete c.flow[oldP]; }
      if (side === 'out') for (const k of Object.keys(c.flow)) c.flow[k] = c.flow[k].map((q) => (q === oldP ? newP : q));
    }
    for (const r of c.rows || []) {
      const part = side === 'in' ? r.when : r.then;
      if (part && part[oldP] !== undefined) { part[newP] = part[oldP]; delete part[oldP]; }
    }
    for (const a of c.absorbs || []) if (side === 'in' && a.port === oldP) a.port = newP;
    for (const x of c.drop_defaults || []) if (side === 'out' && x.port === oldP) x.port = newP;
    return true;
  },
  renameGuard(d, oldId, newId) {
    if (oldId === newId) return true;
    if (!IDENT.test(newId) || allIds(d).has(newId)) return false;
    d.guards.find((g) => g.id === oldId).id = newId;
    return true;
  },
  renameObs(d, oldId, newId) {
    if (oldId === newId) return true;
    if (!IDENT.test(newId) || d.observation_points.some((o) => o.id === newId)) return false;
    d.observation_points.find((o) => o.id === oldId).id = newId;
    for (const cl of d.claims || []) {
      const [f, o] = String(cl.cell || '').split('@');
      if (o === oldId) cl.cell = `${f}@${newId}`;
    }
    return true;
  },
  renameSysPort(d, oldName, newName) {
    if (oldName === newName) return true;
    if (!IDENT.test(newName) || d.layout.sys[newName] || sysPorts(d).ins.includes(newName) || sysPorts(d).outs.includes(newName)) return false;
    for (const e of d.edges) { if (e.from === `sys.${oldName}`) e.from = `sys.${newName}`; if (e.to === `sys.${oldName}`) e.to = `sys.${newName}`; }
    for (const u of d.use_cases) for (const en of u.entries || []) if (en.port === oldName) en.port = newName;
    d.layout.sys[newName] = d.layout.sys[oldName] || {}; delete d.layout.sys[oldName];
    return true;
  },
};

export function cloneDoc(d = S.doc) { return JSON.parse(JSON.stringify(d)); }

/** Replace the model with an edited copy and tell every view. */
export function commitDoc(doc, selection) {
  S.doc = doc;
  changed(selection === undefined ? S.selection : selection);
}

export async function checkDoc(doc) {
  try { return await api('/api/model/check', { doc }); }
  catch (e) { return { ok: false, problems: e.problems || [e.message] }; }
}

/** The problems the edited copy has that the model as it stands does not. */
export async function newProblems(doc) {
  const before = S.check ? S.check : await checkDoc(S.doc);
  const after = await checkDoc(doc);
  const old = new Set((before && before.problems) || []);
  return (after.problems || []).filter((p) => !old.has(p));
}

/** The save step of every editing dialog: commit, unless the check finds something new (then ask). */
export async function saveChecked(doc, selection, force) {
  if (!force) {
    const fresh = await newProblems(doc);
    if (fresh.length) return { problems: fresh, canForce: true };
  }
  commitDoc(doc, selection);
  return true;
}

let checkTimer = null;
export function changed(sel) {
  if (sel !== undefined) S.selection = sel;
  persist();
  emit('doc');
  if (sel !== undefined) emit('select');
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, 350);
}
export async function runCheck() {
  try { S.check = await api('/api/model/check', { doc: S.doc }); }
  catch (e) { S.check = { ok: false, problems: e.problems || [e.message] }; }
  emit('check');
}
/** What an analysis ran on: the model (without canvas positions) and the evidence it reads. A run
 * records it; when it differs from the current one, the verdicts are out of date (flow.js). */
export function analysisBasis() {
  return JSON.stringify([S.doc, S.evidence.certificates, S.evidence.witnesses, S.evidence.decisions],
    (k, v) => (k === 'pos' || k === 'layout' ? undefined : v));
}
export function persist() {
  store('epa.doc', S.doc);
  store('epa.evidence', S.evidence);
  store('epa.case', { caseId: S.caseId, stage: S.stage });
}
export function restore() {
  const d = store('epa.doc');
  if (d) S.doc = normaliseDoc(d);
  const ev = store('epa.evidence');
  if (ev) S.evidence = Object.assign(emptyEvidence(), ev);
  const c = store('epa.case');
  if (c) { S.caseId = c.caseId; S.stage = c.stage; }
}

// ---------------------------------------------------------------- layout
export function autoLayout(d) {
  const nodes = [...d.components.map((c) => c.id)];
  const sp = sysPorts(d);
  sp.ins.forEach((n) => nodes.push(`sys:${n}`)); sp.outs.forEach((n) => nodes.push(`sys:${n}`));
  const missing = nodes.filter((n) => (n.startsWith('sys:') ? !d.layout.sys[n.slice(4)] || d.layout.sys[n.slice(4)].x === undefined : !comp(d, n).pos));
  if (!missing.length) return;
  if (d.components.length && d.components.every((c) => c.pos)) {
    // only system ports lack a place: put each beside the component it is wired to
    const used = {};
    for (const n of missing) {
      const name = n.slice(4), isIn = sp.ins.includes(name);
      const e = d.edges.find((x) => (isIn ? x.from === `sys.${name}` : x.to === `sys.${name}`));
      const nb = e && comp(d, parseRef(isIn ? e.to : e.from)[0]);
      const k = nb ? `${nb.id}|${isIn}` : 'none';
      const i = (used[k] = (used[k] || 0) + 1) - 1;
      const x = nb ? nb.pos.x + (isIn ? -200 : 210) : 40;
      const y = nb ? nb.pos.y + 5 + i * 64 - (isIn ? 0 : 0) : 40 + i * 64;
      d.layout.sys[name] = { ...(d.layout.sys[name] || {}), dir: isIn ? 'in' : 'out', x, y };
    }
    return;
  }
  const succ = {}; nodes.forEach((n) => { succ[n] = new Set(); });
  for (const e of d.edges) { const a = nodeIdOfRef(e.from), b = nodeIdOfRef(e.to); if (succ[a] && succ[b]) succ[a].add(b); }
  const layer = {}; nodes.forEach((n) => { layer[n] = n.startsWith('sys:') && sp.ins.includes(n.slice(4)) ? 0 : null; });
  // longest path from inputs, ignoring back edges (bounded)
  for (let it = 0; it < nodes.length; it++) {
    for (const a of nodes) {
      if (layer[a] === null) continue;
      for (const b of succ[a]) if (layer[b] === null || (layer[b] < layer[a] + 1 && layer[a] + 1 <= nodes.length)) { if (layer[b] === null || layer[b] < layer[a] + 1) layer[b] = Math.min(layer[a] + 1, 8); }
    }
  }
  nodes.forEach((n) => { if (layer[n] === null) layer[n] = 1; });
  sp.outs.forEach((n) => { layer[`sys:${n}`] = Math.max(...Object.values(layer)) ; });
  const byLayer = {};
  nodes.forEach((n) => { (byLayer[layer[n]] = byLayer[layer[n]] || []).push(n); });
  for (const [L, ns] of Object.entries(byLayer)) {
    ns.forEach((n, i) => {
      const x = 40 + Number(L) * 230, y = 50 + i * 130;
      if (n.startsWith('sys:')) { const name = n.slice(4); d.layout.sys[name] = Object.assign({ dir: sp.ins.includes(name) ? 'in' : 'out' }, d.layout.sys[name] || {}, d.layout.sys[name] && d.layout.sys[name].x !== undefined ? {} : { x, y }); }
      else { const c = comp(d, n); if (!c.pos) c.pos = { x, y }; }
    });
  }
}
