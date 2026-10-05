import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A HAND-WRITTEN `.d.mts` IS A SECOND IMPLEMENTATION OF THE SAME CONTRACT
// (bead `ro-7uy0`).
//
// `scripts/` is plain ESM with no build step, on purpose: one implementation
// bundles into a Worker, runs in a terminal, and is imported by the Tower —
// which is exactly why `config-registers.mjs` and `wall-layout.mjs` live here
// rather than in `apps/tower/shared/`. The price is that TypeScript callers
// reach them through a declaration file somebody typed by hand, and every one of
// those files says "keep in lockstep with the .mjs" in its own header with
// nothing behind the sentence.
//
// The failure that actually happens: an export is added to the `.mjs` and
// forgotten in the `.d.mts`. Nothing goes red — the name simply is not there
// when a Tower import site reaches for it, and the four gates had no opinion.
// The mirror image is quieter still: a name declared that the runtime no longer
// exports typechecks green and is `undefined` at the point it matters, which for
// `wall-layout.d.mts` would be a Wall the types promise and the renderer cannot
// draw.
//
// SO THIS TEST FINDS EVERY PAIR ITSELF. Any `scripts/*.d.mts` with a sibling
// `.mjs` is checked the day it lands; nobody has to remember to add it here.
//
// IT STOPS AT NAMES, deliberately. Whether a declared TYPE still describes what
// the runtime returns is a question only `tsc` over the pair can answer, and it
// is a bigger one — see `ro-7uy0`'s own note. A name-set comparison is cheap,
// needs no TypeScript loader, and catches the drift that occurs.
//
// `tsc` NOW ANSWERS IT (bead `ro-ujb9.61`). A shared module is authored as
// `scripts/<name>.mts`, and `pnpm config:generate` writes the `.mjs` and the
// `.d.mts` from it, so a TypeScript caller compiles against the implementation
// itself and `pnpm config:check` fails a stale output. Those pairs leave this
// name check: their declarations cannot disagree with their runtime. What stays
// here is (1) the ratchet below — a HAND-WRITTEN pair is allowed only where
// `HANDWRITTEN_PAIRS` names it with its reason — and (2) the name check for
// exactly those pairs.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Where the Tower's typed mirrors of these modules live — the third file in
 * the chain, checked at the bottom of this file. */
const SHARED_DIR = path.resolve(SCRIPTS_DIR, '..', 'apps', 'tower', 'shared');

/**
 * The `.mjs` + `.d.mts` pairs still typed by hand, each with why it is not an
 * authored `.mts` yet. Every other pair is generated. A new hand-written pair
 * fails the ratchet test below; one that gains its `.mts` is pruned by it.
 */
const HANDWRITTEN_PAIRS = {
  'config-store-client.d.mts':
    'it reads the operator bearer and attaches it to every request to the ingest door. ' +
    'Moving that code into a generated file is a change to a protected auth path, which ' +
    'needs explicit operator scope (bead ro-ujb9.98); until then its three typed callers ' +
    'read these declarations.',
  'dev-secrets.d.mts':
    'it reads and moves credential values between the local secrets file and the store. ' +
    'Moving that code into a generated file is a change to a protected credential path, ' +
    'which needs explicit operator scope (bead ro-ujb9.98).',
};

/**
 * Declaration files that deliberately declare LESS than the runtime exports,
 * with the reason each states in its own header. The pruning test below deletes
 * an entry that has caught up — an allowlist nobody prunes is a habit, not a
 * decision.
 *
 * The bar is high, and "I did not feel like typing the rest" is not it: a
 * partial file trades away half of this guard, so it earns a place here only
 * when declaring the remainder would mean INVENTING types nothing checks —
 * which is the drift the guard exists to catch, invited back in through the
 * front door.
 */
const DECLARES_ONLY_WHAT_IS_IMPORTED = {
  'dev-secrets.d.mts':
    "its own header draws the line: the Tower's env-import lane imports three names, " +
    'scripts/database-address.mts one, and the CLI reaches the module untyped, as every ' +
    'script does. The other thirteen exports ' +
    'have no typed caller, so declaring them would mean writing types nothing reads and ' +
    'nothing corrects.',
};

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
    // Authored TypeScript is checked by config:check, including type shapes.
    .filter((pair) => !existsSync(path.join(SCRIPTS_DIR, pair.runtime.replace(/\.mjs$/, '.mts'))));
}

/** The names the module really exports. Importing it is the only honest source:
 * a re-export block resolves, a conditional export does not exist, and the CLI
 * entry points here all guard on `process.argv[1]` so a load runs nothing. */
