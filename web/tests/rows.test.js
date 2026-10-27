// The row helpers of the row dialog (web/rows.js), checked with node's own test runner.
// tests/test_web.py writes every row of the shipped models, with the kind epa/model/load.py gives
// it, to a JSON file and runs:  EPA_MODELS_JSON=<file> node --test web/tests/rows.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as R from '../rows.js';

const models = process.env.EPA_MODELS_JSON ? JSON.parse(fs.readFileSync(process.env.EPA_MODELS_JSON, 'utf8')) : [];

/** A row in one canonical spelling, so that two spellings of the same row compare equal. */
function canon(r) {
  const when = {};
  for (const [p, pat] of Object.entries(r.when || {})) when[p] = pat && typeof pat === 'object' ? Object.fromEntries(Object.entries(pat).map(([m, t]) => [m, Number(t)])) : 'any';
  const then = {};
  for (const [q, em] of Object.entries(r.then || {})) then[q] = R.isAsIs(em) ? 'as it is' : Object.fromEntries(Object.entries(em).map(([m, op]) => [m, R.formatOp(R.parseOp(op))]));
  const { id, label, activation, when: _w, then: _t, ...rest } = r;
  return { id, label: label || '', when, then, activation: activation || R.defaultActivation(R.rowKind(r)), ...rest };
}

test('the fixture lists the shipped models', () => {
  assert.ok(models.length >= 4, `models in the fixture: ${models.length}`);
  assert.ok(models.reduce((a, m) => a + m.components.reduce((b, c) => b + c.rows.length, 0), 0) >= 20);
});

test('every shipped row: the kind the engine gives it, no false problem, and an exact round trip', () => {
  for (const m of models) {
    const all = m.components.flatMap((c) => c.rows.map((r) => r.id));
    for (const c of m.components) {
      for (const r of c.rows) {
        const where = `${m.path}: ${c.id}.${r.id}`;
        const back = c.kinds[r.id];
        const expect = back === 'sink' ? 'sink' : back === 'fwd' ? 'forwarding' : Object.keys(r.when || {}).length ? 'failure' : 'internal';
        assert.equal(R.rowKind(r), expect, where);
        const draft = R.toDraft(r);
        const taken = new Set(all.filter((x) => x !== r.id));
        assert.deepEqual(R.draftProblems(draft, { comp: c, fields: m.fields, takenIds: taken }), [], where);
        assert.deepEqual(canon(R.fromDraft(draft, r)), canon(r), `${where} (round trip)`);
        assert.ok(R.rowSentence(r, c).length > 10, where);
      }
    }
  }
});

const agent = { id: 'agent', kind: 'llm', in: ['invoice', 'view'], out: ['request'] };
const wallet = { id: 'wallet', kind: 'deterministic', in: ['request', 'mandate'], out: ['instruction', 'presentation'] };
const fields = ['omission', 'commission', 'oom', 'dup', 'late', 'value'];
const ctxA = { comp: agent, fields, takenIds: new Set(['p_dup']) };
const ctxW = { comp: wallet, fields, takenIds: new Set() };
const draft = (over) => ({ id: 'r1', label: '', activation: 'open', kind: 'failure', when: [{ port: 'invoice', any: true, mode: '', threshold: 1 }], then: [{ port: 'request', asis: false, mode: 'oom', op: 'const', k: 9 }], ...over });

