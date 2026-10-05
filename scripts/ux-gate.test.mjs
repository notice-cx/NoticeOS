import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACCESSIBLE_NAME_WORD_BUDGET,
  BASELINE_FILE,
  EXCEPTION_KINDS,
  FAILURE_WORD_BUDGET,
  LABEL_WORD_BUDGET,
  LEGACY_SETTINGS,
  NEXT_STEPS,
  NOT_DESK_COPY,
  RETIRED_TERMS,
  SETTINGS,
  SETTINGS_FILE,
  auditBaselineHistory,
  auditSettingsHistory,
  baselineRaises,
  checkTower,
  compareToBaseline,
  countWords,
  extractVisibleStrings,
  gateFiles,
  gateMessage,
  importSpecifiers,
  introducedSince,
  isBeadId,
  loadTypeScript,
  lowerBaseline,
  markdownSection,
  measure,
  overBudget,
  priorArtProblems,
  retiredTermHits,
  serializeBaseline,
  settingsLoosenings,
  towerFiles,
  traceScope,
  validateBaseline,
  validateSettings,
  workingTree,
} from './ux-gate.mjs';
import { PROTECTED_FILES, PROTECTED_MESSAGE, PROTECTED_SETTINGS_MESSAGE, decide, shellWrites } from './ux-gate-hook.mjs';
import { installGitHooks } from './install-git-hooks.mjs';

// THE UX GATE HAS TO BE ABLE TO STOP SOMEBODY (bead `ro-ujb9.94`).
//
// The operator's rule (2026-09-23): an interaction that needs a paragraph of
// explanation is a flow to redesign, and "any agent who does work on UX in the
// future encounters a hard stop when coming up with something non-conforming,
// instead of counting on agents to read docs". This suite is that stop in CI
// (`pnpm test:scripts`) and the proof that the other two stops — the
// pre-commit hook and the Claude Code edit hook — bite on the same paragraph.
//
// HELPER is the acceptance criterion's "20-word helper paragraph": it must fail
// every place it can be written.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const ts = loadTypeScript([REPO_ROOT]);

const HELPER =
  'Before you connect a source, read this: the numbers below only update after the nightly job has run successfully twice.';
const LEGACY =
  'This older paragraph was written before the gate existed and it explains far too much for a label.';

const words = (n, word = 'word') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const extract = (source, file = 'apps/tower/src/Panel.tsx') => extractVisibleStrings(source, file, ts);
const over = (source, file) => overBudget(extract(source, file));

