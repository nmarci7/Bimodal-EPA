// The tour off the happy path, in headless Chrome over the DevTools protocol (no packages: Node 22+
// has WebSocket). usage: node tour_paths.mjs <base url> <chrome binary> <scratch dir> [scenario...]
// Prints one line per scenario and exits non-zero if any failed. tests/test_tour_browser.py runs it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [BASE, CHROME, SCRATCH, ...ONLY] = process.argv.slice(2);
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STORY = ['unchecked', 'exposed', 'guarantee', 'unchecked', 'hope', 'guarantee'];

const profile = mkdtempSync(join(SCRATCH, 'chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let targets = [];
for (let i = 0; i < 100 && !targets.length; i++) {
  try { targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page'); } catch (e) { /* not up yet */ }
  await sleep(150);
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const HELPERS = `
window.__st = () => import('/web/state.js');
window.__btn = (t) => [...document.querySelectorAll('.tutorial button')].find((b) => b.textContent.trim().startsWith(t));
window.__title = () => (document.querySelector('.tutorial h3') || {}).textContent;
window.__model = async () => { const { S } = await __st(); return {
  comps: S.doc.components.map((c) => c.kind), edges: S.doc.edges.length, guards: S.doc.guards.length, obs: S.doc.observation_points.length,
  certs: S.evidence.certificates.length, wits: S.evidence.witnesses.length, decs: S.evidence.decisions.length, view: S.view, name: S.doc.name }; };
`;

/** A fresh app, the tour started on its first step. */
async function start() {
  await send('Page.navigate', { url: BASE });
  await sleep(600);
  await js(`localStorage.clear(); localStorage.setItem('epa.wsSeen', '99999999999')`);
  await send('Page.navigate', { url: `${BASE}?nocase=1` });
  await sleep(1500);
  await js(HELPERS);
  await js(`document.querySelector('[aria-label="Help"]').click()`);
  await sleep(150);
  await js(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('Start the tour')).click()`);
  await sleep(300);
  await js(`(() => { const b = [...document.querySelectorAll('.dlg-backdrop button')].find((x) => x.textContent.trim() === 'Start'); if (b) b.click(); })()`);
  await sleep(700);
  await js(HELPERS);
}
const idle = async () => { for (let k = 0; k < 200; k++) { if (await js(`!(__btn('Working') || false)`)) return; await sleep(100); } throw new Error('still working after 20 s'); };
/** Press Do it for me and wait until it has finished. */
const press = async () => { await js(`__btn('Do it for me').click()`); await sleep(120); await idle(); await sleep(150); };
/** Next or Skip, whichever the step offers. */
const skip = async (n = 1) => { for (let k = 0; k < n; k++) { await js(`(__btn('Skip') || __btn('Next')).click()`); await sleep(60); } };
const title = () => js('__title()');
const model = () => js('__model()');
const note = () => js(`[...document.querySelectorAll('.tutorial .tut-note')].map((n) => n.textContent).join(' | ')`);
const verdict = () => js(`(document.querySelector('.tutorial .tut-result .v') || {}).textContent || null`);
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
/** Spam the button to the last step; returns the verdicts the run steps showed. */
async function spam() {
  const seen = [];
  for (let k = 0; k < 90; k++) {
    if (!(await js(`!!__btn('Do it for me')`))) break;
    await press();
    if ((await title()) === '✓ Run the analysis') seen.push(await verdict());
    const bad = await js(`[...document.querySelectorAll('.tutorial .tut-note.warn')].map((n) => n.textContent).join()`);
    check(!bad, `at "${await title()}": ${bad}`);
  }
  return seen;
}
/** Do it for me until step i is done: a press lands on the next step and does it. */
const pressTo = async (i) => { for (let k = 0; k < i; k++) await press(); };
const finalOk = async () => {
  const m = await model();
  check(m.comps.length === 2 && m.guards === 1 && m.certs === 3 && m.wits === 1 && m.decs === 1, `final model ${JSON.stringify(m)}`);
};
const stepCount = () => js(`import('/web/tutorial.js').then((m) => m.STEPS.length)`);
const titles = () => js(`import('/web/tutorial.js').then((m) => m.STEPS.map((s) => s.title))`);

const SCENARIOS = {
  async 'spam from the first step to the last'() {
    await start();
    const seen = await spam();
    check(JSON.stringify(seen) === JSON.stringify(STORY), `verdicts ${seen}`);
    await finalOk();
    check((await title()).includes('Simple or detailed'), `ended on ${await title()}`);
  },
  async 'three clicks at once do one thing at a time'() {
    await start();
    await skip(2);
    await js(`(() => { const b = __btn('Do it for me'); b.click(); b.click(); b.click(); })()`);
    await idle(); await sleep(300);
    const m = await model();
    check(m.comps.length === 1, `made ${m.comps.length} components`);
  },
  async 'skip to every step and press once'() {
    const n = await stepCount(), names = await titles();
    for (let i = 1; i < n; i++) {
      await start();
      await skip(i);
      await press();
      const t = await title();
      const bad = await js(`[...document.querySelectorAll('.tutorial .tut-note.warn')].map((x) => x.textContent).join()`);
      check(!bad, `step ${i} (${names[i]}): ${bad}`);
      const left = await js(`[...document.querySelectorAll('.tutorial .tut-note')].map((x) => x.textContent).join()`);
      check(!left.includes('Skipped'), `step ${i} (${names[i]}) left: ${left}`);
      const action = await js(`import('/web/tutorial.js').then((m) => !!m.STEPS[${i}].done)`);
      check(!action || t.startsWith('✓'), `step ${i} (${names[i]}) not done: on ${t}`);
    }
  },
  async 'skip everything, then spam from the guard'() {
    await start();
    const names = await titles();
    await skip(names.indexOf('Add a guard'));
    check((await note()).includes('Skipped'), 'no catch-up note');
    await press();
    check((await title()) === '✓ Add a guard', `on ${await title()}`);
    await spam();
    await finalOk();
  },
  async 'skip one step in the middle'() {
    await start();
    const names = await titles();
    await pressTo(names.indexOf('Open the evidence'));
    await skip(3);                                   // past the report and its run, onto "The bug is fixed"
    check((await title()) === 'The bug is fixed', `on ${await title()}`);
    check((await note()).includes('A test report'), `note: ${await note()}`);
    await press();
    check((await title()) === '✓ The bug is fixed', `on ${await title()}`);
    const seen = await spam();
    check(seen.join() === 'guarantee,unchecked,hope,guarantee', `verdicts ${seen}`);
    await finalOk();
  },
  async 'a skipped run is caught up by the verdict pages'() {
    await start();
    const names = await titles();
    await skip(names.indexOf('Why, and what to do'));
    await press();
    const m = await model();
    check(m.view === 'verdicts', `view ${m.view}`);
    check(await js(`(document.querySelector('#view-verdicts .cellbtn.active .f') || {}).textContent === 'value'`), 'value cell not selected');
    await sleep(700);
    check(await js(`!!document.querySelector('.tour-target')`), 'nothing outlined');
  },
  async 'a window left open is closed'() {
    await start();
    await pressTo((await titles()).indexOf('Open the evidence'));
    await skip(1);
    await js(`[...document.querySelectorAll('#view-evidence button')].find((b) => b.textContent.includes('New certificate')).click()`);
    await sleep(500);
    check(await js(`!!document.querySelector('.dlg-backdrop')`), 'the window did not open');
    await press();
    check(await js(`!document.querySelector('.dlg-backdrop')`), 'the window stayed open');
    check((await title()) === '✓ A test report', `on ${await title()}`);
  },
  async 'leaving for a demo case and coming back'() {
    await start();
    const names = await titles();
    await pressTo(names.indexOf('A test report'));
    const before = await model();
    await js(`(() => { const s = document.getElementById('case-select'); s.value = 'wallet'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(2000);
    check((await title()) === 'The tour is paused', `on ${await title()}`);
    await js(`__btn('Back to the tour').click()`);
    await sleep(900);
    const after = await model();
    check(after.name === 'my-first-model' && after.certs === before.certs && after.comps.length === before.comps.length, `came back to ${JSON.stringify(after)}`);
    await spam();
    await finalOk();
  },
  async 'another kind of component, the LLM first, and a stray box'() {
    await start();
    await skip(2);
    await js(`__st().then((m) => { m.addComponent('llm', 300, 200); m.addComponent('deterministic', 300, 500); m.addComponent('tool', 600, 200); m.addSysPort('in', 60, 200); m.addSysPort('out', 900, 200); m.connect('sys:input', 'planner'); m.connect('planner', 'tool'); m.connect('tool', 'sys:output'); })`);
    await sleep(700);
    await spam();
    const m = await model();
    check(m.certs === 3 && m.guards === 1 && m.comps.includes('tool'), `model ${JSON.stringify(m)}`);
    await js(`document.getElementById('btn-run').click()`);
    await sleep(3000);
    check(await js(`__st().then((m) => m.S.analysis.report.cells.find((c) => c.field === 'value').verdict)`) === 'guarantee', 'value is not a guarantee');
  },
  async 'deleting the component halfway'() {
    await start();
    const names = await titles();
    await pressTo(names.indexOf('Add an LLM'));
    await js(`__st().then((m) => { const d = m.cloneDoc(); const id = d.components.find((c) => c.kind !== 'llm').id; d.components = d.components.filter((c) => c.id !== id); d.edges = d.edges.filter((e) => !e.from.startsWith(id) && !e.to.startsWith(id)); d.observation_points = []; m.commitDoc(d, null); })`);
    await sleep(800);
    check((await note()).includes('Skipped'), `note: ${await note()}`);
    await spam();
    await js(`document.getElementById('btn-run').click()`);
    await sleep(3000);
    check(await js(`__st().then((m) => m.S.analysis.report.cells.find((c) => c.field === 'value').verdict)`) === 'guarantee', 'value is not a guarantee');
  },
  async 'the failure mode and the defaults removed'() {
    await start();
    await skip(2);
    await js(`__st().then((m) => { const d = m.cloneDoc(); d.modes = ['omission']; delete d.worst_case_defaults; m.commitDoc(d, null); })`);
    await sleep(500);
    const seen = await spam();
    check(JSON.stringify(seen) === JSON.stringify(STORY), `verdicts ${seen}`);
  },
  async 'a different certificate than the tour asked for'() {
    await start();
    const names = await titles();
    await pressTo(names.indexOf('Open the evidence'));
    await skip(1);
    await js(`__st().then((m) => { const c = m.S.doc.components[0]; m.S.evidence.certificates.push({ id: 'mine', component: c.id, rows: { ['default.' + c.id + '.' + c.out[0] + '.value']: 'sometimes' } }); m.emit('evidence'); })`);
    await sleep(700);
    await js(`document.getElementById('btn-run').click()`);
    await sleep(2000);
    await skip(1);
    check((await title()).includes('Run the analysis'), `on ${await title()}`);
    await sleep(600);
    const shown = await js(`(document.querySelector('.tutorial .tut-result') || {}).innerText || ''`);
    check(/differs from the tour/.test(shown), `result: ${shown}`);
    const seen = await spam();
    check(seen[seen.length - 1] === 'guarantee', `verdicts ${seen}`);
    await finalOk2();
  },
  async 'pressing while your own analysis runs'() {
    await start();
    const names = await titles();
    await pressTo(names.indexOf('Where you read a log'));
    await skip(1);
    await js(`document.getElementById('btn-run').click()`);
    await js(`__btn('Do it for me') && __btn('Do it for me').click()`);
    await idle(); await sleep(2000);
    check(await js(`__st().then((m) => !!m.S.analysis.report)`), 'no report');
  },
  async 'back, then forward again'() {
    await start();
    const names = await titles();
    await pressTo(names.indexOf('The bug is fixed'));
    await js(`__btn('Back').click()`); await sleep(100);
    await js(`__btn('Back').click()`); await sleep(100);
    await js(`__btn('Back').click()`); await sleep(100);
    const seen = await spam();
    check(seen[seen.length - 1] === 'guarantee', `verdicts ${seen}`);
    await finalOk();
  },
};

/** The certificates differ from the story's when the user wrote one of their own: one more, one more withdrawn. */
async function finalOk2() {
  const m = await model();
  check(m.comps.length === 2 && m.guards === 1 && m.certs === 4 && m.wits === 1 && m.decs === 2, `final model ${JSON.stringify(m)}`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
let failed = 0;
for (const [name, fn] of Object.entries(SCENARIOS)) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) continue;
  const t0 = Date.now();
  pageErrors.length = 0;
  try {
    await fn();
    if (pageErrors.length) throw new Error(`page errors: ${pageErrors[0]}`);
    console.log(`ok    ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${e.message.split('\n')[0]}`);
  }
}
ws.close();
chrome.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