test('the checks name what the engine would reject, by step', () => {
  const by = (d, ctx) => R.draftProblemsByStep(d, ctx);
  assert.deepEqual(R.draftProblems(draft(), ctxA), []);
  assert.match(by(draft({ id: 'p_dup' }), ctxA).name.join(), /already called p_dup/);
  assert.match(by(draft({ id: '9x' }), ctxA).name.join(), /must start with a letter/);
  assert.match(by(draft({ activation: 'never' }), ctxA).name.join(), /LLM rule/);
  assert.match(by(draft({ kind: 'sink', then: [] }), ctxA).kind.join(), /LLM component passes nothing through/);
  assert.match(by(draft({ then: [{ port: 'request', asis: false, mode: 'oom', op: 'keep', k: 0 }] }), ctxA).effect.join(), /needs a failure in the condition/);
  assert.match(by(draft({ when: [{ port: '*', any: false, mode: 'late', threshold: 3 }] }), ctxA).trigger.join(), /name the port/);
  assert.match(by(draft({ when: [{ port: '*', any: true }, { port: 'view', any: true }] }), ctxA).trigger.join(), /stands alone/);
  assert.match(by(draft({ kind: 'internal', when: [], then: [{ port: 'request', asis: true }] }), ctxA).effect.join(), /internal fault/);
  assert.match(by(draft({ then: [{ port: 'nope', asis: false, mode: 'oom', op: 'const', k: 1 }] }), ctxA).effect.join(), /no output port nope/);
  assert.match(by(draft({ then: [{ port: 'request', asis: false, mode: 'oom', op: 'const', k: 11 }] }), ctxA).effect.join(), /0 to 10/);
  // a deterministic component may say never, and may absorb
  assert.deepEqual(R.draftProblems(draft({ activation: 'never', when: [{ port: 'request', any: true }], then: [{ port: 'instruction', asis: false, mode: 'dup', op: 'const', k: 2 }] }), ctxW), []);
  assert.deepEqual(R.draftProblems(draft({ kind: 'sink', when: [{ port: 'request', any: false, mode: 'late', threshold: 3 }], then: [] }), ctxW), []);
  assert.match(R.draftProblems(draft({ kind: 'sink', when: [{ port: 'request', any: true }], then: [] }), ctxW).join(), /sink names the failure/);
});

test('changing the kind keeps what fits', () => {
  const d = draft({ when: [{ port: 'view', any: false, mode: 'late', threshold: 3 }] });
  const internal = R.setKind(d, 'internal', agent, fields);
  assert.deepEqual(internal.when, []);
  assert.equal(internal.then[0].op, 'const');
  const fwd = R.setKind(d, 'forwarding', wallet, fields);
  assert.ok(fwd.when.every((c) => c.any) && fwd.then.every((e) => e.asis));
  assert.equal(fwd.activation, 'always');
  assert.equal(R.setKind(fwd, 'failure', wallet, fields).activation, 'open');
  const sink = R.setKind(draft({ when: [{ port: 'request', any: true }] }), 'sink', wallet, fields);
  assert.deepEqual(sink.then, []);
  assert.ok(sink.when.some((c) => !c.any));
});

test('the sentence says what the row does', () => {
  assert.equal(R.rowSentence({ id: 'p_dup', when: { view: { late: 3 } }, then: { request: { dup: 'const 9' } } }, agent),
    'When late ≥ 3 on view arrives, agent sends dup at 9 on request.');
  assert.equal(R.rowSentence({ id: 'f', when: { '*': 'any' }, then: { instruction: 'as it is', presentation: 'as it is' } }, wallet),
    'When a message on any input arrives, wallet forwards it as it is to instruction and presentation.');
  assert.equal(R.rowSentence({ id: 'i', when: {}, then: { request: { late: 'const 4' } } }, agent),
    'On its own, with no message arriving, agent sends late at 4 on request.');
  assert.equal(R.rowSentence({ id: 's', when: { request: { late: 3 } }, then: {} }, wallet),
    'When late ≥ 3 on request arrives, wallet absorbs it: nothing goes on.');
  assert.equal(R.rowSentence({ id: 'k', when: { view: { late: 2 } }, then: { request: { late: '+2', dup: 'keep' } } }, agent),
    'When late ≥ 2 on view arrives, agent sends late at the matched magnitude + 2 and dup at the matched magnitude on request.');
});

test('an LLM default is refined only by a row with the same trigger', () => {
  const c = { ...agent, in: ['invoice'], rows: [{ id: 'a', when: { invoice: 'any' }, then: { request: { late: 'const 4' } } }, { id: 'b', when: { invoice: { late: 2 } }, then: { request: { oom: 'const 9' } } }], drop_defaults: [{ port: 'request', mode: 'value', reason: 'x' }] };
  assert.deepEqual(R.llmDefaultStatus(c, 'request', 'late').refinedBy, ['a']);
  assert.equal(R.llmDefaultStatus(c, 'request', 'oom').status, 'active');
  assert.deepEqual(R.llmDefaultStatus(c, 'request', 'oom').beside, ['b']);
  assert.equal(R.llmDefaultStatus(c, 'request', 'value').status, 'dropped');
});