const scratchRoots = [];
after(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The budgets
// ---------------------------------------------------------------------------

test('the budgets are the decided ones (changing one is an operator decision, not a fix)', () => {
  assert.equal(LABEL_WORD_BUDGET, 12);
  assert.equal(FAILURE_WORD_BUDGET, 18);
  assert.equal(ACCESSIBLE_NAME_WORD_BUDGET, 24);
  assert.equal(countWords(HELPER), 20, 'HELPER is the acceptance criterion\'s 20-word paragraph');
  assert.equal(countWords(LEGACY), 18);
});

test('words are tokens with a letter or digit; separators are not; an interpolation is one', () => {
  assert.equal(countWords('Search clicks · 28d — ▲ 4%'), 4);
  assert.equal(countWords('${…} of ${…} sources'), 4);
  assert.equal(countWords('   '), 0);
});

// ---------------------------------------------------------------------------
// What is visible: the 20-word helper fails wherever it is written
// ---------------------------------------------------------------------------

describe('a 20-word helper paragraph is explanatory prose wherever it is written', () => {
  const cases = [
    ['JSX text', `export const A = () => <p>${HELPER}</p>;`, '<p> text'],
    ['a helper prop', `export const A = () => <SectionCard hint="${HELPER}" />;`, 'hint='],
    ['a prop nobody has invented yet', `export const A = () => <Panel blurb="${HELPER}" />;`, 'blurb='],
    ['a string child expression', `export const A = () => <div>{"${HELPER}"}</div>;`, '<div> text'],
    ['a template literal', 'export const A = (n: number) => <p>{`' + HELPER.replace('successfully twice', '${n} times') + '`}</p>;', '<p> text'],
    ['an About disclosure', `export const A = () => <About><p>${HELPER}</p></About>;`, 'inside <About>'],
    ['an InfoTooltip', `export const A = () => <InfoTooltip label="Why">${HELPER}</InfoTooltip>;`, '<InfoTooltip> text'],
    ['a toast', `toast.success("${HELPER}");`, 'toast.success()'],
    ['a returned sentence', `export function note() { return "${HELPER}"; }`, 'return'],
  ];
  for (const [name, source, context] of cases) {
    test(name, () => {
      const found = over(source);
      assert.equal(found.length, 1, `expected one offender, got ${JSON.stringify(found, null, 2)}`);
      assert.equal(found[0].words, 20);
      assert.equal(found[0].kind, 'label');
      assert.equal(found[0].budget, LABEL_WORD_BUDGET);
      assert.ok(found[0].context.includes(context), `context "${found[0].context}" should name ${context}`);
    });
  }

  test('a payload builder in shared/ or worker/ (the desk renders those sentences verbatim)', () => {
    const found = over(`export const step = { label: "Provider access", note: "${HELPER}" };`, 'apps/tower/shared/x.ts');
    assert.equal(found.length, 1);
    assert.equal(found[0].context, 'note:');
  });
});

test('a JSX paragraph is measured whole, across inline elements and interpolations', () => {
  const source = `export const A = ({ n }) => (
    <p>Before you connect a source, <strong>read this</strong>: the numbers below only update after the
      <code>nightly</code> job has run {n} times.</p>
  );`;
  const found = over(source);
  assert.equal(found.length, 1);
  assert.equal(found[0].words, 20);
  assert.equal(found[0].line, 2);
});

test('a block child ends the run, so two short labels are two strings', () => {
  const source = 'export const A = () => <div>Six words of text right here <Button>Five more words right here</Button></div>;';
  assert.deepEqual(over(source), []);
  const texts = extract(source).map((entry) => entry.text);
  assert.deepEqual(texts, ['Six words of text right here', 'Five more words right here']);
});

test('the longest branch of a conditional is the one judged', () => {
  const found = over(`export const A = ({ ok }) => <p>{ok ? "Saved" : "${HELPER}"}</p>;`);
  assert.equal(found.length, 1);
  assert.equal(found[0].words, 20);
});

// A SENTENCE CUT INTO + PIECES IS STILL ONE SENTENCE (bead ro-ujb9.96.11).
// Measured piece by piece, any paragraph passed once it was split into
// fragments of twelve words or fewer, so the gate could be routed around.
const HALF_ONE = 'Before you connect a source, read this: the numbers below ';
const HALF_TWO = 'only update after the nightly job has run successfully twice.';

describe('a sentence joined with + is measured as one string', () => {
  test('the halves are ten words each, and the whole is the 20-word HELPER', () => {
    assert.equal(countWords(HALF_ONE), 10);
    assert.equal(countWords(HALF_TWO), 10);
    assert.equal(HALF_ONE + HALF_TWO, HELPER);
  });

  const cases = [
    ['a Tower constant', 'apps/tower/src/Panel.tsx', `export const NOTE = "${HALF_ONE}" + "${HALF_TWO}";`, 20],
    ['a JSX child', 'apps/tower/src/Panel.tsx', `export const A = () => <p>{"${HALF_ONE}" + "${HALF_TWO}"}</p>;`, 20],
    ['a prop, with a value spliced in', 'apps/tower/src/Panel.tsx', `export const A = (n: number) => <Panel hint={"${HALF_ONE}" + n + " ${HALF_TWO}"} />;`, 21],
    ['template pieces', 'apps/tower/shared/x.ts', 'export const note = (n: number) => `' + HALF_ONE + '` + `${n} ' + HALF_TWO + '`;', 21],
    ['nested parentheses', 'apps/tower/worker/x.ts', `export const NOTE = "Before you " + ("connect a source, read this: " + "the numbers below ") + "${HALF_TWO}";`, 20],
    ['a traced script module', 'scripts/panel-copy.mts', `export const COPY = { hint: "${HALF_ONE}" + "${HALF_TWO}" };`, 20],
    ['a traced workspace package', 'packages/contract/src/labels.ts', `export function note() {\n  return (\n    "${HALF_ONE}" +\n    "${HALF_TWO}"\n  );\n}`, 20],
  ];
  for (const [name, file, source, expected] of cases) {
    test(name, () => {
      const found = over(source, file);
      assert.equal(found.length, 1, `expected the joined sentence once, got ${JSON.stringify(found, null, 2)}`);
      assert.equal(found[0].words, expected);
      assert.equal(found[0].kind, 'label');
      assert.equal(extract(source, file).filter((entry) => entry.text.includes('nightly')).length, 1, 'no half is measured again on its own');
    });
  }

  test('the longest branch of each piece is the one read, and a failure branch keeps the failure budget', () => {
    const [entry] = extract(`export function note(error: boolean) { return "Sync " + (error ? "${HELPER}" : "ok"); }`);
    assert.equal(entry.words, 21);
    assert.equal(entry.kind, 'failure');
  });

  test('arithmetic, class lists, keys, SQL and terminal output are still not text', () => {
    const source = [
      'export const total = count + 1;',
      'export const A = ({ extra }) => <p className={"flex items-center gap-2 " + extra} key={"row-" + extra}>x</p>;',
      `export const sql = "SELECT id, asset_id FROM noticeos.flags " + "WHERE severity = 'error' AND kind IS NOT NULL";`,
      `process.stderr.write("${HALF_ONE}" + "${HALF_TWO}");`,
      `server.config.logger.error("${HALF_ONE}" + "${HALF_TWO}");`,
      `console.warn("${HALF_ONE}" + "${HALF_TWO}");`,
    ].join('\n');
    assert.deepEqual(over(source), []);
    assert.deepEqual(extract(source).map((entry) => entry.text), ['x']);
  });
});

test('HTML entities read as the characters the reader sees', () => {
  const [entry] = extract('export const A = () => <p>Don&rsquo;t &amp; won&apos;t</p>;');
  assert.equal(entry.text, 'Don’t & won\'t');
});

// ---------------------------------------------------------------------------
// What is not visible
// ---------------------------------------------------------------------------

describe('strings nobody reads are never counted', () => {
  const classes = 'inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2';
  const cases = [
    ['className', `export const A = () => <div className="${classes}" />;`],
    ['cn() arguments', `export const A = () => <div className={cn("${classes}", open && "ring-2")} />;`],
    ['a class variable', `const rowClassName = "${classes}";`],
    ['a class list in any variable (by shape)', `const base = "${classes}";`],
    ['data-* attributes', `export const A = () => <div data-audit-note="${HELPER}" />;`],
    ['a type', `type Copy = "${HELPER}";`],
    ['a property name', `const map = { "${HELPER}": 1 };`],
    ['a comparison', `if (value === "${HELPER}") run();`],
    ['console output', `console.warn("${HELPER}");`],
    ['SQL', 'db.prepare("SELECT id, name, kind FROM assets WHERE retired_at IS NULL AND kind = ? ORDER BY name");'],
    ['a SQL column list', 'const COLUMNS = "id, pulse_id AS pulseId, fired_at AS firedAt, severity, kind, metric, message, rule_id AS ruleId";'],
    ['an SQL fragment', 'return `${p}resolved_at IS NULL AND ${p}disposition = \'snooze\' AND ${p}snooze_until IS NOT NULL`;'],
    ['SVG geometry', 'export const A = () => <path d="M 0 0 L 10 10 L 20 5 L 30 12 L 40 2 L 50 9 L 60 1 L 70 8 Z" />;'],
    ['a tagged template', `const style = css\`${HELPER}\`;`],
  ];
  for (const [name, source] of cases) {
    test(name, () => assert.deepEqual(over(source), [], `${name} must not be read as copy`));
  }
});

// ---------------------------------------------------------------------------
// Kinds: failure messages and accessible names get their own budgets
// ---------------------------------------------------------------------------

describe('failure messages get FAILURE_WORD_BUDGET, accessible names ACCESSIBLE_NAME_WORD_BUDGET', () => {
  const sixteen = words(16);
  const twenty = words(20);
  test('toast.error within budget passes; toast.success with the same words fails', () => {
    assert.deepEqual(over(`toast.error("${sixteen}");`), []);
    assert.equal(over(`toast.success("${sixteen}");`).length, 1);
    const [failure] = over(`toast.error("${twenty}");`);
    assert.equal(failure.kind, 'failure');
    assert.equal(failure.budget, FAILURE_WORD_BUDGET);
  });
  test('thrown errors, error keys, error branches and role="alert" are failures', () => {
    assert.deepEqual(over(`throw new Error("${sixteen}");`), []);
    assert.deepEqual(over(`const refusal = { error: "${sixteen}" };`), []);
    assert.deepEqual(over(`export const A = ({ error }) => (error ? <p>${sixteen}</p> : null);`), []);
    assert.deepEqual(over(`export const A = () => <div role="alert">${sixteen}</div>;`), []);
    assert.equal(over(`export const A = ({ loading }) => (loading ? <p>${sixteen}</p> : null);`).length, 1);
  });
  test('aria-label, alt, sr-only text and an InfoTooltip label are accessible names', () => {
    assert.deepEqual(over(`export const A = () => <svg aria-label="${twenty}" />;`), []);
    assert.deepEqual(over(`export const A = () => <img alt="${twenty}" />;`), []);
    assert.deepEqual(over(`export const A = () => <span className="sr-only">${twenty}</span>;`), []);
    assert.deepEqual(over(`export const A = () => <InfoTooltip label="${twenty}">Short.</InfoTooltip>;`), []);
    const [long] = over(`export const A = () => <svg aria-label="${words(26)}" />;`);
    assert.equal(long.kind, 'accessible');
    assert.equal(long.budget, ACCESSIBLE_NAME_WORD_BUDGET);
  });
});

// ---------------------------------------------------------------------------
// Developer-only messages (bead ro-ujb9.96.4)
// ---------------------------------------------------------------------------

describe('a message only a developer can see is not counted; one an error boundary shows is', () => {
  const thrown = `throw new Error("${HELPER}");`;
  const hidden = (source) => overBudget(extractVisibleStrings(source, 'apps/tower/src/Panel.tsx', ts, { renderErrorsShown: false }));
  const shown = (source) => overBudget(extractVisibleStrings(source, 'apps/tower/src/Panel.tsx', ts, { renderErrorsShown: true }));
  const renderPaths = [
    ['a component', `export function Panel({ a, b }) {\n  if (a && b) ${thrown}\n  return <p>Sources</p>;\n}`],
    ['an arrow component', `export const Panel = ({ a }) => {\n  if (a) ${thrown}\n  return <p>Sources</p>;\n};`],
    ['a memo component', `export const Panel = memo(function Panel({ a }) {\n  if (a) ${thrown}\n  return <p>Sources</p>;\n});`],
    ['a hook', `export function usePanel(a) {\n  if (!a) ${thrown}\n  return a;\n}`],
    ['a class render', `class Panel extends Component {\n  render() {\n    if (!this.props.a) ${thrown}\n    return <p>Sources</p>;\n  }\n}`],
  ];
  for (const [name, source] of renderPaths) {
    test(`thrown while ${name} renders: console only, unless a boundary shows it`, () => {
      assert.deepEqual(hidden(source), [], 'no error boundary shows the message, so no operator reads it');
      const [counted] = shown(source);
      assert.ok(counted, 'an error boundary that renders the message puts it on the desk');
      assert.equal(counted.kind, 'failure');
    });
  }
  const shownPaths = [
    ['an event handler inside a component', `export function Panel() {\n  const save = () => { ${thrown} };\n  return <button onClick={save}>Save</button>;\n}`],
    ['a query function a screen catches', `export function usePanel() {\n  return useQuery({ queryFn: async () => { ${thrown} } });\n}`],
    ['a plain function', `export function parse(value) {\n  if (!value) ${thrown}\n  return value;\n}`],
    ['a lower-case function that returns JSX', `export function row(a) {\n  if (!a) ${thrown}\n  return <p>Row</p>;\n}`],
  ];
  for (const [name, source] of shownPaths) {
    test(`thrown from ${name}: still counted`, () => {
      assert.equal(hidden(source).length, 1, `${name} may be caught and shown by the screen`);
    });
  }
});

test('the gate counts a render-time throw only once the Tower has an error boundary that shows it', () => {
  const checkout = scratchCheckout();
  const throwing = `export function Throwing({ a, b }) {\n  if (a && b) throw new Error("${HELPER}");\n  return <p>Sources</p>;\n}\n`;
  writeFileSync(path.join(checkout.root, 'apps/tower/src/Throwing.tsx'), throwing);
  const clean = gateCli(checkout, []);
  assert.equal(clean.status, 0, `a throw inside a component reaches only the console:\n${clean.stderr}`);

  writeFileSync(path.join(checkout.root, 'apps/tower/src/Boundary.tsx'), [
    'export class Boundary extends Component {',
    '  static getDerivedStateFromError(error) { return { error }; }',
    '  render() { return this.state.error ? <p role="alert">{this.state.error.message}</p> : this.props.children; }',
    '}',
    '',
  ].join('\n'));
  const failed = gateCli(checkout, []);
  assert.equal(failed.status, 1, 'the boundary renders the message, so the throw is desk text');
  assert.match(failed.stderr, /Throwing\.tsx:2 {2}20 words \(failure budget 18\)/);
  assert.ok(failed.stderr.trim().endsWith(NEXT_STEPS));
});

// ---------------------------------------------------------------------------
// The messages: the violation first, the fixed instructions last
// ---------------------------------------------------------------------------

const increase = (file, text) => {
  const [offender] = over(`export const A = () => <p>${text}</p>;`, file);
  return { file, now: { count: 1, words: offender.words, offenders: [{ file, ...offender }] }, allowed: { count: 0, words: 0 } };
};

test('a violation names file:line, the text and the word count, then ends with the fixed instructions', () => {
  const message = gateMessage({ increases: [increase('apps/tower/src/Panel.tsx', HELPER)] });
  assert.match(message, /apps\/tower\/src\/Panel\.tsx:1 {2}20 words \(label budget 12\)/);
  assert.ok(message.includes('Before you connect a source'));
  assert.ok(message.indexOf('Panel.tsx:1') < message.indexOf(NEXT_STEPS), 'the violation comes first');
  assert.ok(message.endsWith(NEXT_STEPS));
  for (const phrase of ['Do not shorten the text', 'Redesign the interaction', 'best-in-class modern products',
    'docs/briefs/<flow>.md#prior-art', '"priorArt"', 'trust-safety, legal or', 'destructive-confirmation fact']) {
    assert.ok(NEXT_STEPS.includes(phrase), `NEXT_STEPS must say "${phrase}"`);
  }
});

// ---------------------------------------------------------------------------
// Retired on-screen terms (bead ro-ujb9.135)
// ---------------------------------------------------------------------------

describe('a short label that names an internal is a failure, with the word to say instead', () => {
  test('a planted retired term is found in every place the gate reads text', () => {
    const planted = extract([
      'export function Panel() {',
      '  return <section><h2>Net</h2><p>no ledger rows for Sep yet</p><label aria-label="On the roster" /></section>;',
      '}',
    ].join('\n'));
    const hits = retiredTermHits(planted, 'apps/tower/src/Panel.tsx');
    assert.deepEqual(hits.map((hit) => hit.term).sort(), ['ledger rows', 'on the roster']);
    const message = gateMessage({ retired: hits });
    assert.match(message, /a retired internal term is on screen/);
    assert.match(message, /apps\/tower\/src\/Panel\.tsx:2 {2}"ledger rows"/);
    assert.ok(message.includes('say instead: revenue or costs'));
    assert.ok(message.endsWith(NEXT_STEPS));
  });

  test('code, comments and ids are not text, and the plain words that replaced a term pass', () => {
    const source = [
      '// ledger rows are read in ledger-history.ts',
      'const key = "ledger-rows";',
      'export function Panel() {',
      '  return <p>no revenue or costs for Sep yet</p>;',
      '}',
    ].join('\n');
    assert.deepEqual(retiredTermHits(extract(source), 'apps/tower/src/Panel.tsx'), []);
  });

  test('every retired term says what to write instead', () => {
    for (const { term, pattern, say } of RETIRED_TERMS) {
      assert.ok(pattern.test(term), `${term} must match its own pattern`);
      assert.ok(say.length > 0, `${term} names its replacement`);
    }
  });
});

test('every design failure path ends with the fixed instructions; a stale baseline alone asks for ux:baseline', () => {
  assert.ok(gateMessage({ raises: ['x: count 1 → 2 is a raise without a valid exception'] }).endsWith(NEXT_STEPS));
  assert.ok(gateMessage({ schema: ['x: unknown key "y"'] }).endsWith(NEXT_STEPS));
  assert.ok(PROTECTED_MESSAGE.endsWith(NEXT_STEPS));
  const stale = gateMessage({ decreases: [{ file: 'a.tsx', now: { count: 0, words: 0 }, allowed: { count: 1, words: 20 } }] });
  assert.ok(stale.includes('pnpm ux:baseline'));
  assert.ok(!stale.includes(NEXT_STEPS), 'the Tower got better; the next step is bookkeeping, not a redesign');
  assert.equal(gateMessage({}), '');
});

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

test('a file may not gain an offender or a word; a new file with prose is a gain', () => {
  const measured = (count, words) => ({ count, words, offenders: [] });
  const baseline = { files: { 'a.tsx': { count: 2, words: 40 } } };
  assert.equal(compareToBaseline({ 'a.tsx': measured(3, 60) }, baseline).increases.length, 1);
  assert.equal(compareToBaseline({ 'a.tsx': measured(2, 41) }, baseline).increases.length, 1);
  assert.equal(compareToBaseline({ 'b.tsx': measured(1, 20) }, baseline).increases.length, 1);
  const lower = compareToBaseline({ 'a.tsx': measured(1, 20) }, baseline);
  assert.deepEqual([lower.increases.length, lower.decreases.length], [0, 1]);
  const gone = compareToBaseline({}, baseline);
  assert.equal(gone.decreases.length, 1, 'a file that lost all its prose (or was deleted) is stale');
});

test('lowering never raises, never adds a file, drops what reaches zero and keeps approvals', () => {
  let seed = 42;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 300; round++) {
    const baseline = { files: {} };
    const measured = {};
    for (let i = 0; i < 6; i++) {
      const count = 1 + random(4);
      baseline.files[`f${i}.tsx`] = {
        count,
        words: count * 13 + random(40),
        ...(i === 0 ? { approvedBy: 'ro-abcd.1', kind: 'legal', reason: 'a kept reason here', priorArt: 'docs/briefs/x.md#prior-art' } : {}),
      };
      const now = random(6);
      measured[`f${i}.tsx`] = { count: now, words: now * 13 + random(80) };
    }
    measured['new.tsx'] = { count: 5, words: 200 };
    const { next } = lowerBaseline(baseline, measured);
    assert.ok(!('new.tsx' in next.files), 'ux:baseline must never add a file');
    for (const [file, entry] of Object.entries(next.files)) {
      assert.ok(entry.count <= baseline.files[file].count && entry.words <= baseline.files[file].words, `${file} was raised`);
      assert.ok(entry.count > 0 && entry.words > 0);
    }
    if (next.files['f0.tsx']) assert.equal(next.files['f0.tsx'].approvedBy, 'ro-abcd.1');
  }
});

