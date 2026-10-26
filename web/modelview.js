// View 1: palette, canvas, inspector; the YAML the canvas stands for.
import { h, clear, api, modal } from './lib.js';
import { S, on } from './state.js';
import { Canvas } from './canvas.js';
import { Inspector } from './inspector.js';
import { MapTable } from './maptable.js';

const PALETTE = [
  ['Components', [
    ['llm', 'LLM component', 'llm'], ['deterministic', 'Deterministic', ''], ['tool', 'Tool / API', ''],
    ['store', 'Store / memory', 'store'], ['external', 'External system', 'external'], ['user', 'User', 'external']]],
  ['System boundary', [['sysin', 'System input', 'sysin'], ['sysout', 'System output', 'sysout']]],
  ['On an edge', [['guard', 'Guard', 'guard'], ['obs', 'Observation point', 'obs']]],
];

export class ModelView {
  constructor(host) {
    this.host = host;
    const pal = h('aside', { class: 'palette', 'aria-label': 'Palette' });
    for (const [title, items] of PALETTE) {
      pal.appendChild(h('div', { class: 'group' }, h('h3', {}, title), items.map(([kind, label, cls]) =>
        h('div', { class: `pal ${cls}`, draggable: 'true', ondragstart: (e) => { e.dataTransfer.setData('text/plain', kind); e.dataTransfer.effectAllowed = 'copy'; } },
          kind === 'obs' ? eyeIcon() : null, label))));
    }
    pal.appendChild(h('p', {}, 'Drag onto the canvas. Guards and observation points go onto an edge.'));
    pal.appendChild(h('div', { class: 'legend' },
      h('span', {}, h('i', { class: 'pdot in' }), 'input port'), h('span', {}, h('i', { class: 'pdot out' }), 'output port'),
      h('p', {}, 'Wire a component by dragging from an output port onto an input port, or onto a component to give it a new input port. The + handle starts a new output port. Ports can be added, renamed and deleted in the inspector.')));
    this.badge = h('span', { class: 'badge' }, 'checking…');
    this.name = h('span', { class: 'mono small muted' });
    this.overlayBtn = h('button', { class: 'btn small', 'aria-pressed': 'true', onclick: () => { this.canvas.overlay = !this.canvas.overlay; this.overlayBtn.setAttribute('aria-pressed', String(this.canvas.overlay)); this.overlayBtn.textContent = this.canvas.overlay ? 'Verdicts on canvas: on' : 'Verdicts on canvas: off'; this.canvas.render(); } }, 'Verdicts on canvas: on');
    this.yamlBtn = h('button', { class: 'btn small', onclick: () => this.toggleYaml() }, 'Show YAML');
    this.portBtn = h('button', { class: 'btn small', 'aria-pressed': 'true', onclick: () => { this.canvas.portNames = !this.canvas.portNames; this.portBtn.setAttribute('aria-pressed', String(this.canvas.portNames)); this.portBtn.textContent = this.canvas.portNames ? 'Port names: on' : 'Port names: off'; this.canvas.render(); } }, 'Port names: on');
    this.mapBtn = h('button', { class: 'btn small', 'aria-pressed': 'true', title: 'the mapping table of the selected component or guard', onclick: () => { this.table.open = !this.table.open; this.syncMapBtn(); this.table.render(); } }, 'Mapping table: on');
    this.figBtn = h('button', { class: 'btn small', hidden: true, onclick: () => this.figure() }, 'Case figure');
    const bar = h('div', { class: 'canvas-bar' }, this.badge, this.name, h('span', { class: 'spacer' }),
      this.figBtn, this.portBtn, this.overlayBtn, this.mapBtn, h('button', { class: 'btn small', onclick: () => this.canvas.fit() }, 'Fit'), this.yamlBtn);
    const canvasHost = h('div', { class: 'canvas' });
    this.yaml = h('pre', { class: 'yaml-pane', hidden: true });
    this.foot = h('div', { class: 'canvas-foot' });
    const tableHost = h('section', { class: 'maptable', 'aria-label': 'Mapping table', hidden: true });
    const wrap = h('div', { class: 'canvas-wrap' }, bar, canvasHost, tableHost, this.yaml, this.foot);
    const insp = h('aside', { class: 'inspector', 'aria-label': 'Inspector' });
    host.append(pal, wrap, insp);
    this.canvas = new Canvas(canvasHost);
    this.inspector = new Inspector(insp);
    this.table = new MapTable(tableHost);
    on('maptable:toggled', () => this.syncMapBtn());
    on('check', () => this.status());
    on('doc', () => { this.name.textContent = S.doc ? S.doc.name : ''; if (!this.yaml.hidden) this.refreshYaml(); });
    on('loaded', () => { this.name.textContent = S.doc.name; this.figBtn.hidden = !(S.bundle && S.bundle.meta && S.bundle.meta.figure); this.canvas.render(); requestAnimationFrame(() => this.canvas.fit()); });
    on('shown:model', () => requestAnimationFrame(() => { this.canvas.render(); if (!this.fitted) { this.canvas.fit(); this.fitted = true; } }));
  }

