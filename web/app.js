// The workbench: wires the four views, the demo cases and their scenario stages, import/export,
// and the bootstrap from traces.
import { h, clear, api, readFile, download, toast, modal, dropZone } from './lib.js';
import { S, on, emit, blankDoc, normaliseDoc, emptyEvidence, runCheck, persist, restore } from './state.js';
import { ModelView } from './modelview.js';
import { EvidenceView } from './evidence.js';
import { AnalysisView } from './analysis.js';
import { VerdictsView } from './verdicts.js';

const $ = (id) => document.getElementById(id);
let views = {};

function show(view) {
  S.view = view;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'verdicts') { const dot = document.querySelector('.tab[data-view="verdicts"] .dot'); if (dot) dot.remove(); }
  emit(`shown:${view}`);
}

// ---------------------------------------------------------------- cases and stages
async function loadCases() {
  const cases = await api('/api/cases');
  const sel = $('case-select');
  for (const c of cases) sel.appendChild(h('option', { value: c.id }, c.title));
  sel.addEventListener('change', () => { if (sel.value) openCase(sel.value); });
  return cases;
}

async function openCase(id, stage) {
  S.bundle = await api(`/api/cases/${id}/bundle`);
  S.caseId = id;
  $('case-select').value = id;
  const st = stage || (S.bundle.stages[0] && S.bundle.stages[0].id);
  if (st) await openStage(st);
  else setDoc(normaliseDoc((await api(`/api/cases/${id}`)).model), emptyEvidence());
  drawStagebar();
}

async function openStage(stage) {
  const r = await api(`/api/cases/${S.caseId}/stages/${stage}`);
  const keep = S.doc && S.caseId && S.doc.layout ? S.doc.layout.sys : null;
  const doc = r.doc;
  doc.layout = doc.layout || {};
  if (keep && !(doc.layout.sys && Object.keys(doc.layout.sys).length)) doc.layout.sys = JSON.parse(JSON.stringify(keep));
  S.stage = stage;
  setDoc(normaliseDoc(doc), { ...emptyEvidence(), certificates: r.evidence.certificates || [], witnesses: r.evidence.witnesses || [], decisions: r.evidence.decisions || [] });
  drawStagebar();
}

function setDoc(doc, evidence) {
  S.doc = doc;
  if (evidence) S.evidence = evidence;
  S.analysis = null;
  S.selection = null;
  S.check = null;
  persist();
  emit('loaded');
  emit('evidence');
  emit('report');
  runCheck();
}

function drawStagebar() {
  const bar = clear($('stagebar'));
  if (!S.bundle || !S.caseId) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.appendChild(h('span', { class: 'label' }, `${S.bundle.meta.title} · scenario`));
  const chips = h('div', { class: 'chips' });
  for (const st of S.bundle.stages) {
    chips.appendChild(h('button', { class: `chip${st.id === S.stage ? ' active' : ''}`, title: st.label, onclick: () => openStage(st.id) }, `${st.id} ${st.label.length > 30 ? `${st.label.slice(0, 29)}…` : st.label}`));
  }
  bar.appendChild(chips);
  const cur = S.bundle.stages.find((x) => x.id === S.stage);
  const parts = [];
  if (cur) {
    parts.push(h('b', {}, `${cur.id}: ${cur.label}. `), (cur.note || '').trim());
    const adds = [...(cur.certificates || []), ...(cur.logs || [])].map((x) => x.split('/').pop());
    if (adds.length) parts.push(h('span', {}, ` Adds ${adds.join(', ')}.`));
    if (cur.versions) parts.push(h('span', {}, ` Versions: ${Object.entries(cur.versions).map(([k, v]) => `${k} → ${v}`).join(', ')}.`));
    parts.push(' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); emit('run'); } }, 'Run this stage'));
  } else parts.push(S.bundle.meta.summary || '');
  bar.appendChild(h('div', { class: 'note' }, parts));
}

// ---------------------------------------------------------------- header actions
function newModel() {
  const close = modal(h('div', { class: 'block' }, h('h2', { style: 'margin:0' }, 'Start a new model'),
    h('p', { class: 'hint' }, 'The canvas is cleared and the evidence register emptied. Export the current model first if you want to keep it.'),
    h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: () => { close(); S.caseId = null; S.bundle = null; S.stage = null; $('case-select').value = ''; setDoc(normaliseDoc(blankDoc()), emptyEvidence()); drawStagebar(); show('model'); } }, 'Start blank'),
      h('button', { class: 'btn', onclick: () => { exportYaml(); } }, 'Export the current one first'))));
}

async function importFile(file) {
  const text = await readFile(file);
  try {
    const r = await api('/api/model/parse', { text });
    S.stage = null;
    setDoc(normaliseDoc(r.doc), emptyEvidence());
    drawStagebar();
    show('model');
    toast(r.problems.length ? `${file.name} loaded with ${r.problems.length} problem(s): see the inspector.` : `${file.name} loaded.`);
  } catch (e) { toast(`${file.name}: ${e.message}`); }
}

async function exportYaml() {
  const text = await api('/api/model/yaml', { doc: S.doc });
  download(`${S.doc.name || 'model'}.yaml`, text, 'text/yaml');
}

