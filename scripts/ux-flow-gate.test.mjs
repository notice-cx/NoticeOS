import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NEXT_STEPS } from './ux-gate.mjs';
import { decide } from './ux-gate-hook.mjs';
import {
  FLOW_BUDGET_FILE,
  FLOW_METRICS,
  FLOW_NEXT_STEPS,
  LEGACY_DEBT_EPIC,
  METRICS,
  RULE_METRICS,
  SURVEY_METRICS,
  auditBudgetHistory,
  budgetRaises,
  checkStatic,
  flowGateMessage,
  judgeResults,
  legacyDebtLine,
  lowerBudget,
  readBudget,
  serializeBudget,
  validateBudget,
} from './ux-flow-gate.mjs';
import { REFUSED, SAVED, Walk, awaitSaved, listsInPage, proseInPage, statusesInPage, viewInPage } from '../apps/tower/e2e/ux-walk.mjs';
import { FLOWS } from '../apps/tower/e2e/ux-flows.mjs';

// THE FLOW GATE HAS TO BE ABLE TO STOP SOMEBODY (bead `ro-ujb9.95`).
//
// Operator, 2026-09-23: "way too many steps where it's more natural just to
// add one more button or component to the current step than blowing the
// entire flow up with extra steps, duplicated checks"; "No duplicate statuses
// on the same screen"; lists repeating one subject are grouped under it; and a
// hard stop, not a doc. The browser walk (apps/tower/e2e/flow-gate.mjs, run by
// pnpm test:journeys) measures; this suite proves the judge, the ratchet and
// the record: a synthetic flow with an empty step, a duplicated check, a
// duplicate status or an ungrouped list fails with the message a stopped agent
// needs; the record only goes down; a raise needs an approved exception; a new
// flow carries no legacy allowance and must cite prior art; and the record's
// git history is audited like the text gate's.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const BASE = 'http://127.0.0.1:1';
const SHOTS = 'apps/tower/e2e/ux-flows-results/shots/synthetic/desktop';

