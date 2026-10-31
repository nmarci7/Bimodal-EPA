// The reasoner: wires the four views, the demo cases and their scenario stages, import/export,
// and the bootstrap from traces.
import { h, clear, api, readFile, download, toast, modal, dropZone, store } from './lib.js';
import { S, on, emit, blankDoc, normaliseDoc, emptyEvidence, runCheck, persist, restore, details, setDetails } from './state.js';
import { ModelView } from './modelview.js';
import { EvidenceView } from './evidence.js';
import { AnalysisView } from './analysis.js';
import { VerdictsView } from './verdicts.js';
import { FlowBar } from './flow.js';
import { VerdictBar } from './verdictbar.js';
import { Tutorial } from './tutorial.js';
import { dropdown, button, infoDialog, confirmDialog } from './dialog.js';

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

// ---------------------------------------------------------------- the assistant's model (epa/workspace.py)
// An MCP client works on one model of its own, the shared workspace (.epa-work/workspace.json); the
// Assistant menu opens it here, sends this model there, and says how to connect an assistant.
const when = (t) => (t ? new Date(t * 1000).toLocaleString() : 'never');
const byWhom = (by) => (by === 'mcp' ? 'the assistant' : 'this browser');

async function openWorkspace() {
  let ws;
  try { ws = await api('/api/workspace'); } catch (e) { toast(e.message, 6000); return; }
  S.caseId = null; S.bundle = null; S.stage = null; $('case-select').value = '';
  setDoc(normaliseDoc(ws.doc), { ...emptyEvidence(), ...ws.evidence, files: ws.evidence.files || [] });
  drawStagebar();
  show('model');
  store('epa.wsSeen', ws.updated);
  toast(`Opened the assistant's model: ${ws.doc.name || 'model'}, saved by ${byWhom(ws.by)} on ${when(ws.updated)}.`, 6000);
}

async function saveWorkspace() {
  const meta = await api('/api/workspace/meta');
  if (meta.exists) {
    const ok = await confirmDialog(`The assistant's model (${meta.name || 'a model'}, saved by ${byWhom(meta.by)} on ${when(meta.updated)}) is replaced by ${S.doc.name || 'this model'} and its evidence. The assistant works on it from its next request.`,
      { title: 'Send this model to the assistant', okText: 'Send it' });
    if (!ok) return;
  }
  // a demo case keeps its recognisers, manifest and lookup files in its bundle: hand them over too
  const b = S.bundle || {};
  const evidence = { ...S.evidence, recognisers: { ...(b.recognisers || {}), ...(S.evidence.recognisers || {}) },
    deployments: S.evidence.deployments || b.deployments || null, lookups: { ...(b.lookups || {}), ...(S.evidence.lookups || {}) } };
  const r = await api('/api/workspace', { doc: S.doc, evidence, case: S.caseId, stage: S.stage }, 'PUT');
  store('epa.wsSeen', r.updated);
  toast(`Sent: the assistant works on ${S.doc.name || 'this model'} from its next request.`, 6000);
}

/** When the window comes back, say if the assistant changed its model in the meantime. */
async function watchWorkspace() {
  try {
    const meta = await api('/api/workspace/meta');
    if (meta.exists && meta.by === 'mcp' && meta.updated > (store('epa.wsSeen') || 0)) {
      store('epa.wsSeen', meta.updated);
      toast(`The assistant changed its model (${meta.name || 'a model'}, ${when(meta.updated)}). Assistant → Open the assistant's model shows it.`, 9000);
    }
  } catch (e) { /* an older server without the workspace: nothing to say */ }
}

/** How to use the reasoner from an assistant: register the MCP server once (the assistant starts it),
 * ask, and take turns on the assistant's model. The command names this repository's mcp.sh. */
