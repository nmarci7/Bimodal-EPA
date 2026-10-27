// View 1: the left pane (Add: the palette; Outline: everything in the model), the canvas with its
// mapping table, and the inspector. The display toggles live in one View menu.
import { h, clear, api, modal } from './lib.js';
import { S, on, emit } from './state.js';
import { Canvas } from './canvas.js';
import { Inspector } from './inspector.js';
import { MapTable } from './maptable.js';
import { Outline } from './outline.js';
import { dropdown, button } from './dialog.js';
import { store } from './lib.js';

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
    // ---- left pane: Add | Outline
    const pal = h('div', { class: 'palette-body' });
    for (const [title, items] of PALETTE) {
      pal.appendChild(h('div', { class: 'group' }, h('h3', {}, title), items.map(([kind, label, cls]) =>
        h('div', { class: `pal ${cls}`, draggable: 'true', title: kind === 'guard' || kind === 'obs' ? 'drag onto an edge' : 'drag onto the canvas',
          ondragstart: (e) => { e.dataTransfer.setData('text/plain', kind); e.dataTransfer.effectAllowed = 'copy'; } },
        kind === 'obs' ? eyeIcon() : null, label))));
    }
    pal.appendChild(h('details', { class: 'howto' }, h('summary', {}, 'How to draw'),
      h('div', { class: 'legend' },
        h('p', {}, 'Drag a component onto the canvas. Drag a guard or an observation point onto an edge: a window asks what it does.'),
        h('span', {}, h('i', { class: 'pdot in' }), 'input port'), h('span', {}, h('i', { class: 'pdot out' }), 'output port'),
        h('p', {}, 'Wire by dragging from an output port onto an input port, or onto a component to give it a new input. The + handle on a component starts a new output port.'),
        h('p', {}, 'Click to select, double-click to edit, Delete to remove. Drag the background to pan, scroll to zoom.'))));
    const outlineHost = h('div', { class: 'outline-body', hidden: true });
    const tabAdd = h('button', { class: 'ltab on', role: 'tab', 'aria-selected': 'true', onclick: () => this.leftTab('add') }, 'Add');
    const tabOutline = h('button', { class: 'ltab', role: 'tab', 'aria-selected': 'false', onclick: () => this.leftTab('outline') }, 'Outline');
    this.left = { pal, outlineHost, tabAdd, tabOutline };
    const leftPane = h('aside', { class: 'palette', 'aria-label': 'Add and outline' }, h('div', { class: 'ltabs', role: 'tablist' }, tabAdd, tabOutline), pal, outlineHost);

    // ---- canvas bar
    this.badge = h('span', { class: 'badge' }, 'checking…');
    this.name = h('span', { class: 'mono small muted' });
    this.figBtn = button('Case figure', () => this.figure(), { small: true });
    this.figBtn.hidden = true;
    const viewMenu = dropdown('View', () => [
      { label: 'Port names', checked: this.canvas.portNames, onClick: () => { this.canvas.portNames = !this.canvas.portNames; this.canvas.render(); } },
      { label: 'Verdicts on the canvas', checked: this.canvas.overlay, hint: 'after an analysis', onClick: () => { this.canvas.overlay = !this.canvas.overlay; this.canvas.render(); } },
      { label: 'Mapping table under the canvas', checked: this.table.open, hint: 'rows of the selection', onClick: () => { this.table.open = !this.table.open; this.table.render(); } },
      { label: 'The model as YAML', checked: !this.yaml.hidden, onClick: () => this.toggleYaml() },
      'sep',
      { label: 'Fit the model in view', onClick: () => this.canvas.fit() },
    ], { title: 'what the canvas shows' });
    const bar = h('div', { class: 'canvas-bar' }, this.badge, this.name, h('span', { class: 'spacer' }),
      this.figBtn, button('Fit', () => this.canvas.fit(), { small: true, title: 'fit the model in view' }), viewMenu);
    const canvasHost = h('div', { class: 'canvas' });
    this.yaml = h('pre', { class: 'yaml-pane', hidden: true });
    this.foot = h('div', { class: 'canvas-foot' });
    const tableHost = h('section', { class: 'maptable', 'aria-label': 'Mapping table', hidden: true });
    const wrap = h('div', { class: 'canvas-wrap' }, bar, canvasHost, tableHost, this.yaml, this.foot);
    const insp = h('aside', { class: 'inspector', 'aria-label': 'Inspector' });
    host.append(leftPane, wrap, insp);
    this.canvas = new Canvas(canvasHost);
    this.inspector = new Inspector(insp);
    this.table = new MapTable(tableHost);
    this.outline = new Outline(outlineHost);
    on('check', () => this.status());
    on('doc', () => { this.name.textContent = S.doc ? S.doc.name : ''; if (!this.yaml.hidden) this.refreshYaml(); });
    on('loaded', () => { this.name.textContent = S.doc.name; this.figBtn.hidden = !(S.bundle && S.bundle.meta && S.bundle.meta.figure); this.canvas.render(); requestAnimationFrame(() => this.canvas.fit()); });
    on('shown:model', () => requestAnimationFrame(() => { this.canvas.render(); if (!this.fitted) { this.canvas.fit(); this.fitted = true; } }));
    on('reveal', (sel) => this.canvas.reveal(sel));
    this.leftTab(store('epa.leftTab') || 'add');
  }

  leftTab(which) {
    const { pal, outlineHost, tabAdd, tabOutline } = this.left;
    pal.hidden = which !== 'add';
    outlineHost.hidden = which !== 'outline';
    tabAdd.classList.toggle('on', which === 'add'); tabAdd.setAttribute('aria-selected', String(which === 'add'));
    tabOutline.classList.toggle('on', which === 'outline'); tabOutline.setAttribute('aria-selected', String(which === 'outline'));
    store('epa.leftTab', which);
  }

  status() {
    const ch = S.check;
    clear(this.foot);
    if (!ch) return;
    this.badge.className = `badge ${ch.ok ? 'ok' : 'bad'}`;
    this.badge.textContent = ch.ok ? 'well-formed' : `${(ch.problems || []).length} problem(s)`;
    this.badge.title = ch.ok ? '' : (ch.problems || []).join('\n');
    if (!ch.ok) { this.foot.append(h('span', { class: 'warn' }, (ch.problems || [])[0] || '')); return; }
    const rows = Object.values(ch.summary.rows);
    const open = rows.filter((r) => r.open).length;
    const gen = rows.filter((r) => r.kind !== 'row').length;
    const maxc = Math.max(0, ...ch.cells.map((c) => c.candidates));
    this.foot.append(...[
      h('span', {}, `${Object.values(ch.summary.components).filter((c) => c.kind !== 'guard').length} components, ${Object.values(ch.summary.components).filter((c) => c.kind === 'guard').length} guards`),
      h('span', {}, `${rows.length} rows (${gen} generated, ${open} open)`),
      h('span', {}, `${ch.cells.length} cells`),
      h('span', { title: 'the most candidates any one cell has to consider' }, `largest cone: ${maxc} candidates`),
      (ch.absorbed || []).length ? h('span', { class: 'muted' }, `${ch.absorbed.length} absorption(s) declared`) : null].filter(Boolean));
  }

  async refreshYaml() { this.yaml.textContent = await api('/api/model/yaml', { doc: S.doc }); }
  toggleYaml() {
    this.yaml.hidden = !this.yaml.hidden;
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