// ---------------------------------------------------------------------------
// Exceptions: approvedBy + reason + priorArt, or nothing
// ---------------------------------------------------------------------------

const BRIEF = `# Setup checklist

## Prior art

- Linear — https://linear.app/docs/getting-started — the checklist is the empty state
- Stripe — https://docs.stripe.com/get-started — each step is a single action with a status dot
- PostHog — https://posthog.com/docs/getting-started — steps disappear once done

\`\`\`
## Not a heading inside a fence
\`\`\`

## Two links only

https://example.com/a and https://example.com/b
`;

const reader = (files) => (rel) => (rel in files ? files[rel] : null);
const briefs = reader({ 'docs/briefs/setup.md': BRIEF });
const approved = {
  approvedBy: 'ro-abcd.1',
  kind: 'legal',
  reason: 'no comparable removes the regulatory disclosure',
  priorArt: 'docs/briefs/setup.md#prior-art',
};

test('an exception kind comes from a closed set: trust-safety, legal, destructive-confirmation', () => {
  assert.deepEqual([...EXCEPTION_KINDS], ['trust-safety', 'legal', 'destructive-confirmation']);
  const previous = { files: {} };
  const raise = (kind) => ({ files: { 'a.tsx': { count: 1, words: 20, ...approved, kind } } });
  const check = (kind) => baselineRaises(previous, raise(kind), { prefixes: ['ro'], readFile: briefs });
  for (const kind of EXCEPTION_KINDS) assert.deepEqual(check(kind), [], `${kind} is an allowed exception`);
  for (const kind of [undefined, '', 'ux', 'onboarding', 'Legal', 'trust', 'copy', 'other']) {
    const [violation] = check(kind);
    assert.ok(violation, `kind ${JSON.stringify(kind)} must be refused`);
    assert.match(violation, /exceptions exist only for trust, safety, legal or destructive-confirmation facts/);
    assert.match(violation, /everything else must be redesigned/);
  }
  const schema = validateBaseline({ files: { 'a.tsx': { count: 1, words: 20, ...approved, kind: 'convenience' } } },
    { prefixes: ['ro'], readFile: briefs });
  assert.match(schema[0], /exceptions exist only for trust, safety, legal or destructive-confirmation facts/);
});

test('a priorArt citation must resolve to a docs/briefs section citing at least three sources', () => {
  assert.deepEqual(priorArtProblems('docs/briefs/setup.md#prior-art', briefs), []);
  assert.match(priorArtProblems(undefined, briefs)[0], /priorArt must cite/);
  assert.match(priorArtProblems('docs/setup.md#prior-art', briefs)[0], /priorArt must cite/);
  assert.match(priorArtProblems('docs/briefs/missing.md#prior-art', briefs)[0], /does not exist/);
  assert.match(priorArtProblems('docs/briefs/setup.md#nope', briefs)[0], /no "#nope" section/);
  assert.match(priorArtProblems('docs/briefs/setup.md#two-links-only', briefs)[0], /cites 2 source link/);
  assert.equal(markdownSection(BRIEF, 'not-a-heading-inside-a-fence'), null);
});

test('a raise needs a fresh, complete exception', () => {
  const previous = { files: { 'a.tsx': { count: 1, words: 20 } } };
  const raised = (extra) => ({ files: { 'a.tsx': { count: 2, words: 40, ...extra } } });
  const check = (next, prev = previous) => baselineRaises(prev, next, { prefixes: ['ro', 'mp'], readFile: briefs });
  assert.equal(check(raised({})).length, 1, 'no approval at all');
  assert.match(check(raised({ ...approved, priorArt: undefined }))[0], /priorArt/);
  assert.match(check(raised({ ...approved, priorArt: 'docs/briefs/setup.md#two-links-only' }))[0], /cites 2 source link/);
  assert.match(check(raised({ ...approved, reason: 'ok' }))[0], /reason/);
  for (const bad of ['ask-operator', 'RO-abcd', 'ro_abcd', 'zz-abcd.1', '']) {
    assert.match(check(raised({ ...approved, approvedBy: bad }))[0], /approvedBy/, `${bad} is not an approved bead id`);
  }
  assert.deepEqual(check(raised(approved)), []);
  const again = { files: { 'a.tsx': { count: 3, words: 60, ...approved } } };
  assert.match(check(again, raised(approved))[0], /reuses the approval/);
  assert.deepEqual(check({ files: { 'a.tsx': { count: 1, words: 15 } } }), [], 'a lowering needs no approval');
});

test('the baseline schema rejects unknown keys, impossible totals and half an exception', () => {
  const check = (files) => validateBaseline({ files }, { prefixes: ['ro'], readFile: briefs });
  assert.deepEqual(check({ 'a.tsx': { count: 2, words: 40 } }), []);
  assert.deepEqual(check({ 'a.tsx': { count: 2, words: 40, ...approved } }), []);
  assert.match(check({ 'a.tsx': { count: 2, words: 40, note: 'x' } })[0], /unknown key "note"/);
  assert.match(check({ 'a.tsx': { count: 2, words: 20 } })[0], /cannot total 20 words/);
  assert.match(check({ 'a.tsx': { count: 0, words: 20 } })[0], /count must be a positive integer/);
  assert.ok(check({ 'a.tsx': { count: 2, words: 40, approvedBy: 'ro-abcd.1' } }).some((error) => /priorArt/.test(error)));
  assert.ok(isBeadId('ro-ujb9.94', ['ro']));
  assert.ok(!isBeadId('ro-ujb9.94', ['mp']));
});

// ---------------------------------------------------------------------------
// A scratch checkout: the CLI, the pre-commit hook and the history audit
// ---------------------------------------------------------------------------

function isolatedEnv(root) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.CI;
  // The operator's global and system git config (a hooksPath, commit signing)
  // must not leak into the scratch repositories. HOME itself stays: on macOS
  // moving it costs every git call a fresh xcrun lookup.
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, '.home', '.gitconfig'),
    GIT_CEILING_DIRECTORIES: path.dirname(root),
    GIT_AUTHOR_NAME: 'UX Gate Test',
    GIT_AUTHOR_EMAIL: 'ux-gate@example.invalid',
    GIT_COMMITTER_NAME: 'UX Gate Test',
    GIT_COMMITTER_EMAIL: 'ux-gate@example.invalid',
  };
}

function scratchCheckout({ git: withGit = false, commit = withGit } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ux-gate-')));
  scratchRoots.push(root);
  mkdirSync(path.join(root, '.home'), { recursive: true });
  writeFileSync(path.join(root, '.home', '.gitconfig'), '');
  mkdirSync(path.join(root, 'apps/tower/src'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'config'), { recursive: true });
  mkdirSync(path.join(root, '.githooks'), { recursive: true });
  // The copied gate resolves typescript from its own checkout, as it does live.
  symlinkSync(path.join(REPO_ROOT, 'apps/tower/node_modules'), path.join(root, 'apps/tower/node_modules'));
  writeFileSync(path.join(root, 'apps/tower/package.json'), '{"name":"scratch-tower","private":true}\n');
  copyFileSync(path.join(SCRIPTS_DIR, 'ux-gate.mjs'), path.join(root, 'scripts/ux-gate.mjs'));
  // The one resolver the gate finds the task projects through (bead ro-ujb9.125).
  copyFileSync(path.join(SCRIPTS_DIR, 'installation.mjs'), path.join(root, 'scripts/installation.mjs'));
  copyFileSync(path.join(SCRIPTS_DIR, 'product-env.mjs'), path.join(root, 'scripts/product-env.mjs'));
  writeScratchSettings(root);
  copyFileSync(path.join(REPO_ROOT, '.githooks/pre-commit'), path.join(root, '.githooks/pre-commit'));
  writeFileSync(path.join(root, 'config/beads.json'), JSON.stringify({ spokes: [{ prefix: 'ro' }] }));
  writeFileSync(path.join(root, 'README.md'), 'scratch\n');
  writePanel(root, `<p>${LEGACY}</p>`);
  writeFileSync(path.join(root, BASELINE_FILE), serializeBaseline({ files: { 'apps/tower/src/Panel.tsx': { count: 1, words: 18 } } }));
  const env = isolatedEnv(root);
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', ...options });
    if (result.error) throw result.error;
    return result;
  };
  if (withGit) {
    run('git', ['init', '-q', '-b', 'main']);
    run('git', ['config', 'core.hooksPath', '.githooks']);
    run('git', ['config', 'commit.gpgsign', 'false']);
  }
  if (withGit && commit) {
    run('git', ['add', '-A']);
    const first = run('git', ['commit', '-q', '-m', 'scratch: introduce the gate']);
    assert.equal(first.status, 0, first.stderr);
  }
  return { root, env, run };
}

