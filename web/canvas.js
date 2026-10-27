// The modelling canvas: components with their ports, system ports, edges between ports, guards on
// edges, observation points. SVG, with pan (drag the background), zoom (wheel), move (drag a node),
// connect (drag from a port, or from the "+" handle for a new output port, onto a port or a node)
// and drop from the palette.
//
// Ports follow Definition (Component): In(c) and Out(c) are drawn on the border of the component,
// inputs hollow and outputs filled, each on the side facing what it is wired to. An edge runs from
// an output port (or a system input) to an input port (or a system output).
import { s, clear } from './lib.js';
import { S, on, emit, comp, parseRef, nodeIdOfRef, sysPorts, connectPorts, addComponent, addSysPort, changed, removeSelection, guardSummary, obsSummary, useCasesAt } from './state.js';
import { confirmDialog, isDialogOpen } from './dialog.js';
import { openComponentDialog, openGuardDialog, openObsDialog, openEdgeDialog, openSysDialog } from './modeldialogs.js';

const W = 156, H = 58, SW = 132, SH = 48;
const VERDICT_RANK = { exposed: 6, conflict: 5, unchecked: 4, hope: 3, 'not exercised': 2, guarantee: 1 };
const VERDICT_COLOURS = {
  guarantee: ['#DDF1E7', '#11603F'], hope: ['#FBEBC8', '#7A4E00'], exposed: ['#FBE0DD', '#A2241A'],
  unchecked: ['#E3E9F8', '#2F4A8F'], conflict: ['#EDE3FA', '#5B2D91'], 'not exercised': ['#ECECEA', '#555555'],
};

export function nodeHeight(c) { return Math.max(H, 26 + 16 * Math.max(c.in.length, c.out.length)); }