function bootstrapDialog() {
  const inputs = { traces: null, tools: null, answers: null };
  const names = { traces: h('span', { class: 'small muted' }, 'none'), tools: h('span', { class: 'small muted' }, 'none'), answers: h('span', { class: 'small muted' }, 'none') };
  const server = h('input', { value: '', placeholder: 'found from the traces', style: 'height:34px;border:1px solid var(--line2);border-radius:6px;padding:0 8px;width:140px' });
  const out = h('div', { class: 'block' });
  const set = (k, name, text) => { inputs[k] = text; names[k].textContent = name; };
  const zone = (k, label, sub, accept) => h('div', { class: 'block' }, dropZone(label, sub, async (fs) => { if (fs[0]) set(k, fs[0].name, await readFile(fs[0])); }, accept), h('div', { class: 'inline' }, h('span', { class: 'small' }, 'loaded:'), names[k]));
  const intake = S.bundle && S.bundle.intake && S.bundle.intake.length ? S.bundle.intake : null;
  const useCase = intake ? h('button', { class: 'btn small', onclick: async () => {
    for (const p of intake) {
      const t = await api(`/api/cases/${S.caseId}/file?path=${encodeURIComponent(p)}`);
      const n = p.split('/').pop();
      if (n.startsWith('traces')) set('traces', n, t);
      else if (n === 'tools_list.json') set('tools', n, t);
      else if (n.startsWith('answers')) set('answers', n, t);
    }
  } }, `Use the ${S.bundle.meta.title} intake files`) : null;
  const go = async () => {
    if (!inputs.traces) { toast('Traces are needed: they give the components and the edges.'); return; }
    try {
      const r = await api('/api/bootstrap', { traces: inputs.traces, tools: inputs.tools, answers: inputs.answers, server: server.value, name: 'bootstrapped' });
      clear(out);
      const sk = r.skeleton;
      out.append(h('span', { class: 'section-title' }, 'Skeleton from the traces'),
        h('p', { style: 'margin:0' }, `${Object.keys(sk.components || {}).length} components and ${(sk.edges || []).length} edges from ${sk.traces || 'the'} trace(s).`),
        h('span', { class: 'section-title' }, 'What the traces cannot know'),
        h('ol', { class: 'story' }, (r.questions || []).map((q) => h('li', {}, typeof q === 'string' ? q : [h('b', { class: 'mono small' }, q.key), ` ${q.ask}`]))));
      if (r.doc) {
        out.append((r.problems || []).length ? h('div', { class: 'problems' }, h('ul', {}, r.problems.map((p) => h('li', {}, p)))) : h('p', { class: 'hint' }, 'The answers complete the model.'),
          h('div', {}, h('button', { class: 'btn primary', onclick: () => { close(); S.stage = null; setDoc(normaliseDoc(r.doc), emptyEvidence()); drawStagebar(); show('model'); toast('Bootstrapped model loaded. Check the guards and the observation points.'); } }, 'Open the bootstrapped model')));
      } else out.append(h('p', { class: 'hint' }, 'Add an answers file to turn the skeleton into a model, or answer the questions in the inspector after opening the skeleton.'));
    } catch (e) { toast(e.message); }
  };
  const close = modal(h('div', { class: 'block' }, h('h2', { style: 'margin:0' }, 'Bootstrap a model from traces'),
    h('p', { class: 'hint' }, 'OpenTelemetry-style spans give the components and the edges; an MCP tools/list gives the tools and their schemas. What no trace shows (which checks are guards, what each observation point tolerates, the lattices) comes from the answers file or from you.'),
    useCase, h('div', { class: 'grid3' }, zone('traces', 'Traces (JSON Lines)', 'spans with service, name, parent', '.jsonl,.json'), zone('tools', 'MCP tools/list (JSON)', 'optional', '.json'), zone('answers', 'Answers (YAML)', 'optional', '.yaml,.yml')),
    h('div', { class: 'inline' }, h('label', { class: 'inline small' }, 'MCP server component', server), h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: go }, 'Build')), out));
}

// ---------------------------------------------------------------- start
async function main() {
  views = {
    model: new ModelView($('view-model')),
    evidence: new EvidenceView($('view-evidence')),
    analysis: new AnalysisView($('view-analysis')),
    verdicts: new VerdictsView($('view-verdicts')),
  };
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  on('show', (v) => show(v));
  on('run', () => views.analysis.run());
  on('report', () => {
    if (S.analysis && S.analysis.report && S.view !== 'verdicts') {
      const t = document.querySelector('.tab[data-view="verdicts"]');
      if (t && !t.querySelector('.dot')) t.appendChild(h('span', { class: 'dot', 'aria-label': 'new verdicts' }));
    }
  });
  $('btn-run').addEventListener('click', () => views.analysis.run());
  $('btn-new').addEventListener('click', newModel);
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; });
  $('btn-export').addEventListener('click', exportYaml);
  $('btn-bootstrap').addEventListener('click', bootstrapDialog);
  const cases = await loadCases();
  const params = new URLSearchParams(location.search);
  restore();
  if (params.get('case')) await openCase(params.get('case'), params.get('stage') || undefined);
  else if (S.caseId && cases.find((c) => c.id === S.caseId)) {
    S.bundle = await api(`/api/cases/${S.caseId}/bundle`);
    $('case-select').value = S.caseId;
    if (S.doc) { S.analysis = null; emit('loaded'); emit('evidence'); runCheck(); drawStagebar(); } else await openCase(S.caseId, S.stage);
  } else if (S.doc) { emit('loaded'); emit('evidence'); runCheck(); }
  else if (cases.length) await openCase(cases[0].id);
  else setDoc(normaliseDoc(blankDoc()), emptyEvidence());
  show(params.get('view') || 'model');
  if (params.get('run')) views.analysis.run();
}

main().catch((e) => { console.error(e); toast(`Could not start: ${e.message}`); });