/** The repo's own rules, minus the skipped files a scratch checkout does not
 * have (an entry for a missing file is a schema error; dropping one is free). */
function writeScratchSettings(root) {
  const settings = JSON.parse(readFileSync(path.join(SCRIPTS_DIR, 'ux-gate.settings.json'), 'utf8'));
  settings.notDeskCopy = {};
  writeFileSync(path.join(root, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
}

function writePanel(root, body) {
  writeFileSync(
    path.join(root, 'apps/tower/src/Panel.tsx'),
    `export function Panel() {\n  return (\n    <section>\n      <h2>Sources</h2>\n      ${body}\n    </section>\n  );\n}\n`,
  );
}

const gateCli = (checkout, args) => checkout.run(process.execPath, [path.join(checkout.root, 'scripts/ux-gate.mjs'), ...args]);

test('CLI: the whole-checkout gate passes on the baseline, fails on a new paragraph with the instructions last', () => {
  const checkout = scratchCheckout();
  assert.equal(gateCli(checkout, []).status, 0);
  writePanel(checkout.root, `<p>${LEGACY}</p>\n      <p>${HELPER}</p>`);
  const failed = gateCli(checkout, []);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /apps\/tower\/src\/Panel\.tsx:6 {2}20 words \(label budget 12\)/);
  assert.ok(failed.stderr.trim().endsWith(NEXT_STEPS));
  const files = gateCli(checkout, ['--files', path.join(checkout.root, 'apps/tower/src/Panel.tsx')]);
  assert.equal(files.status, 1);
  assert.ok(files.stderr.trim().endsWith(NEXT_STEPS));
});

test('CLI: a planted retired term fails the whole-checkout gate and the edit-time check', () => {
  const checkout = scratchCheckout();
  writePanel(checkout.root, `<p>${LEGACY}</p>\n      <p>none onboarded yet</p>`);
  const failed = gateCli(checkout, []);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /a retired internal term is on screen/);
  assert.match(failed.stderr, /Panel\.tsx:6 {2}"onboarded"/);
  const files = gateCli(checkout, ['--files', path.join(checkout.root, 'apps/tower/src/Panel.tsx')]);
  assert.equal(files.status, 1);
  writePanel(checkout.root, `<p>${LEGACY}</p>\n      <p>none yet</p>`);
  assert.equal(gateCli(checkout, []).status, 0);
});

test('CLI: ux:baseline only lowers — removing text lowers the record, adding text never raises it', () => {
  const checkout = scratchCheckout();
  writePanel(checkout.root, `<p>${LEGACY}</p>\n      <p>${HELPER}</p>`);
  const refused = gateCli(checkout, ['--write-baseline']);
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.trim().endsWith(NEXT_STEPS));
  assert.deepEqual(JSON.parse(readFileSync(path.join(checkout.root, BASELINE_FILE), 'utf8')).files, {
    'apps/tower/src/Panel.tsx': { count: 1, words: 18 },
  });

  writePanel(checkout.root, '<p>Sources you connect appear here.</p>');
  const stale = gateCli(checkout, []);
  assert.equal(stale.status, 1, 'a baseline looser than the Tower is a hole in the ratchet');
  assert.match(stale.stderr, /pnpm ux:baseline/);
  const lowered = gateCli(checkout, ['--write-baseline']);
  assert.equal(lowered.status, 0, lowered.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(checkout.root, BASELINE_FILE), 'utf8')).files, {});
  assert.equal(gateCli(checkout, []).status, 0);

  rmSync(path.join(checkout.root, BASELINE_FILE));
  assert.equal(gateCli(checkout, ['--write-baseline']).status, 1, 'ux:baseline never creates the record');
  assert.ok(!existsSync(path.join(checkout.root, BASELINE_FILE)));
});

test('pre-commit: a 20-word paragraph fails git commit; a commit with no Tower UI is untouched', () => {
  const checkout = scratchCheckout({ git: true });
  writeFileSync(path.join(checkout.root, 'README.md'), 'scratch, edited\n');
  checkout.run('git', ['add', 'README.md']);
  // A commit with no Tower UI must not pay for the gate: the staged check reads
  // nothing on that index (a count, not the host's clock — bead ro-ujb9.187).
  const staged = gateCli(checkout, ['--staged', '--json']);
  assert.equal(staged.status, 0, staged.stderr);
  assert.deepEqual(JSON.parse(staged.stdout).checked, [], 'a commit with no Tower UI must not pay for the gate');
  const docs = checkout.run('git', ['commit', '-q', '-m', 'docs only']);
  assert.equal(docs.status, 0, docs.stderr);

  writePanel(checkout.root, `<p>${LEGACY}</p>\n      <p>${HELPER}</p>`);
  checkout.run('git', ['add', 'apps/tower/src/Panel.tsx']);
  const blocked = checkout.run('git', ['commit', '-q', '-m', 'add a helper paragraph']);
  assert.notEqual(blocked.status, 0, 'the pre-commit hook must refuse the paragraph');
  assert.match(blocked.stderr, /Panel\.tsx:6 {2}20 words/);
  assert.ok(blocked.stderr.includes('Before you connect a source'));
  assert.ok(blocked.stderr.trim().endsWith(NEXT_STEPS));
});

test('pre-commit: removing prose must lock the baseline in; an unapproved raise is refused', () => {
  const checkout = scratchCheckout({ git: true });
  writePanel(checkout.root, '<p>Sources you connect appear here.</p>');
  checkout.run('git', ['add', 'apps/tower/src/Panel.tsx']);
  const stale = checkout.run('git', ['commit', '-q', '-m', 'remove the paragraph']);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /pnpm ux:baseline/);
  assert.match(stale.stderr, /git add apps\/tower\/ux-budget\.json/);
  assert.equal(gateCli(checkout, ['--write-baseline']).status, 0);
  checkout.run('git', ['add', BASELINE_FILE]);
  const locked = checkout.run('git', ['commit', '-q', '-m', 'remove the paragraph, lock it in']);
  assert.equal(locked.status, 0, locked.stderr);

  writeFileSync(path.join(checkout.root, BASELINE_FILE), serializeBaseline({ files: { 'apps/tower/src/Panel.tsx': { count: 1, words: 20 } } }));
  checkout.run('git', ['add', BASELINE_FILE]);
  const raise = checkout.run('git', ['commit', '-q', '-m', 'raise the baseline']);
  assert.notEqual(raise.status, 0);
  assert.match(raise.stderr, /raise without a valid exception/);
  assert.ok(raise.stderr.trim().endsWith(NEXT_STEPS));
});

// ---------------------------------------------------------------------------
// The failure names what THIS change added (bead ro-ujb9.96.5)
// ---------------------------------------------------------------------------

describe('a refusal lists the strings the change added first, marked, then the file\'s older text', () => {
  const MARK = '← this change';
  /** The added string comes first and carries the mark; the legacy one
   * follows, unmarked, under its own line. */
  const assertMarked = (output, where) => {
    const added = output.indexOf('Before you connect a source');
    const legacy = output.indexOf('This older paragraph');
    assert.ok(added !== -1 && legacy !== -1, `${where} must list both strings:\n${output}`);
    assert.ok(added < legacy, `${where} must list the added string first`);
    const lines = output.split('\n');
    const addedLine = lines.findIndex((line) => line.includes('Before you connect a source'));
    assert.ok(lines[addedLine - 1].includes(MARK), `${where} must mark the added string`);
    const legacyLine = lines.findIndex((line) => line.includes('This older paragraph'));
    assert.ok(!lines[legacyLine - 1].includes(MARK), `${where} must not mark legacy text`);
    assert.match(output, /already in apps\/tower\/src\/Panel\.tsx before this change:/);
    assert.ok(output.trim().endsWith(NEXT_STEPS));
  };
  const addHelper = (checkout) => writePanel(checkout.root, `<p>${LEGACY}</p>\n      <p>${HELPER}</p>`);

  test('the pre-commit hook marks the string absent from the committed HEAD version', () => {
    const checkout = scratchCheckout({ git: true });
    addHelper(checkout);
    checkout.run('git', ['add', 'apps/tower/src/Panel.tsx']);
    const blocked = checkout.run('git', ['commit', '-q', '-m', 'add a helper paragraph']);
    assert.notEqual(blocked.status, 0);
    assertMarked(blocked.stderr, 'the pre-commit refusal');
  });

  test('pnpm ux:gate marks an uncommitted string against HEAD', () => {
    const checkout = scratchCheckout({ git: true });
    addHelper(checkout);
    const failed = gateCli(checkout, []);
    assert.equal(failed.status, 1);
    assertMarked(failed.stderr, 'the whole-checkout refusal');
  });

  test('CI marks every string the branch added since it left main', () => {
    const checkout = scratchCheckout({ git: true });
    checkout.run('git', ['checkout', '-q', '-b', 'feature']);
    addHelper(checkout);
    checkout.run('git', ['add', '-A']);
    assert.equal(checkout.run('git', ['commit', '-q', '--no-verify', '-m', 'add the paragraph']).status, 0);
    writeFileSync(path.join(checkout.root, 'README.md'), 'a later, unrelated commit\n');
    checkout.run('git', ['add', '-A']);
    assert.equal(checkout.run('git', ['commit', '-q', '-m', 'unrelated']).status, 0);
    const failed = gateCli(checkout, []);
    assert.equal(failed.status, 1);
    assertMarked(failed.stderr, 'the CI refusal on a branch');

    // On main itself, the last commit is the change.
    checkout.run('git', ['checkout', '-q', 'main']);
    checkout.run('git', ['merge', '-q', '--ff-only', 'feature']);
    checkout.run('git', ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'empty']);
    const onMain = gateCli(checkout, []);
    assert.equal(onMain.status, 1);
    assert.ok(!onMain.stderr.includes(MARK), 'the parent commit already held the paragraph: nothing is new in HEAD');
  });

  test('a second copy of a legacy sentence is new', () => {
    const introduced = introducedSince(() => `export const A = () => <p>${LEGACY}</p>;`, { ts });
    const offenders = over(`export const A = () => <div><p>${LEGACY}</p><p>${LEGACY}</p></div>;`);
    assert.equal(offenders.length, 2);
    assert.deepEqual(introduced('apps/tower/src/Panel.tsx', offenders), [offenders[1]]);
    assert.deepEqual(introducedSince(() => null, { ts })('apps/tower/src/New.tsx', offenders), offenders, 'a new file is new throughout');
  });
});