async function connectDialog() {
  let meta = {};
  try { meta = await api('/api/workspace/meta'); } catch (e) { /* an older server: show the generic command */ }
  const name = (meta.mcp && meta.mcp.name) || 'bimodal-reasoner';
  const cmd = (meta.mcp && meta.mcp.command) || '/path/to/epa-v2/mcp.sh';
  const copy = (text) => button('Copy', async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch (e) { toast('Select the text and copy it.'); }
  }, { small: true });
  const code = (text) => h('div', { class: 'copyrow' }, h('pre', { class: 'code' }, text), copy(text));
  const claudeCode = `claude mcp add --scope user ${name} -- "${cmd}"`;
  const desktop = JSON.stringify({ mcpServers: { [name]: { command: cmd } } }, null, 2);
  const ask = `Use the ${name} tools: open the wallet case at stage S2, run the analysis, and explain why oom at o_statement is a hope.`;
  const status = meta.exists ? `${meta.name || 'a model'}, saved by ${byWhom(meta.by)} on ${when(meta.updated)}.` : 'empty: nothing saved yet.';
  const d = infoDialog('Use the reasoner from an assistant', h('div', { class: 'block help' },
    h('p', {}, 'An assistant such as Claude Code or Claude Desktop can do what you do here, through the reasoner\'s MCP server: open a demo case, build or change a model, add certificates and witnesses, run the analysis and explain the verdicts. Every change it makes is checked, as in the windows here.'),
    h('span', { class: 'section-title' }, '1 · Register the server, once'),
    h('p', { class: 'hint' }, 'You never start the server yourself: the assistant starts it when it needs it and stops it when it is done. It runs mcp.sh from this repository, with the repository\'s Python environment.'),
    h('b', {}, 'Claude Code'), code(claudeCode),
    h('p', { class: 'hint' }, 'Inside this repository Claude Code finds it by itself (.mcp.json). claude mcp list says whether it connects.'),
    h('b', {}, 'Claude Desktop'),
    h('p', { class: 'hint' }, 'Settings → Developer → Edit Config, add this to claude_desktop_config.json, and restart Claude Desktop:'), code(desktop),
    h('span', { class: 'section-title' }, '2 · Ask it'), code(ask),
    h('span', { class: 'section-title' }, '3 · Take turns on one model'),
    h('p', { class: 'hint' }, 'The assistant works on a model of its own, saved after every change. Open it here to see what the assistant did; send yours to hand it over. When the assistant changes it, the reasoner tells you the next time you come back to this window.'),
    h('p', {}, h('b', {}, 'The assistant\'s model: '), status)),
  { size: 'lg', actions: [
    button('Open the assistant\'s model', () => { d.close(); openWorkspace(); }, { disabled: !meta.exists }),
    button('Send this model to the assistant…', () => { d.close(); saveWorkspace(); }),
    h('span', { class: 'spacer' })] });
}

// ---------------------------------------------------------------- help
function helpDialog() {
  const step = (n, t, x) => h('li', {}, h('b', {}, `${n} ${t}. `), x);
  infoDialog('How the reasoner works', h('div', { class: 'block help' },
    h('ol', { class: 'story' },
      step('1', 'Model', 'Draw the system: drag components from Add, wire output ports to input ports, drop guards and observation points onto edges. Select anything to read it in the inspector; Edit… or a double-click opens its dialog. A component\'s rows (what it does with failures) are under the canvas: Add row… walks you through one.'),
      step('2', 'Evidence', 'Drop logs (a recogniser turns their lines into witnesses) and certificates, or write either by hand with New witness… and New certificate…. The register says which are in force, rejected or stale, and why.'),
      step('3', 'Analysis', 'Run analysis: every switch vector of the rows that matter, in every firing order, goes through TLA+/TLC, then clingo keeps the candidates the evidence allows.'),
      step('4', 'Verdicts', 'Each observation point and failure gets guarantee, hope, exposed, unchecked, not exercised or conflict, with the reasons, a reaching run, and which guard to certify next.')),
    h('p', {}, 'The strip under the top bar shows the four steps and where each stands; 3 Analysis is how the verdicts are computed, 4 Verdicts is the answer. Assistant → Connect an assistant… lets Claude Code or Claude Desktop work on a model with you.'),
    h('span', { class: 'section-title' }, 'Shortcuts'),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Double-click'), h('dd', {}, 'edit what you clicked'),
      h('dt', {}, 'Enter'), h('dd', {}, 'edit the selection'),
      h('dt', {}, 'Delete / Backspace'), h('dd', {}, 'delete the selection (it asks first)'),
      h('dt', {}, 'Escape'), h('dd', {}, 'close a dialog (it asks before throwing edits away)'),
      h('dt', {}, 'Drag the background · scroll'), h('dd', {}, 'pan · zoom')),
    h('p', { class: 'hint' }, 'The full guide is docs/user-guide.md in the repository; the model document is described in docs/model-format.md.')), { size: 'md' });
}

