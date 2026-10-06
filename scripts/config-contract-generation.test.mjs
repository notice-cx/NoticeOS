import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ASSET_ID_RE, CONFIG_ASSET_KEY_RE } from '../packages/contract/src/configuration.mjs';
import { CONFIG_DOCUMENT_FILES } from './config-documents.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const PROJECTS = ['tsconfig.config-contract.json', 'tsconfig.config-contract.node.json'];

/** Every authored `scripts/*.mts` source (declarations excluded). */
function authoredScripts() {
  return readdirSync(path.join(repo, 'scripts'))
    .filter((name) => name.endsWith('.mts') && !name.endsWith('.d.mts'))
    .map((name) => `scripts/${name}`);
}

/** A throwaway copy of every generation input, so a test can make it stale:
 * both projects, every authored source, hand-written declaration and plain
 * JavaScript script under scripts/ (a Node-only source may compile against
 * one — scripts/postgres-test-cluster.mts reads the Postgres development
 * profile's implementation), and the package sources the projects list or
 * import (the contract, and the Postgres helper, bead ro-ujb9.76.18). */
async function withGenerationRoot(work) {
  const root = mkdtempSync(path.join(tmpdir(), 'config-generation-test-'));
  try {
    const scripts = readdirSync(path.join(repo, 'scripts')).filter((name) => /\.m[tj]s$/u.test(name)).map((name) => `scripts/${name}`);
    for (const file of ['tsconfig.base.json', ...PROJECTS, 'scripts/generate-config-contract.mjs', ...scripts]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      cpSync(path.join(repo, file), path.join(root, file));
    }
    for (const dir of ['packages/contract/src', 'packages/postgres/src', 'apps/tower/shared', 'packages/mediavine/src']) {
      cpSync(path.join(repo, dir), path.join(root, dir), { recursive: true });
    }
    // Compile the actual task-row type dependency and its relative imports,
    // without borrowing the Tower's ambient types or installing dependencies.
    cpSync(path.join(repo, 'packages/contract/package.json'), path.join(root, 'packages/contract/package.json'));
    mkdirSync(path.join(root, 'apps/tower/node_modules/@noticeos'), { recursive: true });
    symlinkSync(path.join(root, 'packages/contract'), path.join(root, 'apps/tower/node_modules/@noticeos/contract'));
    // The compiler must see the exact imported product-default types. Copy only
    // the canonical neutral documents; the read guard permits this test's
    // declared source inputs and continues to refuse installation documents.
    mkdirSync(path.join(root, 'config'), { recursive: true });
    for (const file of CONFIG_DOCUMENT_FILES) writeFileSync(path.join(root, file), readFileSync(path.join(repo, file)));
    // TypeScript and zod for the contract; croner for the runner and the root's
    // own @types/node for the Node-only project (ro-ujb9.99); the Postgres
    // driver's types for its helper — linked, never copied. The Tower's
    // ambient dependencies are deliberately absent; its private node_modules
    // contains only the copied contract package needed by its shared types.
    for (const dir of ['node_modules', 'packages/contract/node_modules', 'packages/postgres/node_modules']) {
      mkdirSync(path.dirname(path.join(root, dir)), { recursive: true });
      symlinkSync(path.join(repo, dir), path.join(root, dir));
    }
    const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/generate-config-contract.mjs'), ...args], { encoding: 'utf8' });
    return await work(root, run);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Replace exactly one occurrence of `from` in a copied source. */
function edit(root, file, from, to) {
  const target = path.join(root, file);
  const before = readFileSync(target, 'utf8');
  assert.equal(before.split(from).length, 2, `${file} holds exactly one ${JSON.stringify(from)}`);
  writeFileSync(target, before.replace(from, to));
}

// Bead ro-ujb9.61: an authored source no project lists would compile nowhere,
// and its committed .mjs/.d.mts could drift with every gate green.
test('every authored scripts/*.mts belongs to exactly one generation project', () => {
  const listed = PROJECTS.flatMap((project) => JSON.parse(readFileSync(path.join(repo, project), 'utf8')).include);
  for (const source of authoredScripts()) {
    assert.equal(listed.filter((file) => file === source).length, 1, `${source} must be in one of ${PROJECTS.join(', ')}`);
  }
  assert.ok(authoredScripts().includes('scripts/scheduled-jobs.mts') && authoredScripts().includes('scripts/workflow-history.mts'),
    'the walk found the shared runtime sources');
});

// The portable project is what keeps the Worker- and browser-imported modules
// free of Node: it compiles with no ambient types at all.
test('a node: import in a portable source fails generation', async () => {
  await withGenerationRoot((root, run) => {
    edit(root, 'scripts/scheduled-jobs.mts', "export const SCHEDULES_FILE = ", "import { sep } from 'node:path';\nexport const SCHEDULES_SEP = sep;\nexport const SCHEDULES_FILE = ");
    const generated = run();
    assert.notEqual(generated.status, 0);
    assert.match(generated.stdout, /scripts\/scheduled-jobs\.mts.*node:path/);
  });
});

// Bead ro-ujb9.61, the deliberate mismatch: a runtime that starts returning a
// different shape than its callers compile against is a type error, not a
// green gate and a broken caller.
test('a return shape the declared contract does not allow fails generation', async () => {
  await withGenerationRoot((root, run) => {
    edit(root, 'scripts/workflow-trace.mts',
      "return { state: 'skipped', summary: 'No work was performed on this pass.' };",
      "return { status: 'skipped', summary: 'No work was performed on this pass.' };");
    const generated = run();
    assert.notEqual(generated.status, 0);
    assert.match(generated.stdout, /scripts\/workflow-trace\.mts\(\d+,\d+\): error TS/);
    assert.equal(run('--check').status, 1);
  });
});

test('plain Node preserves the distinct asset and configuration-reference vocabularies', () => {
  assert.equal(ASSET_ID_RE.test('asset_name'), false);
  assert.equal(CONFIG_ASSET_KEY_RE.test('asset_name'), true);
  assert.equal(ASSET_ID_RE.test('-asset'), true);
  assert.equal(CONFIG_ASSET_KEY_RE.test('-asset'), false);
  assert.equal(ASSET_ID_RE.test('nosh.example'), true);
  assert.equal(CONFIG_ASSET_KEY_RE.test('nosh.example'), true);
});

test('generation checks reject stale runtime, stale types, and missing output without repairing them', async () => {
  await withGenerationRoot((root, run) => {
    const generated = run();
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    assert.equal(run('--check').status, 0);
    // Each check compiles both projects, so one check judges every stale and
    // missing file together: it must name each one and repair none.
    const stale = [
      'packages/contract/src/configuration.mjs', 'packages/contract/src/posthog-families.mjs',
      'scripts/config-documents.d.mts', 'scripts/scheduled-jobs.d.mts', 'scripts/workflow-history.mjs',
    ];
    for (const file of stale) writeFileSync(path.join(root, file), readFileSync(path.join(root, file), 'utf8') + '\n// stale\n');
    const missing = 'scripts/config-documents.mjs';
    rmSync(path.join(root, missing));
    const check = run('--check');
    assert.equal(check.status, 1);
    for (const file of [...stale, missing]) assert.ok(check.stderr.includes(file), `${file} is named: ${check.stderr}`);
    for (const file of stale) assert.ok(readFileSync(path.join(root, file), 'utf8').endsWith('\n// stale\n'), `${file} is left as it was`);
    assert.equal(existsSync(path.join(root, missing)), false, `${missing} is not written by a check`);
  });
});

// Bead ro-ghis.4, the deliberate mismatch: a PostHog field added to the one
// definition without regenerating is caught by the check the contract's
// typecheck runs, and once regenerated the module the flattener imports
// carries it.
test('a PostHog field added to its one definition is stale until regenerated, then reaches the flattener', async () => {
  await withGenerationRoot(async (root, run) => {
    const source = path.join(root, 'packages/contract/src/posthog-families.mts');
    const before = readFileSync(source, 'utf8');
    const edited = before.replace("fields: ['date', 'pageviews', 'people', 'sessions']", "fields: ['date', 'pageviews', 'people', 'sessions', 'bounces']");
    assert.notEqual(edited, before, 'the web-daily field list is where the test expects it');
    writeFileSync(source, edited);

    const check = run('--check');
    assert.equal(check.status, 1);
    assert.ok(check.stderr.includes('packages/contract/src/posthog-families.mjs'), check.stderr);
    assert.ok(check.stderr.includes('packages/contract/src/posthog-families.d.mts'), check.stderr);

    const incomplete = run();
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stdout, /posthog\.ts.*error TS[\s\S]*bounces/u,
      'the row schema must match the changed family before generation can succeed');
    edit(root, 'packages/contract/src/posthog.ts',
      "  sessions: count,\n} satisfies PosthogRowShape<'web-daily'>);",
      "  sessions: count,\n  bounces: count,\n} satisfies PosthogRowShape<'web-daily'>);");
    const regeneratedOutput = run();
    assert.equal(regeneratedOutput.status, 0, regeneratedOutput.stdout + regeneratedOutput.stderr);
    assert.equal(run('--check').status, 0);
    const regenerated = await import(pathToFileURL(path.join(root, 'packages/contract/src/posthog-families.mjs')).href);
    assert.deepEqual(regenerated.POSTHOG_FAMILY_ROWS['web-daily'].fields, ['date', 'pageviews', 'people', 'sessions', 'bounces']);
  });
});