test('history audit: an approved raise with its research passes; a raise that bypassed the hook is found', () => {
  const checkout = scratchCheckout({ git: true });
  mkdirSync(path.join(checkout.root, 'docs/briefs'), { recursive: true });
  writeFileSync(path.join(checkout.root, 'docs/briefs/setup.md'), BRIEF);
  writePanel(checkout.root, `<p>${LEGACY}</p>\n      <p>${HELPER}</p>`);
  writeFileSync(path.join(checkout.root, BASELINE_FILE), serializeBaseline({
    files: { 'apps/tower/src/Panel.tsx': { count: 2, words: 38, ...approved } },
  }));
  checkout.run('git', ['add', '-A']);
  const ok = checkout.run('git', ['commit', '-q', '-m', 'approved exception']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(auditBaselineHistory(checkout.root).violations, []);

  writeFileSync(path.join(checkout.root, BASELINE_FILE), serializeBaseline({
    files: { 'apps/tower/src/Panel.tsx': { count: 3, words: 60, ...approved } },
  }));
  checkout.run('git', ['add', BASELINE_FILE]);
  // What an agent that ignored AGENTS.md would do. The audit still finds it.
  const bypassed = checkout.run('git', ['commit', '-q', '--no-verify', '-m', 'sneak a raise in']);
  assert.equal(bypassed.status, 0, bypassed.stderr);
  const { violations } = auditBaselineHistory(checkout.root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /reuses the approval of an earlier raise/);
});

// ---------------------------------------------------------------------------
// The Claude Code hook
// ---------------------------------------------------------------------------

describe('the Claude Code hook', () => {
  const checkout = scratchCheckout();
  const panel = path.join(checkout.root, 'apps/tower/src/Panel.tsx');
  const hook = (mode, event) =>
    spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'ux-gate-hook.mjs'), mode], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      env: checkout.env,
    });

  test('PostToolUse: an edit that adds a paragraph exits 2 and names it; a clean edit exits 0', () => {
    writePanel(checkout.root, `<p>${LEGACY}</p>\n      <p>${HELPER}</p>`);
    const event = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: panel, old_string: '</p>', new_string: `</p>\n      <p>${HELPER}</p>` },
    };
    const blocked = hook('post', event);
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /Panel\.tsx:6 {2}20 words \(label budget 12\)/);
    assert.match(blocked.stderr, /← this change/);
    assert.ok(blocked.stderr.trim().endsWith(NEXT_STEPS));

    writePanel(checkout.root, `<p>${LEGACY}</p>\n      <p>Connect a source.</p>`);
    const clean = hook('post', { ...event, tool_input: { ...event.tool_input, new_string: '<p>Connect a source.</p>' } });
    assert.equal(clean.status, 0, clean.stderr);
  });

  test('PostToolUse: removing prose passes and tells the agent to lock it in', () => {
    writePanel(checkout.root, '<p>Connect a source.</p>');
    const result = decide('post', { tool_name: 'Write', tool_input: { file_path: panel, content: '' } });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(output.hookSpecificOutput.additionalContext, /pnpm ux:baseline/);
    writePanel(checkout.root, `<p>${LEGACY}</p>`);
  });

  test('PostToolUse ignores files that are not Tower UI', () => {
    for (const file of ['README.md', 'apps/tower/test/panel.test.tsx', 'scripts/x.mjs']) {
      assert.equal(decide('post', { tool_name: 'Write', tool_input: { file_path: path.join(checkout.root, file) } }).code, 0);
    }
  });

  test('PreToolUse: agents cannot edit the baseline, by edit tool or by shell', () => {
    const baseline = path.join(checkout.root, BASELINE_FILE);
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      const result = hook('pre', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: baseline } });
      assert.equal(result.status, 2, `${tool} on the baseline must be blocked`);
      assert.ok(result.stderr.trim().endsWith(NEXT_STEPS));
    }
    for (const command of [
      `echo '{}' > ${BASELINE_FILE}`,
      `sed -i '' 's/18/40/' ${BASELINE_FILE}`,
      `cp /tmp/looser.json ${BASELINE_FILE}`,
      `node -e "const fs = require('fs'); fs.writeFileSync('${BASELINE_FILE}', '{}')"`,
      `jq '.files = {}' ${BASELINE_FILE} | tee ${BASELINE_FILE}`,
    ]) {
      assert.equal(decide('pre', { tool_name: 'Bash', tool_input: { command } }).code, 2, `must block: ${command}`);
      assert.ok(shellWrites(command, BASELINE_FILE));
    }
    for (const command of [`cat ${BASELINE_FILE}`, `git diff ${BASELINE_FILE}`, 'pnpm ux:baseline', `git add ${BASELINE_FILE}`,
      `jq '.files | length' ${BASELINE_FILE} 2>/dev/null`]) {
      assert.equal(decide('pre', { tool_name: 'Bash', tool_input: { command } }).code, 0, `must allow: ${command}`);
    }
    assert.equal(decide('pre', { tool_name: 'Edit', tool_input: { file_path: panel } }).code, 0);
  });
});

// ---------------------------------------------------------------------------
// Installing the pre-commit hook on pnpm install
// ---------------------------------------------------------------------------

describe('pnpm install installs the pre-commit hook', () => {
  const installer = path.join(SCRIPTS_DIR, 'install-git-hooks.mjs');
  const install = (checkout, env = {}) =>
    spawnSync(process.execPath, [installer], { cwd: checkout.root, env: { ...checkout.env, ...env }, encoding: 'utf8' });
  const hooksPath = (checkout) => checkout.run('git', ['config', '--local', '--get', 'core.hooksPath']).stdout.trim();

  test('the root prepare script runs the installer; ux:gate and ux:baseline exist', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(manifest.scripts.prepare, 'node scripts/install-git-hooks.mjs');
    assert.equal(manifest.scripts['ux:gate'], 'node scripts/ux-gate.mjs');
    assert.equal(manifest.scripts['ux:baseline'], 'node scripts/ux-gate.mjs --write-baseline');
    const hookFile = readFileSync(path.join(REPO_ROOT, '.githooks/pre-commit'), 'utf8');
    assert.match(hookFile, /scripts\/ux-gate\.mjs" --staged/);
  });

  test('it sets core.hooksPath in a work tree, and does nothing in CI or outside git', () => {
    const plain = scratchCheckout();
    assert.match(install(plain).stdout, /^$/, 'outside a git work tree it is silent and changes nothing');

    const ci = scratchCheckout({ git: true, commit: false });
    ci.run('git', ['config', '--unset', 'core.hooksPath']);
    install(ci, { CI: 'true' });
    assert.equal(hooksPath(ci), '', 'CI runs the gate through pnpm test:scripts, never a hook');

    const fresh = scratchCheckout({ git: true, commit: false });
    fresh.run('git', ['config', '--unset', 'core.hooksPath']);
    const result = install(fresh);
    assert.equal(result.status, 0);
    assert.equal(hooksPath(fresh), '.githooks');
    assert.match(result.stdout, /Never bypass it with --no-verify/);
  });

  test('it leaves an operator-chosen hooksPath alone and says so', () => {
    const custom = scratchCheckout({ git: true, commit: false });
    custom.run('git', ['config', 'core.hooksPath', '.husky']);
    const result = install(custom);
    assert.equal(hooksPath(custom), '.husky');
    assert.match(result.stdout, /NOT installed/);
    assert.equal(installGitHooks({ cwd: custom.root, env: { CI: '1' } }).reason, 'CI');
  });
});

// ---------------------------------------------------------------------------
// Everything the Tower renders, not only apps/tower (bead ro-ujb9.96.6.13)
// ---------------------------------------------------------------------------
//
// The desk renders text written in scripts/ (config registers, job
// descriptions), in packages/contract (the provider catalog) and in config
// documents compiled into the bundle. A paragraph moved one import away from
// apps/tower must fail exactly as it did in apps/tower.

test('imports are read for their values: static, re-export, side-effect and dynamic, never type-only', () => {
  const source = [
    "import { a } from './a.mjs';",
    "import type { B } from './b.mjs';",
    'import {',
    '  type C,',
    '  c,',
    "} from './c.js';",
    "export * from './d';",
    "export type { E } from './e';",
    "import './f.css';",
    "const g = await import('./g.json');",
    "// import { h } from './h';",
    "const label = 'import me from nowhere';",
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), ['./a.mjs', './c.js', './d', './f.css', './g.json']);
});

/** A scratch checkout whose Tower renders text from outside apps/tower: a
 * script module (authored .mts beside its generated .mjs), a workspace
 * package reached through its exports map, and a config document the Vite
 * config compiles in. */