const scratchRoots = [];
after(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A synthetic flow, walked by the real recorder over a scripted page
// ---------------------------------------------------------------------------
//
// The recorder (`Walk`) is the one the browser walk uses. Only the page is
// scripted: each screen says its URL, its guided step, and what the in-page
// probes find on it.

class ScriptedPage {
  constructor() {
    this.handlers = {};
    this.__uxRequests = { pending: new Map(), last: 0 };
    this.go({ path: '/' });
  }
  go({ path: at, view = null, prose = [], statuses = [], lists = [], refusal = null, saved = true }) {
    this.screen = { url: `${BASE}${at}`, view, prose, statuses, lists, refusal, saved };
  }
  on(event, handler) {
    (this.handlers[event] ??= []).push(handler);
  }
  request(method, at) {
    for (const handler of this.handlers.request ?? []) handler({ url: () => `${BASE}${at}`, method: () => method });
  }
  url() {
    return this.screen.url;
  }
  async evaluate(fn) {
    if (fn === viewInPage) return this.screen.view;
    if (fn === proseInPage) return this.screen.prose;
    if (fn === statusesInPage) return this.screen.statuses;
    if (fn === listsInPage) return this.screen.lists;
    return undefined;
  }
  async screenshot() {}
  async waitForLoadState() {}
  async waitForTimeout() {}
  /** A refusal on the screen (an error toast) is found by REFUSED only; a
   * confirmation appears unless the screen refused. Anything else is there. */
  locator(selector) {
    const shown = () => (selector === REFUSED ? this.screen.refusal !== null : selector === SAVED ? this.screen.saved && this.screen.refusal === null : true);
    const element = {
      waitFor: async () => { if (!shown()) throw new Error(`timeout waiting for ${selector}`); },
      isVisible: async () => shown(),
      innerText: async () => (selector === REFUSED ? this.screen.refusal ?? '' : ''),
    };
    return { ...element, first: () => element };
  }
}

/** A control the flow presses; `action` is what pressing it does to the page. */
const control = (action = () => {}) => ({
  waitFor: async () => {},
  evaluate: async () => ({ top: 10, bottom: 40, vh: 900 }),
  scrollIntoViewIfNeeded: async () => {},
  click: async () => action(),
  fill: async () => action(),
  selectOption: async () => action(),
});

const box = { x: 0, y: 0, w: 10, h: 10 };

async function walkSynthetic(script) {
  const page = new ScriptedPage();
  const w = new Walk({ page, flow: 'synthetic', viewport: 'desktop', base: BASE, dir: path.join(REPO_ROOT, SHOTS), repoRoot: REPO_ROOT });
  await script(w, page);
  return { schema: 'ux-walk/1', flows: { synthetic: { kind: 'flow', runs: { desktop: { ok: true, ...w.result() } } } } };
}

/** The clean synthetic flow: nav in, paste a key, Save (which verifies). */
async function cleanSteps(w, page) {
  await w.click(control(() => page.go({ path: '/connect', view: 'Connect' })), 'Connect Acme', { role: 'nav' });
  await w.fill(control(), 'key', 'API key', { paste: true });
  await w.click(control(() => { page.request('POST', '/api/integrations/acme/test'); page.go({ path: '/connect', view: 'Connected' }); }), 'Save and test', { role: 'commit' });
}

const REGISTRY = { synthetic: { title: 'Synthetic', priorArt: 'docs/briefs/setup.md#prior-art' } };
const clean = { actions: 3, screens: 3, pageChanges: 1, words: 0, emptySteps: 0, duplicatedChecks: 0, duplicateStatuses: 0, ungroupedRepeats: 0 };
const budgetOf = (entry = clean) => ({ legacyDebtEpic: LEGACY_DEBT_EPIC, flows: { synthetic: { desktop: { ...entry } } } });

function judged(results, budget = budgetOf()) {
  const verdict = judgeResults(results, budget, REGISTRY);
  return { ...verdict, message: flowGateMessage(verdict) };
}

test('the rules are the decided ones, and a new flow meets every rule at zero (changing one is an operator decision)', () => {
  assert.deepEqual([...FLOW_METRICS], ['actions', 'screens', 'pageChanges', 'words', 'emptySteps', 'duplicatedChecks', 'duplicateStatuses', 'ungroupedRepeats']);
  assert.deepEqual([...RULE_METRICS], ['emptySteps', 'duplicatedChecks', 'duplicateStatuses', 'ungroupedRepeats']);
  assert.deepEqual([...SURVEY_METRICS], ['duplicateStatuses', 'ungroupedRepeats']);
  assert.equal(METRICS.emptySteps.rule, 'no empty step');
  assert.equal(METRICS.duplicatedChecks.rule, 'check once');
  assert.equal(METRICS.duplicateStatuses.rule, 'one status per subject per screen');
  assert.equal(METRICS.ungroupedRepeats.rule, 'group lists by subject');
  assert.equal(LEGACY_DEBT_EPIC, 'ro-ujb9.96.7');
});

test('the instructions end the same way as the text gate\'s: research the best comparable, exceptions only by the operator', () => {
  const tail = (block) => block.split('\n').slice(block.split('\n').findIndex((line) => line.startsWith('  3.')));
  const flow = tail(FLOW_NEXT_STEPS);
  const text = tail(NEXT_STEPS);
  assert.equal(flow.length, text.length);
  assert.deepEqual(flow.slice(0, 3), text.slice(0, 3), 'the research instruction is word for word the text gate\'s');
  assert.deepEqual(flow.slice(3).map((line) => line.replaceAll('the step', 'the text').replace(FLOW_BUDGET_FILE, 'apps/tower/ux-budget.json')), text.slice(3));
  assert.match(FLOW_NEXT_STEPS, /add the control to the current step instead of a new step or screen/);
  assert.match(FLOW_NEXT_STEPS, /show one\s+status per subject, where the operator acts on it/);
  assert.match(FLOW_NEXT_STEPS, /group a list's repeated subject under one heading/);
});

// Bead ro-ujb9.96.7.28 removed the last two empty steps: a passing run names
// the debt while any is left, and says there is none once it is all gone —
// never a line of zeros "still held".
test('a passing summary names the legacy debt while any is left, and says when none is', () => {
  const zero = Object.fromEntries(RULE_METRICS.map((metric) => [metric, 0]));
  assert.equal(legacyDebtLine(zero, 'still held'), `No legacy debt left for epic ${LEGACY_DEBT_EPIC}.`);
  assert.equal(
    legacyDebtLine({ ...zero, emptySteps: 2 }, 'still held'),
    `Legacy debt still held for epic ${LEGACY_DEBT_EPIC}: ${RULE_METRICS.map((metric) => `${metric} ${metric === 'emptySteps' ? 2 : 0}`).join(', ')}.`,
  );
  // The recorded budget holds none today, and debt never comes back.
  const budget = readBudget(REPO_ROOT);
  const held = RULE_METRICS.reduce((sum, metric) => sum + Object.values(budget.flows)
    .flatMap((viewports) => Object.values(viewports)).reduce((total, entry) => total + (entry[metric] ?? 0), 0), 0);
  assert.equal(held, 0);
});

test('a clean synthetic flow passes', async () => {
  const results = await walkSynthetic(async (w, page) => {
    await cleanSteps(w, page);
    await w.end('connected');
  });
  const run = results.flows.synthetic.runs.desktop;
  assert.equal(run.actions, 3);
  assert.equal(run.emptySteps, 0);
  assert.equal(judged(results).message, '');
});

// A SAVE IS A CONFIRMATION, NEVER JUST A TOAST (bead ro-nuz9). The TV layout's
// first Save on a fresh install was refused with "Changed elsewhere", and the
// arrange-wall walk passed, because it waited for any toast.
test('a refusal fails the walk in its own words: waited for, or still on screen at the end', async () => {
  const refused = 'Changed elsewhere — reload to see the current value';
  await assert.rejects(
    walkSynthetic(async (w, page) => {
      await cleanSteps(w, page);
      page.go({ path: '/connect', view: 'Connected', refusal: refused });
      await awaitSaved(w, 'Save → saved');
    }),
    (err) => err.message === `Save → saved: refused — ${refused}`,
  );
  await assert.rejects(
    walkSynthetic(async (w, page) => {
      await cleanSteps(w, page);
      page.go({ path: '/connect', view: 'Connected', refusal: refused });
      await w.end('saved');
    }),
    (err) => err.message === `the walk ended on a refusal: ${refused}`,
  );
  await assert.rejects(
    walkSynthetic(async (w, page) => {
      await cleanSteps(w, page);
      page.go({ path: '/connect', view: 'Connected', saved: false });
      await awaitSaved(w, 'Save → saved');
    }),
    (err) => err.message === 'Save → saved: no confirmation in 15 s',
  );
  // A confirmation passes, and so does the walk that ends on it.
  const results = await walkSynthetic(async (w, page) => {
    await cleanSteps(w, page);
    await awaitSaved(w, 'Save → saved');
    await w.end('saved');
  });
  assert.equal(results.flows.synthetic.runs.desktop.waits, 1);
});

test('an empty "Continue" step fails, naming the flow, viewport, rule, step, screen, numbers and screenshot', async () => {
  const results = await walkSynthetic(async (w, page) => {
    await cleanSteps(w, page);
    // A confirmation screen that asks nothing, left by Continue.
    await w.click(control(() => page.go({ path: '/connect', view: 'All set' })), 'Continue', { role: 'advance' });
    await w.end('done');
  });
  const run = results.flows.synthetic.runs.desktop;
  assert.equal(run.emptySteps, 1);
  const { increases, message } = judged(results);
  assert.deepEqual(increases.map(({ metric, measured, allowed }) => [metric, measured, allowed]), [
    ['actions', 4, 3],
    ['screens', 4, 3],
    ['emptySteps', 1, 0],
  ]);
  assert.match(message, /^UX flow gate: synthetic · desktop breaks 3 rules \(bead ro-ujb9\.95\)\./);
  assert.match(message, /✗ no empty step — empty steps: 1 measured, budget 0/);
  assert.match(message, /step 4 "Continue" left \/connect \[Connected\] \(for \/connect \[All set\]\) with nothing entered or decided on it/);
  assert.ok(message.includes(`screenshot: ${SHOTS}/04-click-continue.jpg`));
  assert.match(message, /✗ steps only go down — actions \(clicks, fields, selects\): 4 measured, budget 3/);
  assert.match(message, /on \/connect \[Connected\]: 4 "Continue" \(advance\)/);
  assert.match(message, /✗ steps only go down — screens: 4 measured, budget 3\n {6}1\. \/ \(where the flow starts\)/);
  assert.match(message, /4\. \/connect \[All set\] — opened by step 4 "Continue"/);
  assert.ok(message.trim().endsWith(FLOW_NEXT_STEPS), 'every design failure ends with the fixed instructions');
});

test('the same status twice for one subject on one screen fails; the same status for two subjects does not', async () => {
  const connected = (subject, kind = 'chip') => ({ label: 'Connected', kind, subject, box });
  const results = await walkSynthetic(async (w, page) => {
    await cleanSteps(w, page);
    page.go({ path: '/connect', view: 'Connected', statuses: [
      connected('integration:acme'), connected('integration:acme', 'status-text'), connected('integration:other'),
    ] });
    await w.end('connected');
  });
  const run = results.flows.synthetic.runs.desktop;
  assert.equal(run.duplicateStatuses, 1, 'acme twice is one duplicate; other once is fine');
  const { message } = judged(results);
  assert.match(message, /✗ one status per subject per screen — duplicate statuses: 1 measured, budget 0/);
  assert.match(message, /"Connected" shown 2× for integration:acme on \/connect \[Connected\] \(chip, status-text\)/);
  assert.match(message, /screenshot \(each copy ringed\): apps\/tower\/e2e\/ux-flows-results\/shots\/synthetic\/desktop\/\d+-m1-dup-connected\.jpg/);
  assert.ok(message.trim().endsWith(FLOW_NEXT_STEPS));
});

test('a list that repeats one subject fails; a chronological one is exempt', async () => {
  const repeat = { subject: 'Meals.example', properties: ['Error count', 'Replay sessions', 'Backlinks'], boxes: [box, box, box] };
  const results = await walkSynthetic(async (w, page) => {
    await cleanSteps(w, page);
    page.go({ path: '/connect', view: 'Connected', lists: [
      { name: 'Signals', items: 3, exempt: false, subjects: ['Meals.example', 'Meals.example', 'Meals.example'], repeats: [repeat] },
      { name: 'Activity', items: 3, exempt: true, subjects: ['Meals.example', 'Meals.example', 'Meals.example'], repeats: [repeat] },
    ] });
    await w.end('connected');
  });
  assert.equal(results.flows.synthetic.runs.desktop.ungroupedRepeats, 1);
  const { message } = judged(results);
  assert.match(message, /✗ group lists by subject — ungrouped repeated subjects: 1 measured, budget 0/);
  assert.match(message, /list "Signals" on \/connect \[Connected\] repeats "Meals\.example" on 3 items: Error count \/ Replay sessions \/ Backlinks/);
  assert.doesNotMatch(message, /list "Activity"/);
  assert.ok(message.trim().endsWith(FLOW_NEXT_STEPS));
});

test('checking twice fails: a repeated verification request, a repeated verify step, a repeated dialog', async () => {
  const results = await walkSynthetic(async (w, page) => {
    await cleanSteps(w, page);
    await w.click(control(() => page.request('POST', '/api/integrations/acme/test')), 'Test connection', { role: 'verify' });
    await w.click(control(() => page.request('POST', '/api/integrations/acme/test')), 'Test connection', { role: 'verify' });
    await w.end('connected');
  });
  const run = results.flows.synthetic.runs.desktop;
  assert.deepEqual(run.duplicatedCheckList.map((entry) => entry.kind).sort(), ['repeated request', 'repeated step']);
  const { message } = judged(results, budgetOf({ ...clean, actions: 5 }));
  assert.match(message, /✗ check once — duplicated checks: 2 measured, budget 0/);
  assert.match(message, /repeated request: POST \/api\/integrations\/acme\/test \(step 3, 4, 5\)/);
});

test('step counts only go down: one more action fails; one fewer asks for ux:flows:baseline, not a redesign', async () => {
  const results = await walkSynthetic(async (w, page) => {
    await cleanSteps(w, page);
    await w.end('connected');
  });
  const tighter = judged(results, budgetOf({ ...clean, actions: 2 }));
  assert.match(tighter.message, /actions \(clicks, fields, selects\): 3 measured, budget 2/);
  assert.ok(tighter.message.trim().endsWith(FLOW_NEXT_STEPS));
  const looser = judged(results, budgetOf({ ...clean, actions: 5, emptySteps: 1 }));
  assert.deepEqual(looser.increases, []);
  assert.match(looser.message, /flows cost less than apps\/tower\/ux-flows\.json records/);
  assert.match(looser.message, /synthetic · desktop {2}actions 5 → 3/);
  assert.match(looser.message, /synthetic · desktop {2}emptySteps 1 → 0/);
  assert.match(looser.message, /pnpm ux:flows:baseline/);
  assert.ok(!looser.message.includes('What to do next'), 'a stale record is bookkeeping, not a design failure');
});

test('a walk that cannot finish fails the gate and says to change the walk with the flow', () => {
  const results = { flows: { synthetic: { runs: { desktop: { ok: false, error: 'locator.click: Timeout 15000ms exceeded.',
    failedAfter: { n: 4, label: 'Continue', screen: '/connect [Choose assets]' }, failureShot: `${SHOTS}/05-failed-failure.jpg` } } } } };
  const { walkFailures, message } = judged(results);
  assert.equal(walkFailures.length, 1);
  assert.match(message, /the walk of synthetic · desktop could not finish/);
  assert.match(message, /after step 4 "Continue" on \/connect \[Choose assets\]: locator\.click: Timeout/);
  assert.match(message, /A flow is never deleted to get past the gate/);
  assert.ok(message.trim().endsWith(FLOW_NEXT_STEPS));
});

// ---------------------------------------------------------------------------
// New flows: no legacy allowance, prior art required
// ---------------------------------------------------------------------------

const BRIEF = `# Brief

## Prior art

- Grafana: https://grafana.com/a
- Zapier: https://zapier.com/b
- Stripe: https://stripe.com/c

## Two links only

https://example.com/a and https://example.com/b
`;
const reader = (files) => (rel) => (rel in files ? files[rel] : null);
const briefs = reader({ 'docs/briefs/setup.md': BRIEF });

test('a NEW flow carries no legacy allowance: one empty step fails; a clean one only needs recording', async () => {
  const withEmpty = await walkSynthetic(async (w, page) => {
    await cleanSteps(w, page);
    await w.click(control(() => page.go({ path: '/connect', view: 'All set' })), 'Continue', { role: 'advance' });
    await w.end('done');
  });
  const empty = { legacyDebtEpic: LEGACY_DEBT_EPIC, flows: {} };
  const failed = judged(withEmpty, empty);
  assert.match(failed.message, /synthetic · desktop breaks a rule — a new flow carries no legacy allowance/);
  assert.match(failed.message, /no empty step — empty steps: 1 measured, budget 0/);

  const cleanRun = await walkSynthetic(async (w, page) => {
    await cleanSteps(w, page);
    await w.end('connected');
  });
  const pending = judged(cleanRun, empty);
  assert.deepEqual(pending.increases, []);
  assert.match(pending.message, /new flows meet every rule but have no record yet/);
  assert.match(pending.message, /pnpm ux:flows:baseline/);

  // ux:flows:baseline records it only with valid prior art and zero rule counts.
  const recorded = lowerBudget(empty, cleanRun, REGISTRY, { readFile: briefs });
  assert.deepEqual(recorded.next.flows.synthetic.desktop, clean);
  assert.equal(recorded.added.length, 1);
  const unresearched = lowerBudget(empty, cleanRun, { synthetic: { priorArt: 'docs/briefs/setup.md#two-links-only' } }, { readFile: briefs });
  assert.deepEqual(unresearched.next.flows, {}, 'a flow without three researched comparables is never recorded');
  assert.deepEqual(lowerBudget(empty, withEmpty, REGISTRY, { readFile: briefs }).next.flows, {}, 'a flow that breaks a rule is never recorded');
});

test('a flow without researched prior art fails the static check', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ux-flow-gate-')));
  scratchRoots.push(root);
  mkdirSync(path.join(root, 'docs/briefs'), { recursive: true });
  mkdirSync(path.join(root, 'apps/tower'), { recursive: true });
  writeFileSync(path.join(root, 'docs/briefs/setup.md'), BRIEF);
  writeFileSync(path.join(root, FLOW_BUDGET_FILE), serializeBudget(budgetOf()));
  const statics = await checkStatic({ root, prefixes: ['ro'], registry: {
    synthetic: { priorArt: 'docs/briefs/setup.md#prior-art' },
    unresearched: { priorArt: 'docs/briefs/setup.md#two-links-only' },
    uncited: {},
  } });
  assert.deepEqual(statics.priorArt.map(({ flow }) => flow), ['unresearched', 'uncited']);
  const message = flowGateMessage({ statics });
  assert.match(message, /every flow in apps\/tower\/e2e\/ux-flows\.mjs must cite its research/);
  assert.match(message, /unresearched: priorArt docs\/briefs\/setup\.md#two-links-only cites 2 source link/);
  assert.match(message, /uncited: priorArt must cite the research/);
  assert.ok(message.trim().endsWith(FLOW_NEXT_STEPS));

  const orphan = await checkStatic({ root, prefixes: ['ro'], registry: {} });
  assert.deepEqual(orphan.orphaned, ['synthetic']);
  assert.match(flowGateMessage({ statics: orphan }), /holds budgets for flows apps\/tower\/e2e\/ux-flows\.mjs no longer walks/);
});

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

const approved = {
  approvedBy: 'ro-abcd.1',
  kind: 'destructive-confirmation',
  reason: 'the typed name guards deleting every stored secret',
  priorArt: 'docs/briefs/setup.md#prior-art',
};

test('ux:flows:baseline only lowers: never raises, keeps approvals, skips unfinished walks', async () => {
  const results = await walkSynthetic(async (w, page) => {
    await cleanSteps(w, page);
    await w.click(control(() => page.go({ path: '/connect', view: 'All set' })), 'Continue', { role: 'advance' });
    await w.end('done');
  });
  const budget = budgetOf({ ...clean, actions: 6, screens: 3, emptySteps: 2, ...approved });
  const { next, changes } = lowerBudget(budget, results, REGISTRY, { readFile: briefs });
  const entry = next.flows.synthetic.desktop;
  assert.equal(entry.actions, 4, 'lowered to the measurement');
  assert.equal(entry.emptySteps, 1, 'lowered to the measurement');
  assert.equal(entry.screens, 3, 'measured 4, never raised');
  assert.equal(entry.approvedBy, 'ro-abcd.1');
  assert.deepEqual(changes, ['synthetic · desktop: actions 6 → 4', 'synthetic · desktop: emptySteps 2 → 1']);
  const unfinished = { flows: { synthetic: { runs: { desktop: { ok: false, actions: 1, screens: 1 } } } } };
  assert.deepEqual(lowerBudget(budget, unfinished, REGISTRY, { readFile: briefs }).changes, [], 'a partial walk measures nothing');
});

test('a raise needs a fresh, complete exception from the closed set', () => {
  const previous = budgetOf();
  const raised = (extra) => budgetOf({ ...clean, actions: 4, ...extra });
  const check = (next, prev = previous) => budgetRaises(prev, next, { prefixes: ['ro'], readFile: briefs });
  const [bare] = check(raised({}));
  assert.match(bare, /synthetic · desktop: actions 3 → 4 is a raise without a valid exception/);
  assert.match(check(raised({ ...approved, kind: 'onboarding' }))[0], /exceptions exist only for trust, safety, legal or destructive-confirmation/);
  assert.match(check(raised({ ...approved, approvedBy: 'ask-operator' }))[0], /approvedBy/);
  assert.match(check(raised({ ...approved, priorArt: 'docs/briefs/setup.md#two-links-only' }))[0], /cites 2 source link/);
  assert.match(check(raised({ ...approved, reason: 'ok' }))[0], /reason/);
  assert.deepEqual(check(raised(approved)), []);
  assert.match(check(budgetOf({ ...clean, actions: 5, ...approved }), raised(approved))[0], /reuses the approval/);
  assert.deepEqual(check(budgetOf({ ...clean, actions: 2 })), [], 'a lowering needs no approval');
});

test('a flow enters the record only at zero rule counts, and leaves it only through "retired"', () => {
  const check = (next, prev) => budgetRaises(prev, next, { prefixes: ['ro'], readFile: briefs });
  const empty = { legacyDebtEpic: LEGACY_DEBT_EPIC, flows: {} };
  assert.deepEqual(check(budgetOf(), empty), []);
  assert.match(check(budgetOf({ ...clean, emptySteps: 1 }), empty)[0], /enters the record with legacy allowance \(emptySteps 1\); a new flow meets every rule at zero/);
  assert.match(check(empty, budgetOf())[0], /synthetic was dropped from the record \(no "retired" record\)/);
  const retired = { ...empty, retired: { synthetic: { approvedBy: 'ro-abcd.2', reason: 'the product no longer has this flow' } } };
  assert.deepEqual(check(retired, budgetOf()), []);
  assert.match(check({ ...empty, retired: { synthetic: { approvedBy: 'ro-abcd.2', reason: 'gone' } } }, budgetOf())[0], /reason/);
});

test('the record schema refuses unknown keys, wrong shapes, bad counts and half an exception', () => {
  const check = (budget) => validateBudget(budget, { prefixes: ['ro'], readFile: briefs });
  assert.deepEqual(check(budgetOf()), []);
  assert.deepEqual(check(budgetOf({ ...clean, ...approved })), []);
  assert.deepEqual(check({ legacyDebtEpic: LEGACY_DEBT_EPIC, flows: { survey: { phone: { duplicateStatuses: 1, ungroupedRepeats: 4 } } } }), []);
  assert.match(check(budgetOf({ ...clean, note: 'x' }))[0], /unknown key "note"/);
  assert.match(check(budgetOf({ ...clean, actions: -1 }))[0], /actions must be a whole number/);
  assert.match(check(budgetOf({ actions: 3 }))[0], /must record every one of/);
  assert.match(check({ ...budgetOf(), legacyDebtEpic: 'someday' })[0], /legacyDebtEpic/);
  assert.match(check({ legacyDebtEpic: LEGACY_DEBT_EPIC, flows: { synthetic: { tablet: clean } } })[0], /unknown viewport "tablet"/);
  assert.ok(check(budgetOf({ ...clean, approvedBy: 'ro-abcd.1' })).some((error) => /priorArt/.test(error)));
});

// ---------------------------------------------------------------------------
// A scratch checkout: the pre-commit hook and the history audit
// ---------------------------------------------------------------------------

function isolatedEnv(root) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.CI;
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, '.home', '.gitconfig'),
    GIT_CEILING_DIRECTORIES: path.dirname(root),
    GIT_AUTHOR_NAME: 'Flow Gate Test',
    GIT_AUTHOR_EMAIL: 'flow-gate@example.invalid',
    GIT_COMMITTER_NAME: 'Flow Gate Test',
    GIT_COMMITTER_EMAIL: 'flow-gate@example.invalid',
  };
}