export class Canvas {
  constructor(host) {
    this.host = host;
    this.t = { x: 20, y: 20, k: 1 };
    this.svg = s('svg', { tabindex: 0, role: 'application', 'aria-label': 'Model canvas' });
    const marker = (id, fill) => s('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      s('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill }));
    this.svg.appendChild(s('defs', {}, marker('arrow', '#6B6F78'), marker('arrow-llm', '#B7791F'), marker('arrow-sel', '#2B6CB0')));
    this.vp = s('g');
    this.gEdges = s('g'); this.gDeco = s('g'); this.gNodes = s('g'); this.gPorts = s('g'); this.gTemp = s('g');
    this.vp.append(this.gEdges, this.gNodes, this.gDeco, this.gPorts, this.gTemp);
    this.svg.appendChild(this.vp);
    host.appendChild(this.svg);
    this.overlay = true;
    this.portNames = true;
    this.bind();
    on('doc', () => this.render());
    on('select', () => this.render());
    on('report', () => this.render());
  }

  // ---------------------------------------------------------------- geometry
  nodes() {
    const d = S.doc, out = [];
    for (const c of d.components) out.push({ id: c.id, kind: c.kind, label: c.label || '', x: c.pos.x, y: c.pos.y, w: W, h: nodeHeight(c), c });
    const sp = sysPorts(d);
    for (const n of sp.ins) { const p = d.layout.sys[n] || { x: 0, y: 0 }; out.push({ id: `sys:${n}`, kind: 'sysin', label: 'system input', x: p.x, y: p.y, w: SW, h: SH }); }
    for (const n of sp.outs) { const p = d.layout.sys[n] || { x: 0, y: 0 }; out.push({ id: `sys:${n}`, kind: 'sysout', label: 'system output', x: p.x, y: p.y, w: SW, h: SH }); }
    return out;
  }

  /** Where each component port sits: on the border facing what the port is wired to. */
  ports(byId) {
    const d = S.doc, out = {};
    const centre = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
    for (const c of d.components) {
      const n = byId[c.id]; if (!n) continue;
      const C = centre(n);
      const items = [];
      for (const side of ['in', 'out']) {
        for (const p of c[side]) {
          const ref = `${c.id}.${p}`;
          const peers = d.edges.filter((e) => (side === 'in' ? e.to : e.from) === ref).map((e) => (side === 'in' ? e.from : e.to));
          let vx = 0, vy = 0;
          for (const r of peers) {
            const m = byId[nodeIdOfRef(r)]; if (!m || m === n) continue;
            const P = centre(m); const L = Math.hypot(P.x - C.x, P.y - C.y) || 1;
            vx += (P.x - C.x) / L; vy += (P.y - C.y) / L;
          }
          if (Math.abs(vx) + Math.abs(vy) < 1e-6) { vx = side === 'in' ? -1 : 1; vy = 0; }
          const tx = Math.abs(vx) / (n.w / 2), ty = Math.abs(vy) / (n.h / 2);
          const it = { key: `${c.id}|${side}|${p}`, side, name: p, comp: c.id };
          if (tx >= ty) { it.border = vx < 0 ? 'L' : 'R'; it.t = C.y + vy / tx; } else { it.border = vy < 0 ? 'T' : 'B'; it.t = C.x + vx / ty; }
          items.push(it);
        }
      }
      for (const b of ['L', 'R', 'T', 'B']) {
        // two ports facing the same neighbour: put them so that the pair of edges does not cross
        // (outputs first on the right and bottom borders, inputs first on the left and top ones)
        const outFirst = b === 'R' || b === 'B';
        const rank = (x) => ((x.side === 'out') === outFirst ? 0 : 1);
        const g = items.filter((i) => i.border === b).sort((a, z) => (Math.abs(a.t - z.t) > 0.5 ? a.t - z.t : rank(a) - rank(z)));
        if (!g.length) continue;
        const vertical = b === 'L' || b === 'R';
        const lo = vertical ? n.y + 11 : n.x + 16, hi = vertical ? n.y + n.h - 11 : n.x + n.w - 16;
        const gap = Math.min(vertical ? 16 : 60, g.length > 1 ? (hi - lo) / (g.length - 1) : 99);
        let prev = -Infinity;
        for (const it of g) { it.t = Math.max(it.t, prev + gap); prev = it.t; }
        const over = g[g.length - 1].t - hi; if (over > 0) g.forEach((it) => { it.t -= over; });
        const under = lo - g[0].t; if (under > 0) g.forEach((it) => { it.t += under; });
        g.forEach((it, i) => {
          it.t = Math.min(hi, Math.max(lo, it.t));
          // on the top and bottom borders the left half writes its name to the left of the dot
          it.labelLeft = !vertical && g.length > 1 && i < g.length / 2;
          out[it.key] = { ...it, x: b === 'L' ? n.x : b === 'R' ? n.x + n.w : it.t, y: b === 'T' ? n.y : b === 'B' ? n.y + n.h : it.t };
        });
      }
    }
    return out;
  }

  endPoint(ref, side, byId, ports, toward) {
    const [o, p] = parseRef(ref);
    if (o !== 'sys') return ports[`${o}|${side}|${p}`];
    const n = byId[`sys:${p}`];
    return n ? clip(n, toward, { x: n.x + n.w / 2, y: n.y + n.h / 2 }) : null;
  }

  toWorld(ev) {
    const r = this.svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left - this.t.x) / this.t.k, y: (ev.clientY - r.top - this.t.y) / this.t.k };
  }
  applyT() { this.vp.setAttribute('transform', `translate(${this.t.x},${this.t.y}) scale(${this.t.k})`); }

  fit() {
    const ns = this.nodes();
    if (!ns.length) { this.t = { x: 40, y: 40, k: 1 }; this.applyT(); return; }
    const x0 = Math.min(...ns.map((n) => n.x)) - 60, y0 = Math.min(...ns.map((n) => n.y)) - 50;
    const x1 = Math.max(...ns.map((n) => n.x + n.w)) + 80, y1 = Math.max(...ns.map((n) => n.y + n.h)) + 60;
    const r = this.svg.getBoundingClientRect();
    const k = Math.min(1.2, Math.max(0.3, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
    this.t = { k, x: (r.width - (x1 - x0) * k) / 2 - x0 * k, y: (r.height - (y1 - y0) * k) / 2 - y0 * k };
    this.applyT();
  }

  // ---------------------------------------------------------------- drawing
  render() {
    if (!S.doc) return;
    clear(this.gEdges); clear(this.gNodes); clear(this.gDeco); clear(this.gPorts);
    const d = S.doc, ns = this.nodes();
    const byId = Object.fromEntries(ns.map((n) => [n.id, n]));
    const ports = this.ports(byId);
    this.lastPorts = ports;
    const sel = S.selection || {};
    const verdictAt = this.verdictsByObs();
    for (const e of d.edges) {
      const a = byId[nodeIdOfRef(e.from)], b = byId[nodeIdOfRef(e.to)];
      if (!a || !b) continue;
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const pa0 = parseRef(e.from)[0] === 'sys' ? null : ports[`${parseRef(e.from)[0]}|out|${parseRef(e.from)[1]}`];
      const pb0 = parseRef(e.to)[0] === 'sys' ? null : ports[`${parseRef(e.to)[0]}|in|${parseRef(e.to)[1]}`];
      const pa = pa0 || this.endPoint(e.from, 'out', byId, ports, pb0 || cb);
      const pb = pb0 || this.endPoint(e.to, 'in', byId, ports, pa0 || ca);
      if (!pa || !pb) continue;
      this.gEdges.appendChild(this.edgeShape(e, pa, pb, sel, verdictAt));
    }
    for (const n of ns) this.gNodes.appendChild(this.nodeShape(n, sel));
    const selPort = sel.type === 'port' ? sel.id : null;
    for (const p of Object.values(ports)) this.gPorts.appendChild(this.portShape(p, selPort, sel));
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
    const isSel = (sel.type === 'component' && sel.id === n.id) || (sel.type === 'sys' && sel.id === n.id) || (sel.type === 'port' && sel.id.split('|')[0] === n.id);
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
    if (n.kind === 'sysin') {
      const ucs = useCasesAt(S.doc, n.id.slice(4));
      const txt = ucs.length ? `starts ${ucs.map((u) => u.id).join(', ')}` : 'no use case starts here';
      g.appendChild(s('text', { class: `uc${ucs.length ? '' : ' none'}`, x: n.w / 2, y: n.h + 14, 'text-anchor': 'middle' }, txt.length > 34 ? `${txt.slice(0, 33)}…` : txt));
    }
    if (n.kind !== 'sysout') {
      // the handle opens a new output port (a system input simply starts another edge)
      const hg = s('g', { class: 'handle', 'data-handle': n.id, transform: `translate(${n.w + 14},${n.h / 2})` });
      hg.appendChild(s('title', {}, n.c ? 'Drag to connect from a new output port' : 'Drag to connect'));
      hg.appendChild(s('circle', { r: 8, 'data-handle': n.id }));
      hg.appendChild(s('path', { d: 'M -4 0 H 4 M 0 -4 V 4', 'data-handle': n.id }));
      g.appendChild(hg);
    }
    return g;
  }

  portShape(p, selPort, sel) {
    const isSel = selPort === p.key;
    const c = comp(S.doc, p.comp);
    const llmOut = c && c.kind === 'llm' && p.side === 'out';
    const free = !S.doc.edges.some((e) => (p.side === 'in' ? e.to : e.from) === `${p.comp}.${p.name}`);
    const g = s('g', { class: `port ${p.side}${isSel ? ' selected' : ''}${llmOut ? ' llm' : ''}${free ? ' free' : ''}`, 'data-port': p.key, transform: `translate(${p.x},${p.y})` });
    g.appendChild(s('title', {}, `${p.side === 'in' ? 'input' : 'output'} port ${p.comp}.${p.name}${free ? ' (unconnected)' : ''} — drag to connect, click to select`));
    g.appendChild(s('circle', { class: 'hit', r: 9, 'data-port': p.key }));
    g.appendChild(s('circle', { class: 'dot', r: isSel ? 5.5 : 4.5, 'data-port': p.key }));
    const show = this.portNames || isSel || (sel.type === 'component' && sel.id === p.comp);
    if (show) {
      const lab = p.name.length > 18 ? `${p.name.slice(0, 17)}…` : p.name;
      const at = { L: [-7, -6, 'end'], R: [7, -6, 'start'], T: p.labelLeft ? [-7, -6, 'end'] : [7, -6, 'start'], B: p.labelLeft ? [-7, 14, 'end'] : [7, 14, 'start'] }[p.border];
      g.appendChild(s('text', { x: at[0], y: at[1], 'text-anchor': at[2] }, lab));
    }
    return g;
  }

  edgeShape(e, pa, pb, sel, verdictAt) {
    const d = S.doc;
    const dx = pb.x - pa.x, dy = pb.y - pa.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const fromComp = comp(d, parseRef(e.from)[0]);
    const llm = fromComp && fromComp.kind === 'llm';
    const isSel = sel.type === 'edge' && sel.id === e.id;
    const g = s('g', { class: `edge${llm ? ' llm' : ''}${isSel ? ' selected' : ''}`, 'data-edge': e.id });
    // stop the arrow just short of an input port dot
    const end = { x: pb.x - (dx / len) * 6, y: pb.y - (dy / len) * 6 };
    const path = `M ${pa.x} ${pa.y} L ${end.x} ${end.y}`;
    g.appendChild(s('path', { class: 'hit', d: path, 'data-edge': e.id }));
    g.appendChild(s('path', { class: 'line', d: path, 'marker-end': `url(#${isSel ? 'arrow-sel' : llm ? 'arrow-llm' : 'arrow'})` }));
    const at = (f) => ({ x: pa.x + dx * f, y: pa.y + dy * f });
    const guards = d.guards.filter((gd) => gd.edge === e.id);
    const o = d.observation_points.find((op) => op.edge === e.id);
    const lab = e.label || '';
    if (lab) {
      const p = at(guards.length ? 0.22 : 0.5);
      const anchor = Math.abs(nx) > 0.6 ? (nx > 0 ? 'start' : 'end') : 'middle';
      g.appendChild(s('text', { x: p.x + nx * 10, y: p.y + ny * 12 + 4, 'text-anchor': anchor }, lab.length > 30 ? lab.slice(0, 29) + '…' : lab));
    }
    const vertical = Math.abs(dy) > Math.abs(dx);
    guards.forEach((gd, i) => {
      // several guards on one edge are stacked in the order they cut it
      const k = i - (guards.length - 1) / 2;
      const p = vertical ? at((o ? 0.5 : 0.55) + (k * 36) / len)
        : (() => { const c0 = at(o ? 0.5 : 0.55); return { x: c0.x + nx * 36 * k, y: c0.y + ny * 36 * k }; })();
      const gs = guardSummary(d, gd);
      const name = gd.label || 'unnamed guard';
      const w = Math.max(56, Math.max(name.length * 6.8, gs.text.length * 5.9) + 18);
      const cls = `gpill${gd.learned ? ' learned' : ''}${gs.empty ? ' empty' : ''}${sel.type === 'guard' && sel.id === gd.id ? ' selected' : ''}`;
      const pill = s('g', { class: cls, transform: `translate(${p.x - w / 2},${p.y - 16})`, 'data-guard': gd.id });
      pill.appendChild(s('title', {}, `guard ${gd.id}: ${gs.long}`));
      pill.appendChild(s('rect', { width: w, height: 32, rx: 7 }));
      pill.appendChild(s('text', { class: 'n', x: w / 2, y: 13.5, 'text-anchor': 'middle' }, name));
      pill.appendChild(s('text', { class: 't', x: w / 2, y: 26, 'text-anchor': 'middle' }, gs.text));
      this.gDeco.appendChild(pill);
    });
    if (o) {
      const p = at(Math.max(0.6, 1 - 34 / len));
      const v = verdictAt[o.id];
      const [bg, ink] = v ? VERDICT_COLOURS[v] : ['#FFFFFF', '#2B6CB0'];
      const os = obsSummary(d, o);
      const eg = s('g', { class: `eye${os.empty ? ' empty' : ''}${sel.type === 'obs' && sel.id === o.id ? ' selected' : ''}`, transform: `translate(${p.x},${p.y})`, 'data-obs': o.id });
      eg.appendChild(s('title', {}, `${o.label || o.id}: judges ${os.long}${v ? ` — worst verdict: ${v}` : ''}`));
      eg.appendChild(s('ellipse', { rx: 13, ry: 9, fill: bg, stroke: os.empty ? '#A2241A' : ink, 'stroke-width': sel.type === 'obs' && sel.id === o.id ? 3 : 1.6 }));
      eg.appendChild(s('circle', { r: 3.4, fill: os.empty ? '#A2241A' : ink }));
      this.gDeco.appendChild(eg);
      const oa = Math.abs(nx) > 0.6 ? (nx > 0 ? 'start' : 'end') : 'middle';
      // the name and what it judges sit on the side of the edge given by its normal, away from the line
      const above = Math.abs(nx) <= 0.6 && ny < 0;
      const tx = p.x + nx * 18, ty = p.y + ny * 20 + 4;
      this.gDeco.appendChild(s('text', { class: 'eye-label', x: tx, y: above ? ty - 13 : ty, 'text-anchor': oa }, o.label || o.id));
      this.gDeco.appendChild(s('text', { class: `eye-sub${os.empty ? ' warn' : ''}`, x: tx, y: above ? ty : ty + 13, 'text-anchor': oa }, os.text));
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
      const portEl = tgt.closest && tgt.closest('[data-port]');
      const nodeEl = tgt.closest && tgt.closest('[data-node]');
      const w = this.toWorld(ev);
      if (handle) { drag = { mode: 'connect', from: { node: handle, side: 'out' }, start: w, moved: false }; this.host.classList.add('connecting'); ev.preventDefault(); return; }
      if (portEl) {
        const [cid, side, name] = portEl.getAttribute('data-port').split('|');
        drag = { mode: 'connect', from: { node: cid, side, port: name }, start: w, moved: false, key: portEl.getAttribute('data-port') };
        this.host.classList.add(side === 'out' ? 'connecting' : 'connecting-rev');
        ev.preventDefault(); return;
      }
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
        if (Math.hypot(w.x - drag.start.x, w.y - drag.start.y) > 4) drag.moved = true;
        let x1, y1;
        if (drag.key && this.lastPorts[drag.key]) { x1 = this.lastPorts[drag.key].x; y1 = this.lastPorts[drag.key].y; }
        else { const n = this.nodes().find((x) => x.id === drag.from.node); x1 = n.x + n.w + 14; y1 = n.y + n.h / 2; }
        clear(this.gTemp).appendChild(s('line', { x1, y1, x2: w.x, y2: w.y, stroke: '#2B6CB0', 'stroke-width': 2, 'stroke-dasharray': '4 4' }));
      }
    });
    window.addEventListener('mouseup', (ev) => {
      if (!drag) return;
      const d0 = drag; drag = null;
      if (d0.mode === 'connect') {
        clear(this.gTemp); this.host.classList.remove('connecting', 'connecting-rev');
        if (!d0.moved) {
          if (d0.key) { S.selection = { type: 'port', id: d0.key }; this.select(); }
          return;
        }
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const portEl = el && el.closest && el.closest('[data-port]');
        const nodeEl = el && el.closest && el.closest('[data-node]');
        let to = null;
        if (portEl) { const [cid, side, name] = portEl.getAttribute('data-port').split('|'); to = { node: cid, side, port: name }; }
        else if (nodeEl) to = { node: nodeEl.getAttribute('data-node') };
        if (!to) return;
        // dragging from an input port connects the other way round
        const r = d0.from.side === 'in' ? connectPorts({ node: to.node, port: to.side === 'out' ? to.port : undefined }, d0.from)
          : connectPorts(d0.from, { node: to.node, port: to.side === 'in' ? to.port : undefined });
        if (!r.ok) this.flash(r.why);
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
    this.svg.addEventListener('keydown', async (ev) => {
      if (isDialogOpen() || !S.selection) return;
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        const sel = S.selection;
        const what = sel.type === 'sys' ? sel.id.replace('sys:', 'sys.') : sel.type === 'port' ? sel.id.split('|').join(' ') : sel.id;
        if (sel.type === 'port') return;
        const ok = await confirmDialog(`Delete ${what}?${sel.type === 'component' || sel.type === 'sys' ? ' Its edges, and the guards and observation points on them, go too.' : ''}`, { title: 'Delete', okText: 'Delete', danger: true });
        if (ok) { S.selection = sel; removeSelection(); emit('select'); }
      } else if (ev.key === 'Enter') { ev.preventDefault(); this.edit(S.selection); }
    });
    this.svg.addEventListener('dblclick', (ev) => {
      const t = ev.target;
      const at = (attr) => { const el = t.closest && t.closest(`[${attr}]`); return el ? el.getAttribute(attr) : null; };
      const g = at('data-guard'), o = at('data-obs'), n = at('data-node'), e = at('data-edge'), p = at('data-port');
      if (g) this.edit({ type: 'guard', id: g });
      else if (o) this.edit({ type: 'obs', id: o });
      else if (p) this.edit({ type: 'component', id: p.split('|')[0] });
      else if (n) this.edit({ type: n.startsWith('sys:') ? 'sys' : 'component', id: n });
      else if (e) this.edit({ type: 'edge', id: e });
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
        // a window asks what the new guard catches, or what the point judges; Cancel adds nothing
        if (kind === 'guard') openGuardDialog(null, { edge: eid });
        else {
          const there = S.doc.observation_points.find((x) => x.edge === eid);
          if (there) { this.flash(`${eid} is already observed by ${there.id}.`); openObsDialog(there.id); } else openObsDialog(null, { edge: eid });
        }
      } else addComponent(kind, w.x - W / 2, w.y - H / 2);
    });
  }

  select() { this.render(); emit('select'); this.svg.focus(); }

  /** Open the dialog that edits a selection. */
  edit(sel) {
    if (!sel) return;
    if (sel.type === 'component') openComponentDialog(sel.id);
    else if (sel.type === 'port') openComponentDialog(sel.id.split('|')[0], { startAt: 'ports' });
    else if (sel.type === 'guard') openGuardDialog(sel.id);
    else if (sel.type === 'obs') openObsDialog(sel.id);
    else if (sel.type === 'edge') openEdgeDialog(sel.id);
    else if (sel.type === 'sys') openSysDialog(sel.id.slice(4));
  }

  /** Bring a selection into view: a node, or the middle of the edge a guard or point sits on. */
  reveal(sel) {
    if (!sel || !S.doc) return;
    const byId = Object.fromEntries(this.nodes().map((n) => [n.id, n]));
    let p = null;
    const mid = (eid) => { const e = S.doc.edges.find((x) => x.id === eid); if (!e) return null; const a = byId[nodeIdOfRef(e.from)], b = byId[nodeIdOfRef(e.to)]; return a && b ? { x: (a.x + a.w / 2 + b.x + b.w / 2) / 2, y: (a.y + a.h / 2 + b.y + b.h / 2) / 2 } : null; };
    if (sel.type === 'component' || sel.type === 'sys') { const n = byId[sel.id]; if (n) p = { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }
    else if (sel.type === 'guard') { const g = S.doc.guards.find((x) => x.id === sel.id); if (g) p = mid(g.edge); }
    else if (sel.type === 'obs') { const o = S.doc.observation_points.find((x) => x.id === sel.id); if (o) p = mid(o.edge); }
    else if (sel.type === 'edge') p = mid(sel.id);
    if (!p) return;
    const r = this.svg.getBoundingClientRect();
    const sx = p.x * this.t.k + this.t.x, sy = p.y * this.t.k + this.t.y;
    if (sx > 60 && sx < r.width - 60 && sy > 40 && sy < r.height - 40) return;   // already in view
    this.t.x = r.width / 2 - p.x * this.t.k; this.t.y = r.height / 2 - p.y * this.t.k;
    this.applyT();
  }

  nearestEdge(w) {
    const d = S.doc;
    const byId = Object.fromEntries(this.nodes().map((n) => [n.id, n]));
    const ports = this.lastPorts || this.ports(byId);
    let best = null, bestD = 30;
    for (const e of d.edges) {
      const a = byId[nodeIdOfRef(e.from)], b = byId[nodeIdOfRef(e.to)];
      if (!a || !b) continue;
      const [fo, fp] = parseRef(e.from), [to, tp] = parseRef(e.to);
      const p = (fo !== 'sys' && ports[`${fo}|out|${fp}`]) || { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const q = (to !== 'sys' && ports[`${to}|in|${tp}`]) || { x: b.x + b.w / 2, y: b.y + b.h / 2 };
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