function renderedCheckout(options) {
  const checkout = scratchCheckout({ ...options, commit: false });
  const write = (rel, text) => {
    mkdirSync(path.join(checkout.root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(checkout.root, rel), text);
  };
  write('scripts/panel-copy.mts', 'export const COPY = { title: "Sources" };\n');
  write('scripts/panel-copy.mjs', '// Generated by pnpm config:generate. Edit the sibling .mts source.\nexport const COPY = { title: "Sources" };\n');
  write('scripts/panel-types.mts', `export type Shape = { hint: string };\nexport const NEVER_RENDERED = "${HELPER}";\n`);
  write('packages/contract/package.json', JSON.stringify({ name: '@scratch/contract', exports: { '.': './src/index.ts', './*': './src/*.ts' } }));
  write('packages/contract/src/index.ts', 'export const VERSION = "1";\n');
  write('packages/contract/src/labels.ts', 'export const LABELS = { connect: "Connect a source" };\n');
  write('config/doc.json', `${JSON.stringify({ lanes: [{ id: 'gsc', note: 'Live.' }] }, null, 2)}\n`);
  write('apps/tower/vite.config.ts', 'import doc from "../../config/doc.json";\nexport default { define: { __DOC__: JSON.stringify(doc) } };\n');
  write('apps/tower/src/Copy.tsx', [
    'import { COPY } from "../../../scripts/panel-copy.mjs";',
    'import type { Shape } from "../../../scripts/panel-types.mjs";',
    'import { LABELS } from "@scratch/contract/labels";',
    'export const Copy = (props: Shape) => <p>{COPY.title} {LABELS.connect} {props.hint}</p>;',
    '',
  ].join('\n'));
  if (options?.git && options.commit !== false) {
    checkout.run('git', ['add', '-A']);
    const first = checkout.run('git', ['commit', '-q', '-m', 'scratch: a Tower that renders text from outside apps/tower']);
    assert.equal(first.status, 0, first.stderr);
  }
  return { ...checkout, write };
}

test('the gate follows the Tower into scripts, workspace packages and config documents', () => {
  const checkout = renderedCheckout();
  const scope = traceScope(workingTree(checkout.root));
  assert.deepEqual(scope.traced, ['config/doc.json', 'packages/contract/src/labels.ts', 'scripts/panel-copy.mts']);
  assert.ok(!scope.files.includes('scripts/panel-copy.mjs'), 'a generated .mjs is measured as its authored .mts');
  assert.ok(!scope.files.includes('scripts/panel-types.mts'), 'a type-only import carries no text');
  assert.ok(!scope.files.includes('apps/tower/vite.config.ts'), 'the Vite config is followed, not measured');
});

describe('moving a paragraph out of apps/tower into a file the Tower renders fails the gate', () => {
  const moves = [
    ['a script module', 'scripts/panel-copy.mts', `export const COPY = { title: "Sources", hint: "${HELPER}" };\n`],
    ['a workspace package', 'packages/contract/src/labels.ts', `export const LABELS = { connect: "Connect a source", note: "${HELPER}" };\n`],
    ['a config document', 'config/doc.json', `${JSON.stringify({ lanes: [{ id: 'gsc', note: HELPER }] }, null, 2)}\n`],
  ];
  for (const [name, file, text] of moves) {
    test(name, () => {
      const checkout = renderedCheckout({ git: true });
      checkout.write(file, text);
      const whole = gateCli(checkout, []);
      assert.equal(whole.status, 1, `the whole-checkout gate must refuse ${file}`);
      assert.ok(whole.stderr.includes(`${file}:`), whole.stderr);
      assert.ok(whole.stderr.includes('Before you connect a source'));
      assert.ok(whole.stderr.trim().endsWith(NEXT_STEPS));

      const edited = decide('post', { tool_name: 'Write', tool_input: { file_path: path.join(checkout.root, file) } });
      assert.equal(edited.code, 2, `the edit hook must refuse ${file}`);

      checkout.run('git', ['add', file]);
      const commit = checkout.run('git', ['commit', '-q', '-m', `move the paragraph into ${file}`]);
      assert.notEqual(commit.status, 0, `the pre-commit hook must refuse ${file}`);
      assert.ok(commit.stderr.includes(`${file}:`), commit.stderr);
    });
  }

  test('a module only a type import reaches stays unread', () => {
    const checkout = renderedCheckout({ git: true });
    assert.equal(gateCli(checkout, []).status, 0);
  });
});

// ---------------------------------------------------------------------------
// What the Tower calls through a service binding (bead ro-ujb9.96.6.24)
// ---------------------------------------------------------------------------
//
// The Tower renders the ingest's probe verdicts, refusals and stored errors
// word for word, and reaches them through `env.INGEST`, not an import.

/** A scratch Tower bound to a scratch ingest: an RPC method that calls a
 * probe module (which imports a hint), and a fetch handler that answers sites. */
function boundCheckout(options) {
  const checkout = renderedCheckout({ ...options, commit: false });
  checkout.write('apps/tower/wrangler.jsonc', '{\n  // the Tower\n  "name": "scratch-tower",\n  "main": "worker/index.ts",\n  "services": [{ "binding": "INGEST", "service": "scratch-ingest" }]\n}\n');
  checkout.write('workers/ingest/package.json', '{"name":"scratch-ingest","private":true}\n');
  checkout.write('workers/ingest/wrangler.jsonc', '{\n  "name": "scratch-ingest", // bound by the Tower\n  "main": "src/index.ts"\n}\n');
  checkout.write('workers/ingest/src/index.ts', [
    "import { WorkerEntrypoint } from 'cloudflare:workers';",
    "import type { Env } from './env';",
    "import { handlePulse } from './pulse';",
    "import { probeCredential } from './probes';",
    'export default class Ingest extends WorkerEntrypoint<Env> {',
    '  override async fetch(request: Request) { return handlePulse(request); }',
    '  async probe(provider: string) { return probeCredential(provider); }',
    '}',
    '',
  ].join('\n'));
  checkout.write('workers/ingest/src/probes.ts', "import { grantHint } from './hint';\nexport function probeCredential(provider: string) {\n  return { ok: false, message: `${provider} refused the key. ${grantHint()}` };\n}\n");
  checkout.write('workers/ingest/src/hint.ts', 'export const grantHint = () => "Add the account as Viewer.";\n');
  checkout.write('workers/ingest/src/pulse.ts', `export const handlePulse = (request: Request) => new Response("${HELPER}", { status: 400 });\n`);
  if (options?.git && options.commit !== false) {
    checkout.run('git', ['add', '-A']);
    const first = checkout.run('git', ['commit', '-q', '-m', 'scratch: a Tower bound to an ingest']);
    assert.equal(first.status, 0, first.stderr);
  }
  return checkout;
}

describe('the gate follows the Tower\'s service binding into the ingest it calls', () => {
  test('the bound entry and what its methods call are read; a fetch handler\'s own route is not', () => {
    const checkout = boundCheckout();
    const scope = traceScope(workingTree(checkout.root));
    for (const file of ['workers/ingest/src/index.ts', 'workers/ingest/src/probes.ts', 'workers/ingest/src/hint.ts']) {
      assert.ok(scope.traced.includes(file), `${file} must be read: ${scope.traced.join(', ')}`);
    }
    assert.ok(!scope.files.includes('workers/ingest/src/pulse.ts'), 'a route only sites call is not Tower text');
    assert.equal(gateCli(checkout, []).status, 0);
  });

  test('a deliberately long sentence in a probe result fails the gate, the commit and the edit hook', () => {
    const checkout = boundCheckout({ git: true });
    const file = 'workers/ingest/src/probes.ts';
    checkout.write(file, `export function probeCredential(provider: string) {\n  return { ok: false, message: \`\${provider}: ${HELPER}\` };\n}\n`);
    const whole = gateCli(checkout, []);
    assert.equal(whole.status, 1);
    assert.match(whole.stderr, /workers\/ingest\/src\/probes\.ts:2 {2}21 words \(label budget 12\) · message:/);
    assert.ok(whole.stderr.trim().endsWith(NEXT_STEPS));

    const edited = decide('post', { tool_name: 'Write', tool_input: { file_path: path.join(checkout.root, file) } });
    assert.equal(edited.code, 2, 'the edit hook must refuse the probe sentence');

    checkout.run('git', ['add', file]);
    const commit = checkout.run('git', ['commit', '-q', '-m', 'a long probe verdict']);
    assert.notEqual(commit.status, 0, 'the pre-commit hook must refuse the probe sentence');
    assert.ok(commit.stderr.includes(`${file}:`), commit.stderr);
  });

  test('the ingest text the Tower already rendered enters once, through a widening under the bead', () => {
    const checkout = boundCheckout({ git: true, commit: false });
    checkout.write('workers/ingest/src/hint.ts', `export const grantHint = () => "${LEGACY}";\n`);
    // The gate before it followed bindings: the same code without the feature.
    const real = readFileSync(path.join(SCRIPTS_DIR, 'ux-gate.mjs'), 'utf8');
    writeFileSync(path.join(checkout.root, 'scripts/ux-gate.mjs'), real.replaceAll('serviceBindingScope(', 'bindingScopeNotYet('));
    checkout.run('git', ['add', '-A']);
    const setup = checkout.run('git', ['commit', '-q', '--no-verify', '-m', 'the Tower calls an ingest the gate cannot read']);
    assert.equal(setup.status, 0, setup.stderr);

    copyFileSync(path.join(SCRIPTS_DIR, 'ux-gate.mjs'), path.join(checkout.root, 'scripts/ux-gate.mjs'));
    assert.equal(gateCli(checkout, []).status, 1, 'the legacy hint now fails until it is recorded');
    const widened = gateCli(checkout, ['--widen', 'ro-abcd.3', '--reason', 'the gate now follows the INGEST service binding']);
    assert.equal(widened.status, 0, widened.stderr);
    const baseline = JSON.parse(readFileSync(path.join(checkout.root, BASELINE_FILE), 'utf8'));
    assert.deepEqual(baseline.widenings.at(-1).files, ['workers/ingest/src/hint.ts']);
    checkout.run('git', ['add', '-A']);
    const commit = checkout.run('git', ['commit', '-q', '-m', 'the gate follows service bindings (ro-abcd.3)']);
    assert.equal(commit.status, 0, commit.stderr);
    assert.deepEqual(auditBaselineHistory(checkout.root).violations, []);
  });
});

test('CLI: a sentence split across + fails the gate in a Tower file and in a traced file (bead ro-ujb9.96.11)', () => {
  const inTower = scratchCheckout();
  writePanel(inTower.root, `<p>${LEGACY}</p>\n      <p title={"${HALF_ONE}" + "${HALF_TWO}"}>Sources</p>`);
  const tower = gateCli(inTower, []);
  assert.equal(tower.status, 1, 'the Tower file must fail');
  assert.match(tower.stderr, /apps\/tower\/src\/Panel\.tsx:6 {2}20 words \(label budget 12\)/);
  assert.ok(tower.stderr.trim().endsWith(NEXT_STEPS));

  const traced = renderedCheckout();
  traced.write('scripts/panel-copy.mts', `export const COPY = {\n  title: "Sources",\n  hint:\n    "${HALF_ONE}" +\n    "${HALF_TWO}",\n};\n`);
  const script = gateCli(traced, []);
  assert.equal(script.status, 1, 'the traced script must fail');
  assert.match(script.stderr, /scripts\/panel-copy\.mts:4 {2}20 words \(label budget 12\)/);
  assert.ok(script.stderr.trim().endsWith(NEXT_STEPS));
});

describe('a widening records text the Tower already rendered, once, and nothing else', () => {
  const REASON = 'the gate now reads scripts the Tower imports';
  const narrowGate = (checkout) => {
    // The gate before it learned to follow imports: a different file, and no
    // settings file yet (the legacy era, when only apps/tower was read).
    writeFileSync(path.join(checkout.root, 'scripts/ux-gate.mjs'), `${readFileSync(path.join(SCRIPTS_DIR, 'ux-gate.mjs'), 'utf8')}\n// before the widening\n`);
    rmSync(path.join(checkout.root, SETTINGS_FILE));
  };
  const realGate = (checkout) => {
    copyFileSync(path.join(SCRIPTS_DIR, 'ux-gate.mjs'), path.join(checkout.root, 'scripts/ux-gate.mjs'));
    writeScratchSettings(checkout.root);
  };
  /** History where the Tower already rendered LEGACY from a script the gate
   * could not read. The setup commit skips the hook on purpose: it stands for
   * the time before the gate followed imports. */
  const history = () => {
    const checkout = renderedCheckout({ git: true, commit: false });
    checkout.write('scripts/panel-copy.mts', `export const COPY = { title: "Sources", hint: "${LEGACY}" };\n`);
    narrowGate(checkout);
    checkout.run('git', ['add', '-A']);
    const setup = checkout.run('git', ['commit', '-q', '--no-verify', '-m', 'the Tower renders a script the gate cannot read']);
    assert.equal(setup.status, 0, setup.stderr);
    return checkout;
  };
  const baselineOf = (checkout) => JSON.parse(readFileSync(path.join(checkout.root, BASELINE_FILE), 'utf8'));

  test('--widen records it under the bead, the commit passes, and the history audit accepts it', () => {
    const checkout = history();
    realGate(checkout);
    const widened = gateCli(checkout, ['--widen', 'ro-abcd.2', '--reason', REASON]);
    assert.equal(widened.status, 0, widened.stderr);
    const baseline = baselineOf(checkout);
    assert.deepEqual(baseline.widenings, [{ bead: 'ro-abcd.2', reason: REASON, files: ['scripts/panel-copy.mts'] }]);
    assert.deepEqual(baseline.files['scripts/panel-copy.mts'], { count: 1, words: 18 });
    assert.equal(gateCli(checkout, []).status, 0);
    checkout.run('git', ['add', '-A']);
    const commit = checkout.run('git', ['commit', '-q', '-m', 'the gate follows imports (ro-abcd.2)']);
    assert.equal(commit.status, 0, commit.stderr);
    assert.deepEqual(auditBaselineHistory(checkout.root).violations, []);
    const again = gateCli(checkout, ['--widen', 'ro-abcd.3', '--reason', REASON]);
    assert.match(again.stdout, /nothing to widen/, 'a file enters through a widening once');

    // The widened file is now held like any other: new prose there fails.
    checkout.write('scripts/panel-copy.mts', `export const COPY = { title: "Sources", hint: "${LEGACY}", more: "${HELPER}" };\n`);
    assert.equal(gateCli(checkout, []).status, 1);

    // Records are append-only.
    checkout.write('scripts/panel-copy.mts', `export const COPY = { title: "Sources", hint: "${LEGACY}" };\n`);
    const edited = baselineOf(checkout);
    edited.widenings[0].reason = 'a different story about the widening';
    writeFileSync(path.join(checkout.root, BASELINE_FILE), serializeBaseline(edited));
    checkout.run('git', ['add', '-A']);
    assert.equal(checkout.run('git', ['commit', '-q', '--no-verify', '-m', 'rewrite the record']).status, 0);
    assert.ok(auditBaselineHistory(checkout.root).violations.some((violation) => /append-only/.test(violation)));
  });

  test('--widen refuses text written in the same change', () => {
    const checkout = history();
    realGate(checkout);
    checkout.write('scripts/panel-copy.mts', `export const COPY = { title: "Sources", hint: "${HELPER}" };\n`);
    const refused = gateCli(checkout, ['--widen', 'ro-abcd.2', '--reason', REASON]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already rendered at HEAD/);
    assert.ok(refused.stderr.trim().endsWith(NEXT_STEPS));
    assert.equal(baselineOf(checkout).widenings, undefined, 'nothing was recorded');
  });

  const handWidened = (checkout, files, bead = 'ro-abcd.2') => {
    const baseline = baselineOf(checkout);
    baseline.widenings = [...(baseline.widenings ?? []), { bead, reason: REASON, files }];
    for (const file of files) baseline.files[file] = { count: 1, words: 20 };
    writeFileSync(path.join(checkout.root, BASELINE_FILE), serializeBaseline(baseline));
  };
  const refusedCommit = (checkout, pattern) => {
    checkout.run('git', ['add', '-A']);
    const commit = checkout.run('git', ['commit', '-q', '-m', 'widen']);
    assert.notEqual(commit.status, 0, 'the pre-commit hook must refuse this widening');
    assert.match(commit.stderr, pattern);
    assert.ok(commit.stderr.trim().endsWith(NEXT_STEPS));
    const bypassed = checkout.run('git', ['commit', '-q', '--no-verify', '-m', 'widen anyway']);
    assert.equal(bypassed.status, 0, bypassed.stderr);
    assert.ok(auditBaselineHistory(checkout.root).violations.some((violation) => pattern.test(violation)),
      'the history audit must find the bypassed widening');
  };

  test('a widening that admits changed text is refused at commit and found in history', () => {
    const checkout = history();
    realGate(checkout);
    checkout.write('scripts/panel-copy.mts', `export const COPY = { title: "Sources", hint: "${HELPER}" };\n`);
    handWidened(checkout, ['scripts/panel-copy.mts']);
    refusedCommit(checkout, /new or changed in the same change/);
  });

  test('a widening without the gate change that widens the scan is refused', () => {
    const checkout = history();
    handWidened(checkout, ['scripts/panel-copy.mts']);
    refusedCommit(checkout, /must come with the change that widens the gate/);
  });

  test('a widening of a file the Tower did not import before is refused', () => {
    const checkout = history();
    realGate(checkout);
    checkout.write('apps/tower/src/Copy.tsx', `${readFileSync(path.join(checkout.root, 'apps/tower/src/Copy.tsx'), 'utf8')}import { NEVER_RENDERED } from "../../../scripts/panel-types.mjs";\nexport const Late = () => <p>{NEVER_RENDERED}</p>;\n`);
    handWidened(checkout, ['scripts/panel-copy.mts', 'scripts/panel-types.mts']);
    refusedCommit(checkout, /panel-types\.mts was not imported by the Tower before this change/);
  });

  test('a widening can never cover a file the gate already read', () => {
    const checkout = history();
    realGate(checkout);
    handWidened(checkout, ['scripts/panel-copy.mts', 'apps/tower/src/Copy.tsx']);
    refusedCommit(checkout, /Copy\.tsx was already read by the gate/);
  });

  test('a bead widens once and a file is widened once', () => {
    const reused = validateBaseline(
      { widenings: [{ bead: 'ro-abcd.2', reason: REASON, files: ['a.ts'] }, { bead: 'ro-abcd.2', reason: REASON, files: ['b.ts'] }], files: {} },
      { prefixes: ['ro'], readFile: briefs },
    );
    assert.match(reused[0], /already widened the gate once/);
  });
});

// ---------------------------------------------------------------------------
// The gate's own rules cannot be loosened by an agent (bead ro-ujb9.96.3)
// ---------------------------------------------------------------------------

describe('the budgets, scan directories and skipped files live in a protected, audited settings file', () => {
  const settingsJson = () => JSON.parse(readFileSync(path.join(REPO_ROOT, SETTINGS_FILE), 'utf8'));

  test('the gate takes its rules from the settings file, which holds the decided values', () => {
    const json = settingsJson();
    assert.deepEqual(SETTINGS.budgets, { label: json.budgets.label.words, failure: json.budgets.failure.words, accessible: json.budgets.accessible.words });
    assert.deepEqual([...SETTINGS.scanDirs], json.scanDirs);
    assert.deepEqual([...SETTINGS.traceRoots], json.traceRoots);
    assert.deepEqual([...NOT_DESK_COPY.keys()], Object.keys(json.notDeskCopy));
    // Nothing has been loosened since the constants moved into the file.
    assert.deepEqual(settingsLoosenings(LEGACY_SETTINGS, json, { prefixes: ['ro'] }), []);
    assert.deepEqual(validateSettings(json, { prefixes: ['ro'], exists: (rel) => existsSync(path.join(REPO_ROOT, rel)) }), []);
  });

  const approvedEntry = { ...approved };
  const check = (next, previous = LEGACY_SETTINGS, pathExists = () => true) =>
    settingsLoosenings(previous, next, { prefixes: ['ro'], readFile: briefs, pathExists });
  const withChange = (change) => {
    const next = structuredClone(LEGACY_SETTINGS);
    change(next);
    return next;
  };

  test('raising a budget needs the same four-key, fresh approval as a baseline raise', () => {
    const [bare] = check(withChange((next) => { next.budgets.label = { words: 14 }; }));
    assert.match(bare, /budgets\.label: 12 → 14 words loosens the gate without a valid exception/);
    assert.match(bare, /kind must be one of trust-safety, legal, destructive-confirmation/);
    const approvedRaise = withChange((next) => { next.budgets.label = { words: 14, ...approvedEntry }; });
    assert.deepEqual(check(approvedRaise), []);
    const again = withChange((next) => { next.budgets.label = { words: 16, ...approvedEntry }; });
    assert.match(check(again, approvedRaise)[0], /reuses the approval of an earlier raise/);
    for (const kind of ['label', 'failure', 'accessible']) {
      assert.deepEqual(check(withChange((next) => { next.budgets[kind] = { words: 5 }; })), [], `lowering ${kind} is free`);
    }
  });

  test('skipping a file needs the approval; un-skipping it is free', () => {
    const skip = (entry) => withChange((next) => { next.notDeskCopy['apps/tower/src/Panel.tsx'] = entry; });
    const [bare] = check(skip({ reason: 'it is only a helper panel' }));
    assert.match(bare, /notDeskCopy \+ apps\/tower\/src\/Panel\.tsx: skipping a file loosens the gate/);
    assert.deepEqual(check(skip({ ...approvedEntry })), []);
    assert.deepEqual(check(withChange((next) => { delete next.notDeskCopy['apps/tower/shared/materiality.ts']; })), []);
  });

  test('a scan directory or trace root leaves only when it no longer exists; adding one is free', () => {
    const dropped = withChange((next) => { next.scanDirs = next.scanDirs.filter((dir) => dir !== 'apps/tower/worker'); });
    assert.match(check(dropped)[0], /scanDirs − apps\/tower\/worker: the gate stops reading a path that still exists/);
    assert.deepEqual(check(dropped, LEGACY_SETTINGS, (rel) => rel !== 'apps/tower/worker'), [], 'a deleted directory leaves freely');
    const noRoot = withChange((next) => { next.traceRoots = []; });
    assert.match(check(noRoot)[0], /traceRoots − apps\/tower\/vite\.config\.ts/);
    assert.deepEqual(check(withChange((next) => { next.scanDirs.push('apps/tower/vite'); next.traceRoots.push('apps/tower/index.html'); })), []);
  });

  test('the schema refuses an unknown rule, a budget without words and a reasonless skip', () => {
    const errors = (change) => validateSettings(withChange(change), { prefixes: ['ro'], readFile: briefs });
    assert.match(errors((next) => { next.skipDirs = ['apps/tower/src']; })[0], /skipDirs: unknown key/);
    assert.match(errors((next) => { next.budgets.label = 30; })[0], /budgets\.label must be \{ "words": <positive integer> \}/);
    assert.match(errors((next) => { next.budgets.headline = { words: 40 }; })[0], /budgets\.headline: unknown budget/);
    assert.match(errors((next) => { next.notDeskCopy['apps/tower/src/Panel.tsx'] = {}; })[0], /why the desk never shows this file/);
    assert.match(errors((next) => { next.scanDirs = []; })[0], /at least one directory/);
  });

  test('the edit hook refuses the settings file like the baseline', () => {
    assert.ok(PROTECTED_FILES.includes(SETTINGS_FILE));
    assert.ok(PROTECTED_SETTINGS_MESSAGE.endsWith(NEXT_STEPS));
    const checkout = scratchCheckout();
    const target = path.join(checkout.root, SETTINGS_FILE);
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      const result = decide('pre', { tool_name: tool, tool_input: { file_path: target } });
      assert.equal(result.code, 2, `${tool} on the settings must be blocked`);
      assert.equal(result.stderr, PROTECTED_SETTINGS_MESSAGE);
    }
    for (const command of [
      `sed -i '' 's/12/30/' ${SETTINGS_FILE}`,
      `echo '{}' > ${SETTINGS_FILE}`,
      `node -e "require('fs').writeFileSync('${SETTINGS_FILE}', '{}')"`,
    ]) {
      assert.equal(decide('pre', { tool_name: 'Bash', tool_input: { command } }).code, 2, `must block: ${command}`);
    }
    assert.equal(decide('pre', { tool_name: 'Bash', tool_input: { command: `cat ${SETTINGS_FILE}` } }).code, 0);
  });

  test('an unapproved skip-list addition fails the commit, CI and, when forced in, the history audit', () => {
    const checkout = scratchCheckout({ git: true });
    // The loosening an agent would try: skip the file, then add the paragraph.
    const settingsPath = path.join(checkout.root, SETTINGS_FILE);
    const loosened = JSON.parse(readFileSync(settingsPath, 'utf8'));
    loosened.notDeskCopy['apps/tower/src/Panel.tsx'] = { reason: 'a helper panel nobody reads' };
    writeFileSync(settingsPath, `${JSON.stringify(loosened, null, 2)}\n`);
    writePanel(checkout.root, `<p>${LEGACY}</p>\n      <p>${HELPER}</p>`);

    const whole = gateCli(checkout, []);
    assert.equal(whole.status, 1, 'CI must refuse the loosened settings');
    assert.match(whole.stderr, /ux-gate\.settings\.json was loosened without a valid exception/);
    assert.match(whole.stderr, /notDeskCopy \+ apps\/tower\/src\/Panel\.tsx/);
    assert.ok(whole.stderr.trim().endsWith(NEXT_STEPS));

    checkout.run('git', ['add', '-A']);
    const commit = checkout.run('git', ['commit', '-q', '-m', 'skip the panel']);
    assert.notEqual(commit.status, 0, 'the pre-commit hook must refuse the loosened settings');
    assert.match(commit.stderr, /notDeskCopy \+ apps\/tower\/src\/Panel\.tsx: skipping a file loosens the gate/);

    const bypassed = checkout.run('git', ['commit', '-q', '--no-verify', '-m', 'skip the panel anyway']);
    assert.equal(bypassed.status, 0, bypassed.stderr);
    const { violations } = auditSettingsHistory(checkout.root);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /notDeskCopy \+ apps\/tower\/src\/Panel\.tsx: skipping a file loosens the gate/);
    assert.equal(gateCli(checkout, []).status, 1, 'the committed loosening still fails CI');
  });

  test('the settings file is never deleted, and its first version is judged against the legacy constants', () => {
    const checkout = scratchCheckout({ git: true, commit: false });
    rmSync(path.join(checkout.root, SETTINGS_FILE));
    checkout.run('git', ['add', '-A']);
    assert.equal(checkout.run('git', ['commit', '-q', '-m', 'before the settings file']).status, 0);
    const looser = structuredClone(LEGACY_SETTINGS);
    looser.notDeskCopy = {};
    looser.budgets.failure = { words: 30 };
    writeFileSync(path.join(checkout.root, SETTINGS_FILE), `${JSON.stringify(looser, null, 2)}\n`);
    checkout.run('git', ['add', '-A']);
    const introduced = checkout.run('git', ['commit', '-q', '-m', 'introduce looser settings']);
    assert.notEqual(introduced.status, 0);
    assert.match(introduced.stderr, /budgets\.failure: 18 → 30 words/);
    assert.equal(checkout.run('git', ['commit', '-q', '--no-verify', '-m', 'forced']).status, 0);
    assert.match(auditSettingsHistory(checkout.root).violations[0], /budgets\.failure: 18 → 30 words/);

    checkout.run('git', ['rm', '-q', SETTINGS_FILE]);
    const deleted = checkout.run('git', ['commit', '-q', '-m', 'drop the rules']);
    assert.notEqual(deleted.status, 0);
    assert.match(deleted.stderr, /staged for deletion; the gate's rules are never deleted/);
    const missing = gateCli(checkout, []);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ux-gate\.settings\.json is missing/);
  });
});

