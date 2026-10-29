// The tutorial's model and steps, pure data and functions (no DOM), so node can run them in tests:
// tests/test_tutorial.py replays every step and checks the verdict with the engine. tutorial.js shows
// them. One failure is followed throughout (a wrong value in the order log) through every answer the
// reasoner can give it: unchecked, exposed (A, always), guarantee (N, never), hope (S, sometimes).

export const CELL = 'value@o_order';
const DAY = '2026-10-29';

/** The tutorial's first model: request → parser → order, the order log on the last edge, one failure
 * mode (value) and worst-case defaults for every component. */
export function tutorialModel() {
  return {
    name: 'my-first-model', description: 'The tutorial: a parser turns a customer request into an order; we read the order log.',
    worst_case_defaults: 'all', modes: ['value'],
    lattices: { confidentiality: ['public', 'internal', 'confidential'], authority: ['none', 'user', 'admin'] },
    components: [{ id: 'parser', kind: 'deterministic', label: 'turns the request into an order', version: 'v1', in: ['request'], out: ['order'], pos: { x: 560, y: 200 } }],
    guards: [],
    edges: [{ id: 'e_request_parser', from: 'sys.request', to: 'parser.request' }, { id: 'e_parser_order', from: 'parser.order', to: 'sys.order' }],
    use_cases: [{ id: 'uc1', label: 'a customer sends a request', entries: [{ port: 'request', token: {} }] }],
    observation_points: [{ id: 'o_order', edge: 'e_parser_order', label: 'order log', tolerate: { value: 1 } }],
    claims: [],
    layout: { sys: { request: { x: 60, y: 205, dir: 'in' }, order: { x: 840, y: 205, dir: 'out' } } },
  };
}

const cert = (c) => ({ date: DAY, manual: true, ...c });

/** The steps: what to say, the button, how the model and the evidence change, and what the verdict means. */
export const STEPS = [
  { title: 'Build a tiny system', act: 'Build it',
    text: 'A parser turns a customer request into an order, and we can read the order log. The question: can a wrong value reach that log?',
    apply: () => ({ doc: tutorialModel(), ev: { certificates: [], witnesses: [], decisions: [] }, sel: { type: 'component', id: 'parser' } }),
    result: 'Nothing is known yet. The parser might get a value wrong never, sometimes or always (N, S, A), so the reasoner promises nothing.' },
  { title: 'A test report arrives', act: 'Add the test report',
    text: 'The test team finds that the parser drops the currency in every order. They write it down as a certificate: "always".',
    apply: ({ doc, ev }) => { ev.certificates.push(cert({ id: 'c_test', component: 'parser', rows: { 'order.value': 'always' }, version: 'v1', issuer: 'test team', method: 'integration tests: every order lost its currency' })); return { doc, ev }; },
    result: 'The failure reaches the log every time (A). That is a design problem to fix, not a risk to monitor.' },
  { title: 'The parser is fixed', act: 'Ship v2 and certify it',
    text: 'The team ships parser v2 and certifies it: the wrong value never happens.',
    apply: ({ doc, ev }) => {
      doc.components.find((c) => c.id === 'parser').version = 'v2';
      ev.certificates.push(cert({ id: 'c_fix', component: 'parser', rows: { 'order.value': 'never' }, version: 'v2', issuer: 'parser team', method: 'property-based tests of v2' }));
      return { doc, ev, sel: { type: 'component', id: 'parser' } };
    },
    result: 'The evidence rules the failure out (N). The test report is now stale: it was about v1.' },
  { title: 'An LLM joins', act: 'Add the LLM',
    text: 'Now an LLM writes the order draft before the parser reads it.',
    apply: ({ doc, ev }) => {
      doc.components.push({ id: 'writer', kind: 'llm', label: 'writes the order draft', in: ['request'], out: ['draft'], pos: { x: 270, y: 200 } });
      doc.edges = doc.edges.filter((e) => e.id !== 'e_request_parser');
      doc.edges.push({ id: 'e_request_writer', from: 'sys.request', to: 'writer.request' }, { id: 'e_writer_parser', from: 'writer.draft', to: 'parser.request' });
      return { doc, ev, sel: { type: 'component', id: 'writer' } };
    },
    result: 'An LLM can get a value wrong, and no certificate may say "never" for an LLM. So the failure may come sometimes or always (S, A).' },
  { title: 'A clean log line', act: 'Add the log line',
    text: 'The order log shows one order that came out right. A logged interaction is a witness.',
    apply: ({ doc, ev }) => { ev.witnesses.push({ id: 'w_clean', use_case: 'uc1', at: { o_order: { used: true, modes: { value: [0, 0] } } }, date: DAY, source: 'order log, line 1042', recogniser: 'manual', manual: true }); return { doc, ev }; },
    result: 'This order was fine, so the failure does not come every time. It can still come sometimes (S): watch the log.' },
  { title: 'Put a check in between', act: 'Add the check',
    text: 'A schema check between the LLM and the parser stops orders with a malformed value.',
    apply: ({ doc, ev }) => { doc.guards.push({ id: 'schema', edge: 'e_writer_parser', label: 'schema check', targets: [{ mode: 'value', threshold: 1, decidable: true }] }); return { doc, ev, sel: { type: 'guard', id: 'schema' } }; },
    result: 'The check helps only if it works, and nobody has vouched for it yet: the failure is ruled out or comes sometimes (N, S).' },
  { title: 'Certify the check', act: 'Certify it',
    text: 'The platform team certifies the schema check: it never lets a wrong value through.',
    apply: ({ doc, ev }) => { ev.certificates.push(cert({ id: 'c_schema', component: 'schema', targets: { value: 'never' }, issuer: 'platform team', method: 'the schema rejects every malformed amount' })); return { doc, ev }; },
    result: 'Ruled out again (N), whatever the LLM does: the certified check stops wrong values before the parser.' },
];

/** The verdict each step leads to, and its statuses (checked by tests/test_tutorial.py). */
export const EXPECTED = [['unchecked', 'N,S,A'], ['exposed', 'A'], ['guarantee', 'N'], ['unchecked', 'S,A'], ['hope', 'S'], ['unchecked', 'N,S'], ['guarantee', 'N']];