function scratchCheckout() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ux-flow-gate-')));
  scratchRoots.push(root);
  for (const dir of ['.home', 'scripts', 'config', '.githooks', 'docs/briefs', 'apps/tower']) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, '.home', '.gitconfig'), '');
  for (const file of ['ux-gate.mjs', 'ux-flow-gate.mjs', 'installation.mjs', 'product-env.mjs']) copyFileSync(path.join(SCRIPTS_DIR, file), path.join(root, 'scripts', file));
  copyFileSync(path.join(REPO_ROOT, '.githooks/pre-commit'), path.join(root, '.githooks/pre-commit'));
  writeFileSync(path.join(root, 'config/beads.json'), JSON.stringify({ spokes: [{ prefix: 'ro' }] }));
  writeFileSync(path.join(root, 'docs/briefs/setup.md'), BRIEF);
  writeFileSync(path.join(root, FLOW_BUDGET_FILE), serializeBudget(budgetOf()));
  const env = isolatedEnv(root);
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  };
  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['config', 'core.hooksPath', '.githooks']);
  run('git', ['config', 'commit.gpgsign', 'false']);
  run('git', ['add', '-A']);
  const first = run('git', ['commit', '-q', '-m', 'scratch: introduce the flow gate']);
  assert.equal(first.status, 0, first.stderr);
  return { root, run };
}