test('the gate reads what the Tower renders from scripts/, packages/contract and every config document', async () => {
  const files = gateFiles(REPO_ROOT);
  for (const name of [
    'scripts/config-registers.mts',
    'scripts/scheduled-jobs.mts',
    'scripts/workflow-definitions.mts',
    'packages/contract/src/integrations.ts',
    'config/integrations.json',
  ]) {
    assert.ok(files.includes(name), `${name} must be in the scan`);
  }
  for (const file of files) {
    if (file.endsWith('.mjs')) assert.ok(!existsSync(path.join(REPO_ROOT, file.replace(/\.mjs$/, '.mts'))), `${file} is generated; its .mts is measured`);
  }
  const { CONFIG_DOCUMENT_FILES } = await import('./config-documents.mjs');
  for (const document of CONFIG_DOCUMENT_FILES) {
    assert.ok(files.includes(document), `${document} is served to the Tower by the config store, so the gate must read it`);
  }
});

// ---------------------------------------------------------------------------
// The whole Tower (the CI gate)
// ---------------------------------------------------------------------------

test('the gate reads the whole Tower, shared/ and worker/ included, minus only the excluded files', () => {
  const files = towerFiles(REPO_ROOT);
  assert.ok(files.length > 150, `only ${files.length} Tower files found — the walk did not resolve`);
  for (const name of [
    'apps/tower/src/routes/SettingsRoute.tsx',
    'apps/tower/shared/integrations.ts',
    'apps/tower/worker/integrations-payload.ts',
  ]) {
    assert.ok(files.includes(name), `${name} must be in the scan`);
  }
  for (const [name, reason] of NOT_DESK_COPY) {
    assert.ok(!files.includes(name));
    assert.ok(existsSync(path.join(REPO_ROOT, name)), `${name} is excluded (${reason}) but no longer exists — prune NOT_DESK_COPY`);
  }
});

