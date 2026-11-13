import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Shared scripts generate their runtime and declarations from the same source.
// The Tower's re-exports must resolve to names in those declarations.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Where the Tower's typed mirrors of these modules live — the third file in
 * the chain, checked at the bottom of this file. */
const SHARED_DIR = path.resolve(SCRIPTS_DIR, '..', 'apps', 'tower', 'shared');

/** Comments carry example code and prose full of the words this file matches on,
 * so they go first. Block comments and WHOLE-LINE `//` only — a trailing strip
 * would eat the `//` in a URL literal. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** `A`, `A as B`, `type A`, `type A as B`, `default as B` — the exported name is
 * whatever the list binds it to, and a `type` marker makes it a type. */
function listedNames(body) {
  const values = [];
  const types = [];
  for (const raw of body.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const typed = /^type\s+/.test(entry);
    const parts = entry.replace(/^type\s+/, '').split(/\s+as\s+/);
    const name = (parts[1] ?? parts[0]).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    (typed ? types : values).push(name);
  }
  return { values, types };
}

/**
 * What a `.d.mts` claims, split by what a RUNTIME could answer for.
 *
 * `interface` and `type` names exist only in the type system, so they are
 * collected and then held to nothing — the split is the point, not an oversight:
 * comparing them against a module namespace would fail every file here.
 */
function declaredNames(source) {
  const text = withoutComments(source);
  const values = new Set();
  const types = new Set();

  for (const [, typeMarker, body] of text.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    const listed = listedNames(body);
    for (const name of listed.types) types.add(name);
    for (const name of listed.values) (typeMarker ? types : values).add(name);
  }

  const VALUE_DECL =
    /export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
  for (const [, name] of text.matchAll(VALUE_DECL)) values.add(name);

  const TYPE_DECL = /export\s+(?:declare\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/g;
  for (const [, name] of text.matchAll(TYPE_DECL)) types.add(name);

  if (/export\s+default\s/.test(text)) values.add('default');

  return { values, types };
}

/** What one `.d.mts` claims, read from `scripts/`. A file that is not there
 * claims nothing, which is the honest answer for a runtime nobody typed. */
function declarationsOf(declarations) {
  const at = path.join(SCRIPTS_DIR, declarations);
  return declaredNames(existsSync(at) ? readFileSync(at, 'utf8') : '');
}

/**
 * The `export … from "…/x.mjs"` blocks in one TypeScript file, folded per
 * runtime — the same `listedNames` the declarations go through, so a mirror and
 * a declaration cannot be read by two different parsers.
 *
 * Only a block with a `from` pointing straight into `scripts/` counts.
 */
function mirroredNames(source, fromDir) {
  const found = new Map();
  const REEXPORT = /export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const [, typeMarker, body, specifier] of withoutComments(source).matchAll(REEXPORT)) {
    const target = path.resolve(fromDir, specifier);
    if (!target.endsWith('.mjs') || path.dirname(target) !== SCRIPTS_DIR) continue;
    const runtime = path.basename(target);
    const mirror = found.get(runtime) ?? { values: new Set(), types: new Set() };
    const listed = listedNames(body);
    for (const name of listed.types) mirror.types.add(name);
    for (const name of listed.values) (typeMarker ? mirror.types : mirror.values).add(name);
    found.set(runtime, mirror);
  }
  return found;
}

/** Every `scripts/*.d.mts` that has a runtime beside it, newest arrival
 * included, because the walk is the registry. */
function pairs() {
  return readdirSync(SCRIPTS_DIR)
    .filter((name) => name.endsWith('.d.mts'))
    .sort()
    .map((declarations) => ({
      declarations,
      runtime: `${declarations.slice(0, -'.d.mts'.length)}.mjs`,
    }))
    .filter((pair) => existsSync(path.join(SCRIPTS_DIR, pair.runtime)))
    // Authored TypeScript is checked by `pnpm generate -- --check`, including type shapes.
    .filter((pair) => !existsSync(path.join(SCRIPTS_DIR, pair.runtime.replace(/\.mjs$/, '.mts'))));
}

/** Every re-export of a `scripts/` runtime under `apps/tower/shared/`, found the
 * same way: by walking, so a mirror written tomorrow is checked tomorrow. */
function mirrors() {
  return readdirSync(SHARED_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .flatMap((file) => {
      const source = readFileSync(path.join(SHARED_DIR, file), 'utf8');
      return [...mirroredNames(source, SHARED_DIR)].map(([runtime, names]) => ({
        file,
        runtime,
        declarations: `${runtime.slice(0, -'.mjs'.length)}.d.mts`,
        ...names,
      }));
    });
}

const PAIRS = pairs();
const MIRRORS = mirrors();

test('shared script declarations are generated from TypeScript', () => {
  assert.deepEqual(PAIRS.map(({ declarations }) => declarations), []);
});

test('the mirror check has mirrors to check', () => {
  const wall = MIRRORS.find((mirror) => mirror.file === 'wall-layout.ts');
  assert.ok(
    wall !== undefined && wall.runtime === 'wall-layout.mjs',
    'apps/tower/shared/wall-layout.ts must be found re-exporting wall-layout.mjs — it is the ' +
      `mirror this check was written for, and ${MIRRORS.length} mirror(s) turned up instead`,
  );
  assert.ok(
    wall.values.size > 0 && wall.types.size > 0,
    'the wall-layout mirror must yield both value names and type names — an empty set means the ' +
      're-export parse matched half the file and the other half is checked by nothing',
  );
});

test("every name scripts/ offers, the Tower's mirror carries", () => {
  const missing = [];

  for (const mirror of MIRRORS) {
    const declared = declarationsOf(mirror.declarations);
    for (const name of [...declared.values].sort()) {
      if (!mirror.values.has(name)) missing.push(`${mirror.file}  →  no ${name}`);
    }
    for (const name of [...declared.types].sort()) {
      if (!mirror.types.has(name)) missing.push(`${mirror.file}  →  no type ${name}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `these names never reach the Tower:\n  ${missing.join('\n  ')}\n` +
      'The shared file is the only door an @shared import goes through, so a name left out of it ' +
      'exists in scripts/ and nowhere a component can reach. Add it to the re-export block beside ' +
      'the others.',
  );
});

test("every name the Tower's mirror carries, scripts/ still has", () => {
  const phantom = [];

  for (const mirror of MIRRORS) {
    const declared = declarationsOf(mirror.declarations);
    for (const name of [...mirror.values].sort()) {
      if (!declared.values.has(name)) {
        phantom.push(`${mirror.file}  →  ${mirror.runtime} exports no ${name}`);
      }
    }
    for (const name of [...mirror.types].sort()) {
      if (!declared.types.has(name)) {
        phantom.push(`${mirror.file}  →  ${mirror.declarations} declares no ${name}`);
      }
    }
  }

  assert.deepEqual(
    phantom,
    [],
    `the Tower re-exports names scripts/ does not have:\n  ${phantom.join('\n  ')}\n` +
      'A renamed or deleted export takes its mirror with it, or the alias resolves to nothing the ' +
      'day somebody imports it.',
  );
});