const writeBudget = (checkout, budget) => writeFileSync(path.join(checkout.root, FLOW_BUDGET_FILE), serializeBudget(budget));

test('pre-commit: an unapproved raise of the record fails git commit with the instructions; a lowering commits', () => {
  const checkout = scratchCheckout();
  writeBudget(checkout, budgetOf({ ...clean, actions: 4, emptySteps: 1 }));
  checkout.run('git', ['add', FLOW_BUDGET_FILE]);
  const raise = checkout.run('git', ['commit', '-q', '-m', 'raise the flow record']);
  assert.notEqual(raise.status, 0, 'the pre-commit hook must refuse the raise');
  assert.match(raise.stderr, /apps\/tower\/ux-flows\.json was raised without a valid exception/);
  assert.match(raise.stderr, /synthetic · desktop: actions 3 → 4, emptySteps 0 → 1 is a raise without a valid exception/);
  assert.ok(raise.stderr.trim().endsWith(FLOW_NEXT_STEPS));

  writeBudget(checkout, budgetOf({ ...clean, actions: 2 }));
  checkout.run('git', ['add', FLOW_BUDGET_FILE]);
  const lower = checkout.run('git', ['commit', '-q', '-m', 'lower the flow record']);
  assert.equal(lower.status, 0, lower.stderr);

  checkout.run('git', ['rm', '-q', FLOW_BUDGET_FILE]);
  const deletion = checkout.run('git', ['commit', '-q', '-m', 'delete the flow record']);
  assert.notEqual(deletion.status, 0);
  assert.match(deletion.stderr, /staged for deletion/);
});

