// The workbench state: the model document, the evidence, the last analysis, the selection.
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

export function blankDoc() {
  return {
    name: 'new-system', description: '',
    modes: ['omission', { commission: [] }, 'late', 'value'],
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
  for (const c of d.components) { c.in = c.in || []; c.out = c.out || []; c.rows = c.rows || []; }
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
  // failures pass through a new non-LLM component until the analyst says otherwise (the pessimistic default)
  if (kind !== 'llm') c.pass = 'all';
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
export function connect(fromNode, toNode) {
  const d = S.doc;
  if (fromNode === toNode) return null;
  const taken = new Set(d.edges.map((e) => e.id));
  let from, to;
  const fsys = fromNode.startsWith('sys:'), tsys = toNode.startsWith('sys:');
  if (fsys && tsys) return null;
  if (fsys) {
    const name = fromNode.slice(4);
    if ((d.layout.sys[name] || {}).dir === 'out') return null;
    from = `sys.${name}`;
  } else {
    const a = comp(d, fromNode);
    const q = uniquePort(a.out, tsys ? toNode.slice(4) : `to_${toNode}`);
    a.out.push(q);
    if (a.flow) for (const p of a.in) { a.flow[p] = a.flow[p] || []; a.flow[p].push(q); }
    from = `${a.id}.${q}`;
  }
  if (tsys) {
    const name = toNode.slice(4);
    if ((d.layout.sys[name] || {}).dir === 'in') return null;
    to = `sys.${name}`;
  } else {
    const b = comp(d, toNode);
    const p = uniquePort(b.in, fsys ? fromNode.slice(4) : `from_${fromNode}`);
    b.in.push(p);
    if (b.flow) b.flow[p] = b.out.slice();
    to = `${b.id}.${p}`;
  }
  const id = uniqueId(`e_${fromNode.replace('sys:', '')}_${toNode.replace('sys:', '')}`, taken);
  d.edges.push({ id, from, to, label: '' });
  changed({ type: 'edge', id });
  return id;
}
export function addGuard(edgeId) {
  const d = S.doc;
  const id = uniqueId('g', allIds(d));
  d.guards.push({ id, label: 'guard', edge: edgeId, targets: [] });
  changed({ type: 'guard', id });
}
export function addObs(edgeId) {
  const d = S.doc;
  if (d.observation_points.find((o) => o.edge === edgeId)) return;
  const id = uniqueId(`o_${edgeId.replace(/^e_/, '')}`, new Set(d.observation_points.map((o) => o.id)));
  d.observation_points.push({ id, edge: edgeId, label: id, tolerate: {} });
  changed({ type: 'obs', id });
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
function dropEdges(ids) {
  const d = S.doc, set = new Set(ids);
  for (const e of d.edges.filter((x) => set.has(x.id))) {
    for (const [ref, side] of [[e.from, 'out'], [e.to, 'in']]) {
      const [o, p] = parseRef(ref);
      const c = o !== 'sys' && comp(d, o);
      if (c && d.edges.filter((x) => !set.has(x.id) && (side === 'out' ? x.from : x.to) === ref).length === 0) {
        c[side] = c[side].filter((q) => q !== p);
        if (c.flow) { if (side === 'in') delete c.flow[p]; else for (const k of Object.keys(c.flow)) c.flow[k] = c.flow[k].filter((q) => q !== p); }
        c.rows = (c.rows || []).filter((r) => !(side === 'in' ? (r.when || {})[p] : (r.then || {})[p]));
      }
    }
  }
  d.edges = d.edges.filter((e) => !set.has(e.id));
  d.guards = d.guards.filter((g) => !set.has(g.edge));
  d.observation_points = d.observation_points.filter((o) => !set.has(o.edge));
}
export function renameComponent(oldId, newId) {
  const d = S.doc;
  if (!newId || oldId === newId) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newId) || allIds(d).has(newId)) return false;
  const c = comp(d, oldId); c.id = newId;
  for (const e of d.edges) {
    if (parseRef(e.from)[0] === oldId) e.from = `${newId}.${parseRef(e.from)[1]}`;
    if (parseRef(e.to)[0] === oldId) e.to = `${newId}.${parseRef(e.to)[1]}`;
  }
  S.selection = { type: 'component', id: newId };
  changed(S.selection);
  return true;
}
export function renamePort(cid, side, oldP, newP) {
  const d = S.doc, c = comp(d, cid);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newP) || c[side].includes(newP)) return false;
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
  changed(S.selection);
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