// THE GATE'S OWN WORK, NOT THE HOST'S CLOCK (bead `ro-ujb9.187`). The speed
// check was wall-clock — "the whole-Tower gate took 5489ms; it must stay under
// a few seconds" failed `pnpm test:scripts` on 2026-09-24 while five agents
// and a journey run shared the Mac, and the same gate took 2510 ms alone. What
// it guards is the gate's cost per file it reads, so that is what it counts:
// this thread's CPU time (`process.threadCpuUsage`, the process's where that
// is missing). Other processes take cores away, which lengthens the wall clock
// and not this; neither does waiting on git. 8 ms a file is the old "a few
// seconds" for the whole Tower (~3.8 s at 471 files) with room for a slower
// runner or an efficiency core; the gate spends ~1–2 ms a file on the office
// Mac. It still trips when the gate's own per-file work grows (next test).
const GATE_CPU_MS_PER_FILE = 8;

/** This thread's CPU clock, in ms since `since` (the process's where Node has
 * no per-thread clock). */
function cpuClock(since) {
  const usage = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage(since) : process.cpuUsage(since);
  return { usage, ms: (usage.user + usage.system) / 1000 };
}

/** This thread's CPU time, in ms, spent running `work`. */
function ownCpuMs(work) {
  const { usage } = cpuClock();
  work();
  return cpuClock(usage).ms;
}

/** The speed check: null, or why the gate's own work is too slow. */
function gateTooSlow(cpuMs, files) {
  const perFile = cpuMs / Math.max(files, 1);
  return perFile < GATE_CPU_MS_PER_FILE
    ? null
    : `the gate spent ${perFile.toFixed(1)} ms of its own CPU a file over ${files} files; it must stay under ${GATE_CPU_MS_PER_FILE}`;
}

test('no Tower file gained explanatory prose, and the baseline is tight (bead ro-ujb9.94)', (t) => {
  let result;
  const wall = performance.now();
  const cpuMs = ownCpuMs(() => {
    result = checkTower(REPO_ROOT);
  });
  t.diagnostic(`whole-Tower gate: ${result.files.length} files, ${Math.round(cpuMs)} ms own CPU, ${Math.round(performance.now() - wall)} ms wall (not judged)`);
  assert.equal(result.message, '', `\n${result.message}`);
  assert.deepEqual(result.retired, [], 'no retired term is on screen (bead ro-ujb9.135)');
  assert.equal(gateTooSlow(cpuMs, result.files.length), null);
  // The bead's own example — a setup step's `note:` paragraph in a payload
  // builder — was redesigned away (bead ro-ujb9.96.6.1: the step is its glyph
  // and label). The reader still reads that file, and finds nothing there; the
  // synthetic `note:` case above proves the same position is still measured.
  const held = result.measured['apps/tower/shared/integrations.ts'];
  assert.ok(held, 'the reader must still read the file the bead was filed about');
  assert.equal(held.count, 0, 'the paragraph the bead was filed about is gone, and nothing replaced it');
});

/** Spend `ms` of this thread's CPU — a step no other process can make cheaper
 * or dearer, because it is counted on the same clock the speed check reads. */
function burnCpu(ms) {
  const { usage } = cpuClock();
  while (cpuClock(usage).ms < ms) {
    // spinning is the step
  }
}

test('the speed check still trips when the gate spends more of its own work on each file (bead ro-ujb9.187)', () => {
  // The per-file work is `measure`: one parse and one walk of each file. The
  // same compiler with one slow step more per parse must fail the check that
  // the real one passes over the same files.
  const ts = loadTypeScript([REPO_ROOT]);
  const tree = workingTree(REPO_ROOT);
  const files = gateFiles(REPO_ROOT, tree).slice(0, 24);
  assert.equal(files.length, 24);
  const gate = (compiler) => ownCpuMs(() => measure(files, { root: REPO_ROOT, ts: compiler, tree, settings: SETTINGS, renderErrorsShown: true }));
  assert.equal(gateTooSlow(gate(ts), files.length), null, 'the real gate over these files is within the budget');

  const slower = Object.create(ts, {
    createSourceFile: {
      value(...args) {
        burnCpu(GATE_CPU_MS_PER_FILE + 2);
        return ts.createSourceFile(...args);
      },
    },
  });
  assert.match(gateTooSlow(gate(slower), files.length) ?? 'passed', /own CPU a file over 24 files; it must stay under 8$/);
});