test('history audit: an approved raise with its research passes; a raise committed past the hook is found', () => {
  const checkout = scratchCheckout();
  writeBudget(checkout, budgetOf({ ...clean, actions: 4, ...approved }));
  checkout.run('git', ['add', FLOW_BUDGET_FILE]);
  const ok = checkout.run('git', ['commit', '-q', '-m', 'approved exception']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(auditBudgetHistory(checkout.root).violations, []);

  writeBudget(checkout, budgetOf({ ...clean, actions: 6, ...approved }));
  checkout.run('git', ['add', FLOW_BUDGET_FILE]);
  // What an agent that ignored AGENTS.md would do. The audit still finds it.
  const bypassed = checkout.run('git', ['commit', '-q', '--no-verify', '-m', 'sneak a raise in']);
  assert.equal(bypassed.status, 0, bypassed.stderr);
  const { violations } = auditBudgetHistory(checkout.root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /actions 4 → 6 reuses the approval of an earlier raise/);

  writeBudget(checkout, { legacyDebtEpic: LEGACY_DEBT_EPIC, flows: {} });
  checkout.run('git', ['add', FLOW_BUDGET_FILE]);
  checkout.run('git', ['commit', '-q', '--no-verify', '-m', 'drop the flow']);
  assert.ok(auditBudgetHistory(checkout.root).violations.some((violation) => /synthetic was dropped from the record/.test(violation)));
});

describe('the Claude Code hook guards the flow record like the text record', () => {
  const file = path.join(REPO_ROOT, FLOW_BUDGET_FILE);
  test('PreToolUse: an edit or a shell write to apps/tower/ux-flows.json exits 2', () => {
    for (const event of [
      { tool_name: 'Edit', tool_input: { file_path: file, old_string: '"actions": 12', new_string: '"actions": 13' } },
      { tool_name: 'Write', tool_input: { file_path: file, content: '{}' } },
      { tool_name: 'Bash', tool_input: { command: `echo '{}' > ${FLOW_BUDGET_FILE}` } },
    ]) {
      const verdict = decide('pre', { hook_event_name: 'PreToolUse', ...event });
      assert.equal(verdict.code, 2, JSON.stringify(event));
      assert.match(verdict.stderr, /apps\/tower\/ux-flows\.json/);
      assert.match(verdict.stderr, /pnpm ux:flows:baseline/);
    }
    assert.equal(decide('pre', { tool_name: 'Bash', tool_input: { command: 'pnpm ux:flows:baseline' } }).code, 0);
  });
});

// ---------------------------------------------------------------------------
// The committed registry and record (the CI gate's static half)
// ---------------------------------------------------------------------------

test('every declared flow cites prior art and is a flow or the survey', () => {
  assert.ok(Object.keys(FLOWS).length >= 17, 'the audit\'s flows and the survey are all declared');
  for (const [id, flow] of Object.entries(FLOWS)) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.equal(typeof flow.title, 'string', `${id} has a title`);
    assert.equal(typeof flow.setup, 'function', `${id} has a setup`);
    assert.equal(typeof flow.run, 'function', `${id} has a walk`);
    assert.ok([undefined, 'flow', 'survey'].includes(flow.kind), `${id} kind`);
  }
});

test('the committed record is well-formed, its history clean, and it budgets exactly the declared flows (bead ro-ujb9.95)', async () => {
  const budget = readBudget(REPO_ROOT);
  assert.ok(budget, `${FLOW_BUDGET_FILE} must exist`);
  assert.equal(budget.legacyDebtEpic, LEGACY_DEBT_EPIC, 'the record names the epic that removes its legacy counts');
  assert.match(budget.about, /LEGACY DEBT, not an allowance/);
  const statics = await checkStatic({ root: REPO_ROOT, registry: FLOWS });
  assert.equal(flowGateMessage({ statics }), '', `\n${flowGateMessage({ statics })}`);
  assert.deepEqual(Object.keys(budget.flows).sort(), Object.keys(FLOWS).sort(), 'every declared flow has a record, and no record lacks a flow');
  for (const [id, viewports] of Object.entries(budget.flows)) {
    assert.deepEqual(Object.keys(viewports), ['desktop', 'phone'], `${id} is budgeted at desktop and phone`);
  }
  assert.equal(readFileSync(path.join(REPO_ROOT, FLOW_BUDGET_FILE), 'utf8'), serializeBudget(budget), 'the record is in its canonical form');
});
