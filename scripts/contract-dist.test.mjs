import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A build artifact must stand on its own. `packages/contract` is the only
// workspace whose `build` emits JavaScript: the Tower is bundled by Vite and
// the ingest by wrangler, and both resolve the TypeScript source the exports
// map points at, so `dist` is the one output nobody reads.
//
// The trap: `src/os-time-zone.ts` imports `config/constants.json`, tsc copies
// an import specifier into the emitted JS verbatim, and under `rootDir: "src"`
// the JSON sits outside the program's root, so the emit carries a reference up
// and out of `dist` to a file that only exists because a checkout happens to be
// arranged that way. Nothing in a build would find out.
//
// So this compiles the package the way `pnpm -r build` does, into a throwaway
// directory, and holds every emitted module to one rule: each relative
// specifier it names resolves to a file that the same build produced, whatever
// the reason it reached outside (a JSON import, a stray `../../shared` helper,
// a path alias only a bundler could honour).
//
// AND IT LOADS WHAT IT BUILT. Resolving a specifier is not the same question
// as running the module: a bare `import … from './constants.json'` resolves to
// a file that is really there and still throws ERR_IMPORT_ATTRIBUTE_MISSING
// under plain Node, which wants `with { type: 'json' }`. Every consumer that
// reads the SOURCE (Vite, wrangler's esbuild, vitest) inlines JSON and never
// asks for the attribute, so importing each emitted module is the only check
// that can see it.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const CONTRACT_DIR = path.join(REPO_ROOT, 'packages', 'contract');

/**
 * Emitted ESM and the declarations beside it both spell their neighbours as
 * relative specifiers. Bare specifiers (`zod`) are a dependency question and not
 * this test's business; only the relative ones claim something about the shape
 * of the output directory.
 */
const RELATIVE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]*)['"]/g;

/** Every file tsc wrote, deepest paths included. */
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

/**
 * Resolve the way a runtime would: the specifier as written first, because
 * emitted ESM and JSON imports both carry their extension, then the two
 * extensions a declaration file may leave implicit.
 */
function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.d.ts`, path.join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The build every check below reads: the package compiled the way
 * `pnpm -r build` does, once, into a throwaway directory INSIDE the workspace
 * rather than in `os.tmpdir()`.
 *
 * Node resolves a bare specifier by walking `node_modules` up from the
 * importing file, and the emitted modules import `zod`. From a system temp
 * directory that walk finds nothing, so every load would fail for a reason that
 * says nothing about the output. Under `packages/contract` it finds the
 * workspace's own dependencies — exactly the resolution a consumer pointed at
 * `dist` would get. The directory is removed after the file's checks, and its
 * name is `dist`-prefixed so a killed run leaves something `.gitignore` already
 * covers.
 */
let out;
let built;

before(() => {
  out = mkdtempSync(path.join(CONTRACT_DIR, 'dist-loadcheck-'));
  built = spawnSync(path.join(CONTRACT_DIR, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json', '--outDir', out], {
    cwd: CONTRACT_DIR,
    encoding: 'utf8',
  });
});

after(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

test('the contract package builds', () => {
  const tsc = path.join(CONTRACT_DIR, 'node_modules', '.bin', 'tsc');
  assert.ok(
    existsSync(tsc),
    `expected the contract workspace's typescript at ${tsc} — run pnpm install`,
  );

  assert.equal(
    built.status,
    0,
    `tsc -p packages/contract/tsconfig.build.json failed:\n${built.error ?? ''}${built.stdout}${built.stderr}`,
  );
  assert.ok(walk(out).some((file) => file.endsWith('.js')), 'the build emitted no JavaScript');
});

test('every relative specifier the build emits resolves inside the output', () => {
  assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);

  const dangling = [];
  const escaping = [];
  for (const file of walk(out)) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts') && !file.endsWith('.mjs') && !file.endsWith('.d.mts')) continue;
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(RELATIVE_SPECIFIER)) {
      const where = `${path.relative(out, file)} → ${specifier}`;
      const resolved = resolveSpecifier(file, specifier);
      if (!resolved) {
        dangling.push(where);
        continue;
      }
      const inside = path.relative(out, resolved);
      if (inside.startsWith('..') || path.isAbsolute(inside)) escaping.push(where);
    }
  }

  assert.deepEqual(
    dangling,
    [],
    'packages/contract emitted an import that resolves to no file. tsc copies a ' +
      'specifier verbatim, so a source import only works in the output when the ' +
      'file it names is emitted too — check rootDir in tsconfig.build.json.',
  );
  assert.deepEqual(
    escaping,
    [],
    'packages/contract emitted an import that reaches outside its own build ' +
      'output. It resolves in a checkout and nowhere else: publish the package, ' +
      'or point the exports map at dist, and it is a module-not-found at runtime. ' +
      'Emit the file it needs (see rootDir in tsconfig.build.json) rather than ' +
      'borrowing one from the repo around it.',
  );
});

test('every module the build emits loads under plain Node', async () => {
  // Resolving a specifier and running the module are different
  // questions, and only the second one catches an import Node refuses: the
  // emitted JSON import pointed at a file that was really there and still threw
  // ERR_IMPORT_ATTRIBUTE_MISSING, because tsc copies the specifier through
  // verbatim and Node wants `with { type: 'json' }`. Nothing that reads the
  // SOURCE needed the attribute — Vite, esbuild and vitest all inline JSON — so
  // this is the only gate that can see it.
  assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);

  const modules = walk(out)
    .filter((file) => file.endsWith('.js') || file.endsWith('.mjs'))
    .sort();
  assert.ok(modules.length > 0, 'the build emitted no JavaScript to load');

  const failures = [];
  for (const file of modules) {
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      failures.push(`${path.relative(out, file)} → ${err.code ?? ''} ${err.message}`.trim());
    }
  }

  assert.deepEqual(
    failures,
    [],
    'packages/contract emitted a module Node cannot load. The output only ever runs ' +
      'under a plain ESM loader, so anything a bundler would have papered over — a JSON ' +
      'import with no `with { type: \'json\' }`, an extensionless relative specifier — is ' +
      'a runtime failure the moment the exports map points at dist.',
  );
});

test('the operator clock the build emits is the one config holds', () => {
  // The reason the reference has to resolve, stated as a fact rather than a
  // shape: `OS_TIME_ZONE` is config/constants.json's `os_time_zone`,
  // and a build that quietly stopped carrying the JSON would still typecheck.
  assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);

  const emitted = walk(out).filter((file) => file.endsWith('constants.json'));
  assert.equal(
    emitted.length,
    1,
    `expected the build to emit config/constants.json once, got ${emitted.length}`,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(emitted[0], 'utf8')).os_time_zone,
    JSON.parse(readFileSync(path.join(REPO_ROOT, 'config', 'constants.json'), 'utf8'))
      .os_time_zone,
  );
});