async function exportedNames(runtime) {
  const namespace = await import(pathToFileURL(path.join(SCRIPTS_DIR, runtime)).href);
  return new Set(Object.keys(namespace));
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

// A guard that scans nothing passes forever.
test('the walk finds the generated pairs and the hand-written ones', () => {
  const generated = readdirSync(SCRIPTS_DIR).filter((name) => name.endsWith('.mts') && !name.endsWith('.d.mts'));
  assert.ok(
    generated.includes('wall-layout.mts') && generated.includes('config-registers.mts'),
    'the walk must find wall-layout.mts and config-registers.mts — the widget library and the ' +
      'register map the television and the write lane read, and the pairs this guard was written for',
  );
  assert.ok(PAIRS.length > 0, 'no hand-written pair found — the walk did not resolve, or the ' +
    'last one gained its .mts and this name check can be retired with HANDWRITTEN_PAIRS');
});

// The ratchet (bead ro-ujb9.61): a new shared module is authored as `.mts`
// and generated, never typed twice by hand.
test('a hand-written declaration pair exists only where HANDWRITTEN_PAIRS says why', () => {
  const found = PAIRS.map((pair) => pair.declarations);
  assert.deepEqual(
    found,
    Object.keys(HANDWRITTEN_PAIRS).sort(),
    `hand-written pairs found: ${found.join(', ')}\n` +
      'A scripts/*.mjs that TypeScript imports is authored as scripts/<name>.mts, listed in ' +
      'tsconfig.config-contract.json (portable) or tsconfig.config-contract.node.json (Node-only), ' +
      'and generated with pnpm config:generate — so its callers compile against the ' +
      'implementation rather than a copy. If a pair here gained its .mts, delete its ' +
      'HANDWRITTEN_PAIRS entry; if a new one cannot be generated yet, add it there with the reason.',
  );
});

test('every export the runtime carries is declared beside it', async () => {
  const undeclared = [];

  for (const { runtime, declarations } of PAIRS) {
    if (Object.hasOwn(DECLARES_ONLY_WHAT_IS_IMPORTED, declarations)) continue;
    const exported = await exportedNames(runtime);
    const declared = declarationsOf(declarations);
    for (const name of [...exported].sort()) {
      if (!declared.values.has(name)) undeclared.push(`${declarations}  →  no ${name}`);
    }
  }

  assert.deepEqual(
    undeclared,
    [],
    `these runtime exports have no declaration:\n  ${undeclared.join('\n  ')}\n` +
      'The .mjs is the implementation and the .d.mts is the only thing a TypeScript caller ' +
      'can see, so a name missing here is a name the Tower cannot import — invisible until ' +
      'somebody reaches for it. Declare it. If the file genuinely declares only what a typed ' +
      'caller imports, say so in DECLARES_ONLY_WHAT_IS_IMPORTED in this test, with the reason.',
  );
});

test('every name the declarations carry the runtime exports', async () => {
  const phantom = [];

  for (const { runtime, declarations } of PAIRS) {
    const exported = await exportedNames(runtime);
    const declared = declarationsOf(declarations);
    for (const name of [...declared.values].sort()) {
      if (!exported.has(name)) phantom.push(`${declarations}  →  ${name} is not exported`);
    }
  }

  assert.deepEqual(
    phantom,
    [],
    `these declarations name something the runtime does not export:\n  ${phantom.join('\n  ')}\n` +
      'This is the quiet half: it typechecks green and is `undefined` where it is used. A ' +
      'renamed or deleted export moves the declaration with it. (Type-only names — interface, ' +
      'type — are not checked here; they have no runtime to disagree with.)',
  );
});

test('a partial-declarations exemption that has caught up is deleted', async () => {
  const stale = [];

  for (const declarations of Object.keys(DECLARES_ONLY_WHAT_IS_IMPORTED)) {
    const pair = PAIRS.find((candidate) => candidate.declarations === declarations);
    if (!pair) {
      stale.push(`${declarations} — no such pair in scripts/ any more`);
      continue;
    }
    const exported = await exportedNames(pair.runtime);
    const declared = declarationsOf(declarations);
    if ([...exported].every((name) => declared.values.has(name))) {
      stale.push(`${declarations} — it now declares every export, so it is no longer partial`);
    }
  }

  assert.deepEqual(
    stale,
    [],
    `these exemptions have stopped being true:\n  ${stale.join('\n  ')}\n` +
      'Delete the entry so the full check applies. An exemption kept past its reason is how ' +
      'an allowlist becomes the rule.',
  );
});

// ---------------------------------------------------------------------------
// THE THIRD FILE IN THE CHAIN (bead `ro-yibc`).
//
// `.mjs` → `.d.mts` → `apps/tower/shared/<name>.ts` → every `@shared/…` import
// site. The Tower reaches these modules through a path alias, so the shared file
// is a hand-written MIRROR of the two beside it — twenty-five value names and
// ten type names for `wall-layout` — and its own header stated the rule it
// cannot enforce: "add a name here when you add one there".
//
// The same drift, one file further along, and quieter: a name added to the
// runtime and its declarations but forgotten in the mirror is a name no Tower
// component can import, and every gate stays green until somebody reaches for
// it. The other direction — a mirror naming what `scripts/` no longer has — is
// the half `tsc` would refuse, and it costs one comparison to say so here.
//
// Textual by necessity: the alias means no plain Node loader resolves the
// shared file. It reuses the parser above rather than growing a second one, and
// it walks `apps/tower/shared/`, so a mirror written tomorrow is checked
// tomorrow.
//
// ONLY THE `export … from` FORM IS A MIRROR. A file that imports names and
// re-exports a chosen few beside its own code — `config-registers.ts` — passes
// through what its callers use and never claimed to carry the whole list;
// holding it to one would be inventing a rule its author did not write.
// ---------------------------------------------------------------------------

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

test("every name scripts/ offers, the Tower's mirror carries", async () => {
  const missing = [];

  for (const mirror of MIRRORS) {
    const declared = declarationsOf(mirror.declarations);
    // A `.d.mts` that declares less than its runtime ON PURPOSE caps what any
    // mirror of it could re-export, so there it is the declarations that hold.
    const offered = Object.hasOwn(DECLARES_ONLY_WHAT_IS_IMPORTED, mirror.declarations)
      ? declared.values
      : await exportedNames(mirror.runtime);
    for (const name of [...offered].sort()) {
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

test("every name the Tower's mirror carries, scripts/ still has", async () => {
  const phantom = [];

  for (const mirror of MIRRORS) {
    const exported = await exportedNames(mirror.runtime);
    const declared = declarationsOf(mirror.declarations);
    for (const name of [...mirror.values].sort()) {
      if (!exported.has(name)) {
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