// ---------------------------------------------------------------- start
async function main() {
  views = {
    model: new ModelView($('view-model')),
    evidence: new EvidenceView($('view-evidence')),
    analysis: new AnalysisView($('view-analysis')),
    verdicts: new VerdictsView($('view-verdicts')),
  };
  new FlowBar($('flow'));
  new VerdictBar($('verdictbar'));
  const tutorial = new Tutorial({ load: (doc, ev) => {
    S.caseId = null; S.bundle = null; S.stage = null; $('case-select').value = '';
    setDoc(normaliseDoc(doc), { ...emptyEvidence(), ...ev });
    drawStagebar();
    show('model');
  } });
  on('show', (v) => show(v));
  on('run', (o) => views.analysis.run(o));
  on('report', () => {
    if (S.analysis && S.analysis.report && S.view !== 'verdicts') {
      const t = document.querySelector('.tab[data-view="verdicts"]');
      if (t && !t.querySelector('.dot')) t.appendChild(h('span', { class: 'dot', 'aria-label': 'new verdicts' }));
    }
  });
  $('btn-run').addEventListener('click', () => views.analysis.run());
  $('file-import').addEventListener('change', (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; });
  const fileMenu = dropdown('File', [
    { label: 'New model…', hint: 'start from a blank canvas', onClick: newModel },
    { label: 'Import a model…', hint: 'YAML or JSON', onClick: () => $('file-import').click() },
    { label: 'Export the model as YAML', onClick: exportYaml },
    'sep',
    { label: 'Bootstrap from traces…', hint: 'spans and an MCP tools list', onClick: bootstrapDialog },
  ], { title: 'new, import, export, bootstrap' });
  const assistantMenu = dropdown('Assistant', [
    { label: 'Connect an assistant…', hint: 'use the reasoner from Claude Code or Claude Desktop (MCP)', onClick: connectDialog },
    'sep',
    { label: 'Open the assistant\'s model', hint: 'see what the assistant did; replaces the model here', onClick: openWorkspace },
    { label: 'Send this model to the assistant…', hint: 'the assistant works on it next; replaces its model', onClick: saveWorkspace },
  ], { title: 'work on a model together with an assistant (MCP)' });
  const helpMenu = dropdown('Help', () => [
    { label: 'Start the tour', hint: 'build a small system yourself and use every part of the reasoner', onClick: () => tutorial.start() },
    { label: 'How the reasoner works', hint: 'the four steps and the shortcuts', onClick: helpDialog },
    'sep',
    { label: 'Show all details', hint: 'levels, authority, ids, files, engine internals', checked: details(), onClick: () => setDetails(!details()) },
  ], { title: 'the tour, how the reasoner works, and how much it shows' });
  if (store('epa.details')) document.body.classList.add('details');
  on('details', () => { emit('doc'); emit('evidence'); });
  $('actions').prepend(fileMenu, assistantMenu, helpMenu);
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
  window.addEventListener('focus', watchWorkspace);
  watchWorkspace();
}

main().catch((e) => { console.error(e); toast(`Could not start: ${e.message}`); });
