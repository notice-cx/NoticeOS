import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACCESSIBLE_NAME_WORD_BUDGET,
  FAILURE_WORD_BUDGET,
  LABEL_WORD_BUDGET,
  NOT_DESK_COPY,
  SETTINGS,
  SETTINGS_FILE,
  countWords,
  extractVisibleStrings,
  formatReport,
  gateFiles,
  importSpecifiers,
  loadTypeScript,
  longStrings,
  measure,
  overBudget,
  report,
  towerFiles,
  traceScope,
  workingTree,
} from './ux-gate.mjs';

// The UX text report reads every string the Tower can show a person and
// lists the long ones. This suite proves the reading: what counts as visible,
// how words are counted, and how far the reader follows the Tower's imports.
// It does not assert that the Tower meets any budget: the report informs
// design review and never fails a build.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const ts = loadTypeScript([REPO_ROOT]);

const HELPER =
  'Before you connect a source, read this: the numbers below only update after the nightly job has run successfully twice.';

const words = (n, word = 'word') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const extract = (source, file = 'apps/tower/src/Panel.tsx') => extractVisibleStrings(source, file, ts);
const over = (source, file) => overBudget(extract(source, file));

const scratchRoots = [];
after(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

test('the thresholds come from the settings file', () => {
  assert.equal(LABEL_WORD_BUDGET, SETTINGS.budgets.label);
  assert.equal(FAILURE_WORD_BUDGET, SETTINGS.budgets.failure);
  assert.equal(ACCESSIBLE_NAME_WORD_BUDGET, SETTINGS.budgets.accessible);
  assert.equal(countWords(HELPER), 20);
});

test('words are tokens with a letter or digit; separators are not; an interpolation is one', () => {
  assert.equal(countWords('Search clicks · 28d — ▲ 4%'), 4);
  assert.equal(countWords('${…} of ${…} sources'), 4);
  assert.equal(countWords('   '), 0);
});

// ---------------------------------------------------------------------------
// What is visible
// ---------------------------------------------------------------------------

describe('a 20-word sentence is read wherever it can reach a person', () => {
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
      assert.equal(found.length, 1, `expected one long string, got ${JSON.stringify(found, null, 2)}`);
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
  assert.deepEqual(extract(source).map((entry) => entry.text), ['Six words of text right here', 'Five more words right here']);
});

test('the longest branch of a conditional is the one judged', () => {
  const found = over(`export const A = ({ ok }) => <p>{ok ? "Saved" : "${HELPER}"}</p>;`);
  assert.equal(found.length, 1);
  assert.equal(found[0].words, 20);
});

const HALF_ONE = 'Before you connect a source, read this: the numbers below ';
const HALF_TWO = 'only update after the nightly job has run successfully twice.';

describe('a sentence joined with + is measured as one string', () => {
  const cases = [
    ['a Tower constant', 'apps/tower/src/Panel.tsx', `export const NOTE = "${HALF_ONE}" + "${HALF_TWO}";`, 20],
    ['a JSX child', 'apps/tower/src/Panel.tsx', `export const A = () => <p>{"${HALF_ONE}" + "${HALF_TWO}"}</p>;`, 20],
    ['a prop, with a value spliced in', 'apps/tower/src/Panel.tsx', `export const A = (n: number) => <Panel hint={"${HALF_ONE}" + n + " ${HALF_TWO}"} />;`, 21],
    ['template pieces', 'apps/tower/shared/x.ts', 'export const note = (n: number) => `' + HALF_ONE + '` + `${n} ' + HALF_TWO + '`;', 21],
    ['a traced script module', 'scripts/panel-copy.mts', `export const COPY = { hint: "${HALF_ONE}" + "${HALF_TWO}" };`, 20],
  ];
  for (const [name, file, source, expected] of cases) {
    test(name, () => {
      const found = over(source, file);
      assert.equal(found.length, 1, `expected the joined sentence once, got ${JSON.stringify(found, null, 2)}`);
      assert.equal(found[0].words, expected);
      assert.equal(extract(source, file).filter((entry) => entry.text.includes('nightly')).length, 1, 'no half is measured again on its own');
    });
  }

  test('arithmetic, class lists, keys, SQL and terminal output are still not text', () => {
    const source = [
      'export const total = count + 1;',
      'export const A = ({ extra }) => <p className={"flex items-center gap-2 " + extra} key={"row-" + extra}>x</p>;',
      `export const sql = "SELECT id, asset_id FROM noticeos.flags " + "WHERE severity = 'error' AND kind IS NOT NULL";`,
      `process.stderr.write("${HALF_ONE}" + "${HALF_TWO}");`,
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

describe('strings nobody reads are never counted', () => {
  const classes = 'inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2';
  const cases = [
    ['className', `export const A = () => <div className="${classes}" />;`],
    ['cn() arguments', `export const A = () => <div className={cn("${classes}", open && "ring-2")} />;`],
    ['a class list in any variable (by shape)', `const base = "${classes}";`],
    ['data-* attributes', `export const A = () => <div data-audit-note="${HELPER}" />;`],
    ['a type', `type Copy = "${HELPER}";`],
    ['a property name', `const map = { "${HELPER}": 1 };`],
    ['a comparison', `if (value === "${HELPER}") run();`],
    ['console output', `console.warn("${HELPER}");`],
    ['SQL', 'db.prepare("SELECT id, name, kind FROM assets WHERE retired_at IS NULL AND kind = ? ORDER BY name");'],
    ['SVG geometry', 'export const A = () => <path d="M 0 0 L 10 10 L 20 5 L 30 12 L 40 2 L 50 9 L 60 1 L 70 8 Z" />;'],
    ['a tagged template', `const style = css\`${HELPER}\`;`],
  ];
  for (const [name, source] of cases) {
    test(name, () => assert.deepEqual(over(source), [], `${name} must not be read as copy`));
  }
});

describe('failure messages and accessible names have their own thresholds', () => {
  const sixteen = words(16);
  const twenty = words(20);
  test('toast.error is a failure; toast.success with the same words is a label', () => {
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
    const [long] = over(`export const A = () => <svg aria-label="${words(26)}" />;`);
    assert.equal(long.kind, 'accessible');
    assert.equal(long.budget, ACCESSIBLE_NAME_WORD_BUDGET);
  });
});

describe('a message only a developer can see is not counted; one an error boundary shows is', () => {
  const thrown = `throw new Error("${HELPER}");`;
  const hidden = (source) => overBudget(extractVisibleStrings(source, 'apps/tower/src/Panel.tsx', ts, { renderErrorsShown: false }));
  const shown = (source) => overBudget(extractVisibleStrings(source, 'apps/tower/src/Panel.tsx', ts, { renderErrorsShown: true }));
  test('thrown while a component renders: console only, unless a boundary shows it', () => {
    const source = `export function Panel({ a, b }) {\n  if (a && b) ${thrown}\n  return <p>Sources</p>;\n}`;
    assert.deepEqual(hidden(source), []);
    const [counted] = shown(source);
    assert.equal(counted?.kind, 'failure');
  });
  test('thrown from an event handler or a plain function: still counted', () => {
    assert.equal(hidden(`export function Panel() {\n  const save = () => { ${thrown} };\n  return <button onClick={save}>Save</button>;\n}`).length, 1);
    assert.equal(hidden(`export function parse(value) {\n  if (!value) ${thrown}\n  return value;\n}`).length, 1);
  });
});

// ---------------------------------------------------------------------------
// How far the reader follows the Tower
// ---------------------------------------------------------------------------

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

function scratchCheckout() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ux-gate-')));
  scratchRoots.push(root);
  mkdirSync(path.join(root, 'apps/tower/src'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'config'), { recursive: true });
  // The copied report resolves typescript from its own checkout, as it does live.
  symlinkSync(path.join(REPO_ROOT, 'apps/tower/node_modules'), path.join(root, 'apps/tower/node_modules'));
  writeFileSync(path.join(root, 'apps/tower/package.json'), '{"name":"scratch-tower","private":true}\n');
  copyFileSync(path.join(SCRIPTS_DIR, 'ux-gate.mjs'), path.join(root, 'scripts/ux-gate.mjs'));
  const settings = JSON.parse(readFileSync(path.join(SCRIPTS_DIR, 'ux-gate.settings.json'), 'utf8'));
  settings.notDeskCopy = {};
  writeFileSync(path.join(root, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
  const write = (rel, text) => {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  const cli = (args = []) => spawnSync(process.execPath, [path.join(root, 'scripts/ux-gate.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  return { root, write, cli };
}

/** A scratch Tower that renders text from outside apps/tower: a script
 * module (authored .mts beside its generated .mjs), a workspace package
 * reached through its exports map, and a config document the Vite config
 * compiles in. */
function renderedCheckout() {
  const checkout = scratchCheckout();
  checkout.write('scripts/panel-copy.mts', 'export const COPY = { title: "Sources" };\n');
  checkout.write('scripts/panel-copy.mjs', '// Generated. Edit the sibling .mts source.\nexport const COPY = { title: "Sources" };\n');
  checkout.write('scripts/panel-types.mts', `export type Shape = { hint: string };\nexport const NEVER_RENDERED = "${HELPER}";\n`);
  checkout.write('packages/contract/package.json', JSON.stringify({ name: '@scratch/contract', exports: { '.': './src/index.ts', './*': './src/*.ts' } }));
  checkout.write('packages/contract/src/index.ts', 'export const VERSION = "1";\n');
  checkout.write('packages/contract/src/labels.ts', 'export const LABELS = { connect: "Connect a source" };\n');
  checkout.write('config/doc.json', `${JSON.stringify({ lanes: [{ id: 'gsc', note: 'Live.' }] }, null, 2)}\n`);
  checkout.write('apps/tower/vite.config.ts', 'import doc from "../../config/doc.json";\nexport default { define: { __DOC__: JSON.stringify(doc) } };\n');
  checkout.write('apps/tower/src/Copy.tsx', [
    'import { COPY } from "../../../scripts/panel-copy.mjs";',
    'import type { Shape } from "../../../scripts/panel-types.mjs";',
    'import { LABELS } from "@scratch/contract/labels";',
    'export const Copy = (props: Shape) => <p>{COPY.title} {LABELS.connect} {props.hint}</p>;',
    '',
  ].join('\n'));
  return checkout;
}

test('the reader follows the Tower into scripts, workspace packages and config documents', () => {
  const checkout = renderedCheckout();
  const scope = traceScope(workingTree(checkout.root));
  assert.deepEqual(scope.traced, ['config/doc.json', 'packages/contract/src/labels.ts', 'scripts/panel-copy.mts']);
  assert.ok(!scope.files.includes('scripts/panel-copy.mjs'), 'a generated .mjs is measured as its authored .mts');
  assert.ok(!scope.files.includes('scripts/panel-types.mts'), 'a type-only import carries no text');
  assert.ok(!scope.files.includes('apps/tower/vite.config.ts'), 'the Vite config is followed, not measured');
});

test('a paragraph in a traced file is listed, and the report still exits 0', () => {
  const checkout = renderedCheckout();
  checkout.write('config/doc.json', `${JSON.stringify({ lanes: [{ id: 'gsc', note: HELPER }] }, null, 2)}\n`);
  const measured = report({ root: checkout.root });
  const long = longStrings(measured);
  assert.equal(long.length, 1);
  assert.equal(long[0].file, 'config/doc.json');
  assert.equal(long[0].words, 20);
  const text = formatReport(measured);
  assert.match(text, /^UX text report: 1 long string\(s\) in 1 of \d+ file\(s\)/);
  assert.ok(text.includes('config/doc.json:'), text);
  assert.ok(text.includes('Before you connect a source'), text);

  const run = checkout.cli();
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes('config/doc.json:'), run.stdout);
  const json = JSON.parse(checkout.cli(['--json']).stdout);
  assert.equal(json.long.length, 1);
  assert.equal(checkout.cli(['--files', 'apps/tower/src/Copy.tsx']).status, 0);
});

test('the reader follows the Tower\'s service binding into the ingest it calls', () => {
  const checkout = renderedCheckout();
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
  const scope = traceScope(workingTree(checkout.root));
  for (const file of ['workers/ingest/src/index.ts', 'workers/ingest/src/probes.ts', 'workers/ingest/src/hint.ts']) {
    assert.ok(scope.traced.includes(file), `${file} must be read: ${scope.traced.join(', ')}`);
  }
  assert.ok(!scope.files.includes('workers/ingest/src/pulse.ts'), 'a route only sites call is not Tower text');
});

test('the reader reads what the Tower renders from scripts/, packages/contract and every config document', async () => {
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
    assert.ok(files.includes(document), `${document} is served to the Tower by the config store, so the report must read it`);
  }
});

test('the reader reads the whole Tower, shared/ and worker/ included, minus only the excluded files', () => {
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
    assert.ok(existsSync(path.join(REPO_ROOT, name)), `${name} is excluded (${reason}) but no longer exists — prune notDeskCopy`);
  }
});

test('the whole-Tower report runs and never fails on what it finds', () => {
  const tree = workingTree(REPO_ROOT);
  const measured = measure(gateFiles(REPO_ROOT, tree), { root: REPO_ROOT, tree });
  assert.ok(Object.keys(measured).length > 150);
  assert.match(formatReport(measured), /^UX text report: \d+ long string\(s\)/);
});