  status() {
    const ch = S.check;
    clear(this.foot);
    if (!ch) return;
    this.badge.className = `badge ${ch.ok ? 'ok' : 'bad'}`;
    this.badge.textContent = ch.ok ? 'well-formed' : `${(ch.problems || []).length} problem(s)`;
    this.badge.title = ch.ok ? '' : (ch.problems || []).join('\n');
    if (!ch.ok) { this.foot.append(h('span', {}, (ch.problems || [])[0] || '')); return; }
    const rows = Object.values(ch.summary.rows);
    const open = rows.filter((r) => r.open).length;
    const gen = rows.filter((r) => r.kind !== 'row').length;
    const maxc = Math.max(0, ...ch.cells.map((c) => c.candidates));
    this.foot.append(...[
      h('span', {}, `${Object.values(ch.summary.components).filter((c) => c.kind !== 'guard').length} components, ${Object.values(ch.summary.components).filter((c) => c.kind === 'guard').length} guards`),
      h('span', {}, `${Object.keys(ch.summary.edges).length} edge segments`),
      h('span', {}, `${rows.length} rows (${gen} generated, ${open} open)`),
      h('span', {}, `${ch.cells.length} cells`),
      h('span', {}, `largest cone: ${maxc} candidates`),
      (ch.absorbed || []).length ? h('span', { class: 'muted' }, `${ch.absorbed.length} absorption(s) declared`) : null].filter(Boolean));
  }

  syncMapBtn() { this.mapBtn.setAttribute('aria-pressed', String(this.table.open)); this.mapBtn.textContent = this.table.open ? 'Mapping table: on' : 'Mapping table: off'; }

  async refreshYaml() { this.yaml.textContent = await api('/api/model/yaml', { doc: S.doc }); }
  toggleYaml() {
    this.yaml.hidden = !this.yaml.hidden;
    this.yamlBtn.textContent = this.yaml.hidden ? 'Show YAML' : 'Hide YAML';
    if (!this.yaml.hidden) this.refreshYaml();
  }
  figure() {
    modal(h('div', { class: 'block' }, h('h2', { style: 'margin:0' }, S.bundle.meta.title),
      h('p', { class: 'hint' }, 'The architecture figure the case model was drawn from.'),
      h('img', { src: `/api/cases/${S.caseId}/figure`, alt: `Architecture figure of ${S.bundle.meta.title}`, style: 'width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:#fff' })));
  }
}

function eyeIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '22'); svg.setAttribute('height', '14'); svg.setAttribute('viewBox', '-12 -8 24 16');
  svg.innerHTML = '<ellipse rx="11" ry="7" fill="#fff" stroke="#2B6CB0" stroke-width="1.6"/><circle r="3" fill="#2B6CB0"/>';
  return svg;
}
