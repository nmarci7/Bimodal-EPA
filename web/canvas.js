// The modelling canvas: components, system ports, edges, guards on edges, observation points.
// SVG, with pan (drag the background), zoom (wheel), move (drag a node), connect (drag from the
// round handle on a node's right side to another node) and drop from the palette.
import { s, clear } from './lib.js';
import { S, on, comp, parseRef, nodeIdOfRef, sysPorts, connect, addComponent, addSysPort, addGuard, addObs, changed, removeSelection } from './state.js';

const W = 156, H = 58, SW = 132, SH = 48;
const VERDICT_RANK = { exposed: 6, conflict: 5, unchecked: 4, hope: 3, 'not exercised': 2, guarantee: 1 };
const VERDICT_COLOURS = {
  guarantee: ['#DDF1E7', '#11603F'], hope: ['#FBEBC8', '#7A4E00'], exposed: ['#FBE0DD', '#A2241A'],
  unchecked: ['#E3E9F8', '#2F4A8F'], conflict: ['#EDE3FA', '#5B2D91'], 'not exercised': ['#ECECEA', '#555555'],
};

export class Canvas {
  constructor(host) {
    this.host = host;
    this.t = { x: 20, y: 20, k: 1 };
    this.svg = s('svg', { tabindex: 0, role: 'application', 'aria-label': 'Model canvas' });
    this.svg.appendChild(s('defs', {},
      s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#6B6F78' })),
      s('marker', { id: 'arrow-llm', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#B7791F' })),
      s('marker', { id: 'arrow-sel', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#2B6CB0' }))));
    this.vp = s('g');
    this.gEdges = s('g'); this.gDeco = s('g'); this.gNodes = s('g'); this.gTemp = s('g');
    this.vp.append(this.gEdges, this.gNodes, this.gDeco, this.gTemp);
    this.svg.appendChild(this.vp);
    host.appendChild(this.svg);
    this.overlay = true;
    this.bind();
    on('doc', () => this.render());
    on('select', () => this.render());
    on('report', () => this.render());
  }

  // ---------------------------------------------------------------- geometry
  nodes() {
    const d = S.doc, out = [];
    for (const c of d.components) out.push({ id: c.id, kind: c.kind, label: c.label || '', x: c.pos.x, y: c.pos.y, w: W, h: H, c });
    const sp = sysPorts(d);
    for (const n of sp.ins) { const p = d.layout.sys[n] || { x: 0, y: 0 }; out.push({ id: `sys:${n}`, kind: 'sysin', label: 'system input', x: p.x, y: p.y, w: SW, h: SH }); }
    for (const n of sp.outs) { const p = d.layout.sys[n] || { x: 0, y: 0 }; out.push({ id: `sys:${n}`, kind: 'sysout', label: 'system output', x: p.x, y: p.y, w: SW, h: SH }); }
    return out;
  }
  toWorld(ev) {
    const r = this.svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left - this.t.x) / this.t.k, y: (ev.clientY - r.top - this.t.y) / this.t.k };
  }
  applyT() { this.vp.setAttribute('transform', `translate(${this.t.x},${this.t.y}) scale(${this.t.k})`); }

  fit() {
    const ns = this.nodes();
    if (!ns.length) { this.t = { x: 40, y: 40, k: 1 }; this.applyT(); return; }
    const x0 = Math.min(...ns.map((n) => n.x)) - 40, y0 = Math.min(...ns.map((n) => n.y)) - 40;
    const x1 = Math.max(...ns.map((n) => n.x + n.w)) + 60, y1 = Math.max(...ns.map((n) => n.y + n.h)) + 60;
    const r = this.svg.getBoundingClientRect();
    const k = Math.min(1.2, Math.max(0.3, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
    this.t = { k, x: (r.width - (x1 - x0) * k) / 2 - x0 * k, y: (r.height - (y1 - y0) * k) / 2 - y0 * k };
    this.applyT();
  }

  // ---------------------------------------------------------------- drawing
  render() {
    if (!S.doc) return;
    clear(this.gEdges); clear(this.gNodes); clear(this.gDeco);
    const d = S.doc, ns = this.nodes();
    const byId = Object.fromEntries(ns.map((n) => [n.id, n]));
    const sel = S.selection || {};
    const verdictAt = this.verdictsByObs();
    // pairs of nodes joined in both directions get their edges offset
    const pairCount = {};
    for (const e of d.edges) { const a = nodeIdOfRef(e.from), b = nodeIdOfRef(e.to); const k = [a, b].sort().join('|'); pairCount[k] = (pairCount[k] || 0) + 1; }
    const pairSeen = {};
    for (const e of d.edges) {
      const a = byId[nodeIdOfRef(e.from)], b = byId[nodeIdOfRef(e.to)];
      if (!a || !b) continue;
      const key = [a.id, b.id].sort().join('|');
      const idx = (pairSeen[key] = (pairSeen[key] || 0) + 1);
      const off = pairCount[key] > 1 ? (idx - (pairCount[key] + 1) / 2) * 22 * (a.id < b.id ? 1 : -1) : 0;
      const g = this.edgeShape(e, a, b, off, sel, verdictAt);
      this.gEdges.appendChild(g);
    }
    for (const n of ns) this.gNodes.appendChild(this.nodeShape(n, sel));
    this.applyT();
  }

  verdictsByObs() {
    const rep = S.analysis && S.analysis.report;
    if (!rep || !this.overlay) return {};
    const out = {};
    for (const c of rep.cells) {
      const cur = out[c.obs];
      if (!cur || (VERDICT_RANK[c.verdict] || 0) > (VERDICT_RANK[cur] || 0)) out[c.obs] = c.verdict;
    }
    return out;
  }

  nodeShape(n, sel) {
    const isSel = (sel.type === 'component' && sel.id === n.id) || (sel.type === 'sys' && sel.id === n.id);
    const g = s('g', { class: `node${isSel ? ' selected' : ''}`, transform: `translate(${n.x},${n.y})`, 'data-node': n.id });
    let fill = '#FFFFFF', stroke = '#A9A79F', dash = null, rx = 10, sw = 1.2;
    if (n.kind === 'llm') { fill = '#FBF3E4'; stroke = '#B7791F'; sw = 2; }
    if (n.kind === 'store') rx = 18;
    if (n.kind === 'external' || n.kind === 'user') { stroke = '#2B6CB0'; sw = 1.6; }
    if (n.kind === 'tool') { stroke = '#6B6F78'; }
    if (n.kind === 'sysin') { dash = '5 4'; stroke = '#8C8A84'; rx = n.h / 2; }
    if (n.kind === 'sysout') { dash = '5 4'; stroke = '#2B6CB0'; rx = n.h / 2; sw = 1.5; }
    g.appendChild(s('rect', { class: 'body', width: n.w, height: n.h, rx, fill, stroke, 'stroke-width': sw, 'stroke-dasharray': dash }));
    if (n.kind === 'store') g.appendChild(s('path', { d: `M 12 6 Q ${n.w / 2} 14 ${n.w - 12} 6`, fill: 'none', stroke: '#C9C7C0' }));
    const title = n.id.startsWith('sys:') ? n.id.slice(4) : n.id;
    g.appendChild(s('text', { x: n.w / 2, y: n.h / 2 - 3, 'text-anchor': 'middle' }, title));
    const sub = n.c ? (n.c.label || n.c.kind) : n.label;
    g.appendChild(s('text', { class: 'sub', x: n.w / 2, y: n.h / 2 + 13, 'text-anchor': 'middle' }, sub.length > 26 ? sub.slice(0, 25) + '…' : sub));
    if (n.kind !== 'sysout') g.appendChild(s('circle', { class: 'handle', cx: n.w, cy: n.h / 2, r: 7, 'data-handle': n.id }));
    return g;
  }

  edgeShape(e, a, b, off, sel, verdictAt) {
    const d = S.doc;
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const dx = cb.x - ca.x, dy = cb.y - ca.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const pa = clip(a, { x: cb.x + nx * off, y: cb.y + ny * off }, { x: ca.x + nx * off, y: ca.y + ny * off });
    const pb = clip(b, { x: ca.x + nx * off, y: ca.y + ny * off }, { x: cb.x + nx * off, y: cb.y + ny * off });
    const fromComp = comp(d, parseRef(e.from)[0]);
    const llm = fromComp && fromComp.kind === 'llm';
    const isSel = sel.type === 'edge' && sel.id === e.id;
    const g = s('g', { class: `edge${llm ? ' llm' : ''}${isSel ? ' selected' : ''}`, 'data-edge': e.id });
    const path = `M ${pa.x} ${pa.y} L ${pb.x} ${pb.y}`;
    g.appendChild(s('path', { class: 'hit', d: path, 'data-edge': e.id }));
    g.appendChild(s('path', { class: 'line', d: path, 'marker-end': `url(#${isSel ? 'arrow-sel' : llm ? 'arrow-llm' : 'arrow'})` }));
    const at = (f) => ({ x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f });
    const guards = d.guards.filter((gd) => gd.edge === e.id);
    const o0 = d.observation_points.find((op) => op.edge === e.id);
    const lab = e.label || '';
    if (lab) {
      const p = at(guards.length ? 0.22 : 0.5);
      const anchor = Math.abs(nx) > 0.6 ? (nx > 0 ? 'start' : 'end') : 'middle';
      g.appendChild(s('text', { x: p.x + nx * 10, y: p.y + ny * 12 + 4, 'text-anchor': anchor }, lab.length > 30 ? lab.slice(0, 29) + '…' : lab));
    }
    guards.forEach((gd, i) => {
      // several guards on one edge are stacked across it, as in the case figures
      const k = i - (guards.length - 1) / 2;
      const segLen = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
      const vertical = Math.abs(pb.y - pa.y) > Math.abs(pb.x - pa.x);
      // across a horizontal edge, along a vertical one (pills are wider than tall)
      const p = vertical ? at((o0 ? 0.5 : 0.55) + (k * 26) / segLen)
        : (() => { const c0 = at(o0 ? 0.5 : 0.55); return { x: c0.x + nx * 26 * k, y: c0.y + ny * 26 * k }; })();
      const label = gd.label || gd.id;
      const w = Math.max(44, label.length * 6.6 + 16);
      const gs = s('g', { class: `gpill${gd.learned ? ' learned' : ''}${sel.type === 'guard' && sel.id === gd.id ? ' selected' : ''}`, transform: `translate(${p.x - w / 2},${p.y - 11})`, 'data-guard': gd.id });
      gs.appendChild(s('rect', { width: w, height: 22, rx: 6 }));
      gs.appendChild(s('text', { x: w / 2, y: 15, 'text-anchor': 'middle' }, label));
      this.gDeco.appendChild(gs);
    });
    const o = d.observation_points.find((op) => op.edge === e.id);
    if (o) {
      const p = at(0.86);
      const v = verdictAt[o.id];
      const [bg, ink] = v ? VERDICT_COLOURS[v] : ['#FFFFFF', '#2B6CB0'];
      const eg = s('g', { class: 'eye', transform: `translate(${p.x},${p.y})`, 'data-obs': o.id });
      eg.appendChild(s('title', {}, `${o.label || o.id}${v ? ` — worst verdict: ${v}` : ''}`));
      eg.appendChild(s('ellipse', { rx: 13, ry: 9, fill: bg, stroke: ink, 'stroke-width': sel.type === 'obs' && sel.id === o.id ? 3 : 1.6 }));
      eg.appendChild(s('circle', { r: 3.4, fill: ink }));
      this.gDeco.appendChild(eg);
      const lp = at(0.86);
      const oa = Math.abs(nx) > 0.6 ? (nx > 0 ? 'start' : 'end') : 'middle';
      this.gDeco.appendChild(s('text', { x: lp.x + nx * 18, y: lp.y + ny * 20 + 4, 'text-anchor': oa, style: 'font-size: 11px; fill: #1E4E8C; font-family: var(--sans)' }, o.label || o.id));
    }
    return g;
  }

  // ---------------------------------------------------------------- interaction
  bind() {
    let drag = null;
    this.svg.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const tgt = ev.target;
      const handle = tgt.getAttribute && tgt.getAttribute('data-handle');
      const nodeEl = tgt.closest && tgt.closest('[data-node]');
      const w = this.toWorld(ev);
      if (handle) { drag = { mode: 'connect', from: handle, start: w }; this.host.classList.add('connecting'); ev.preventDefault(); return; }
      if (nodeEl) {
        const id = nodeEl.getAttribute('data-node');
        const n = this.nodes().find((x) => x.id === id);
        drag = { mode: 'move', id, dx: w.x - n.x, dy: w.y - n.y, moved: false };
        ev.preventDefault(); return;
      }
      const gEl = tgt.closest && tgt.closest('[data-guard]');
      if (gEl) { S.selection = { type: 'guard', id: gEl.getAttribute('data-guard') }; this.select(); return; }
      const oEl = tgt.closest && tgt.closest('[data-obs]');
      if (oEl) { S.selection = { type: 'obs', id: oEl.getAttribute('data-obs') }; this.select(); return; }
      const eEl = tgt.closest && tgt.closest('[data-edge]');
      if (eEl) { S.selection = { type: 'edge', id: eEl.getAttribute('data-edge') }; this.select(); return; }
      drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, tx: this.t.x, ty: this.t.y, moved: false };
    });
    window.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      if (drag.mode === 'pan') {
        this.t.x = drag.tx + ev.clientX - drag.sx; this.t.y = drag.ty + ev.clientY - drag.sy;
        if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 3) drag.moved = true;
        this.applyT();
      } else if (drag.mode === 'move') {
        const w = this.toWorld(ev);
        const x = Math.round((w.x - drag.dx) / 10) * 10, y = Math.round((w.y - drag.dy) / 10) * 10;
        if (drag.id.startsWith('sys:')) { const p = S.doc.layout.sys[drag.id.slice(4)]; if (p.x !== x || p.y !== y) { p.x = x; p.y = y; drag.moved = true; } }
        else { const c = comp(S.doc, drag.id); if (c.pos.x !== x || c.pos.y !== y) { c.pos = { x, y }; drag.moved = true; } }
        if (drag.moved) this.render();
      } else if (drag.mode === 'connect') {
        const w = this.toWorld(ev);
        const n = this.nodes().find((x) => x.id === drag.from);
        clear(this.gTemp).appendChild(s('line', { x1: n.x + n.w, y1: n.y + n.h / 2, x2: w.x, y2: w.y, stroke: '#2B6CB0', 'stroke-width': 2, 'stroke-dasharray': '4 4' }));
      }
    });
    window.addEventListener('mouseup', (ev) => {
      if (!drag) return;
      const d0 = drag; drag = null;
      if (d0.mode === 'connect') {
        clear(this.gTemp); this.host.classList.remove('connecting');
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const nodeEl = el && el.closest && el.closest('[data-node]');
        if (nodeEl) { const id = connect(d0.from, nodeEl.getAttribute('data-node')); if (!id) this.flash('These two cannot be connected that way.'); }
      } else if (d0.mode === 'move') {
        if (d0.moved) changed(S.selection && S.selection.id === d0.id ? S.selection : { type: d0.id.startsWith('sys:') ? 'sys' : 'component', id: d0.id });
        else { S.selection = { type: d0.id.startsWith('sys:') ? 'sys' : 'component', id: d0.id }; this.select(); }
      } else if (d0.mode === 'pan' && !d0.moved) { S.selection = null; this.select(); }
    });
    this.svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = this.svg.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const k = Math.min(2.5, Math.max(0.25, this.t.k * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)));
      this.t.x = mx - (mx - this.t.x) * (k / this.t.k); this.t.y = my - (my - this.t.y) * (k / this.t.k); this.t.k = k;
      this.applyT();
    }, { passive: false });
    this.svg.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && S.selection) { ev.preventDefault(); removeSelection(); }
    });
    this.host.addEventListener('dragover', (ev) => { ev.preventDefault(); });
    this.host.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const kind = ev.dataTransfer.getData('text/plain');
      if (!kind) return;
      const w = this.toWorld(ev);
      if (kind === 'sysin' || kind === 'sysout') addSysPort(kind === 'sysin' ? 'in' : 'out', w.x - SW / 2, w.y - SH / 2);
      else if (kind === 'guard' || kind === 'obs') {
        const eid = this.nearestEdge(w);
        if (!eid) { this.flash('Drop a guard or an observation point onto an edge.'); return; }
        if (kind === 'guard') addGuard(eid); else addObs(eid);
      } else addComponent(kind, w.x - W / 2, w.y - H / 2);
    });
  }

  select() { this.render(); import('./state.js').then((m) => m.emit('select')); this.svg.focus(); }

  nearestEdge(w) {
    const d = S.doc, ns = Object.fromEntries(this.nodes().map((n) => [n.id, n]));
    let best = null, bestD = 30;
    for (const e of d.edges) {
      const a = ns[nodeIdOfRef(e.from)], b = ns[nodeIdOfRef(e.to)];
      if (!a || !b) continue;
      const p = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, q = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const dist = segDist(w, p, q);
      if (dist < bestD) { bestD = dist; best = e.id; }
    }
    return best;
  }

  flash(msg) { import('./lib.js').then((m) => m.toast(msg)); }
}

function clip(n, from, to) {
  // the point where the segment from -> to (to inside n) crosses n's border
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  const dx = from.x - to.x, dy = from.y - to.y;
  const tx = dx === 0 ? Infinity : (n.w / 2 + 3) / Math.abs(dx);
  const ty = dy === 0 ? Infinity : (n.h / 2 + 3) / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: Math.round(cx + (to.x - cx) + dx * t), y: Math.round(cy + (to.y - cy) + dy * t) };
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
