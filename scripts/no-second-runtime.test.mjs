import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// One workerd owns the local R2 persistence directory. Scripts and package
// commands must use the ingest API or prove no runtime owns it before starting
// another one. Postgres connections do not open that directory.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

/** Anything that names wrangler's local persistence. Both spellings, because
 * `--persist-to=<path>` and a bare `.wrangler/state` reach the same file. */
const SECOND_RUNTIME_MARKERS = [/--persist-to/, /\.wrangler[/\\]state/];

/**
 * The scripts allowed to open the store directly, and why.
 *
 * The bar is "nothing else CAN be holding the file at that moment", not "it is
 * only run occasionally" — which is exactly how the two signal lanes and
 * `config:apply` justified themselves right up until the corruption. Every entry
 * left here clears that bar and PROVES it first: the two that open the file both
 * probe the ingest door and refuse while anything answers. Adding an entry needs
 * a reason that survives "…while the operator's OS is running". The dev seed
 * left the list with bead ro-ujb9.76.57: it writes Postgres through the one
 * helper and opens no local store file at all.
 */
const ALLOWED = new Map([
  [
    'host-backup.mjs',
    'names the local store only for backups: sqlite files use the online-backup ' +
      'API and immutable R2 blobs are copied safely beside the one runtime; ' +
      'it never starts wrangler or applies migrations',
  ],
  [
    'ingest-dev.mjs',
    'starts the ingest STANDALONE for the isolation case workers/ingest/README.md ' +
      'documents, and refuses to start at all while the ingest door answers ' +
      '(doorIsHeld, beads ro-y1g / ro-nyz) — the sharpest of these three, since a ' +
      'second `wrangler dev` does not end with a command, it stands there',
  ],
]);

/** Bare package commands cannot prove the R2 interlock. They must route through
 * a guarded script; no manifest currently needs an exception. */
const ALLOWED_PACKAGE_SCRIPTS = new Map([]);

/** Every runnable script, and the local runner's own modules (scripts/runner/,
 * bead ro-ujb9.22): code moved out of os-up.mjs is still the runner's code. Tests
 * are excluded: they assert ABOUT this rule (this file names the flag it
 * forbids), and none of them spawn wrangler. */
function scriptFiles() {
  const runnable = (name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs');
  const runnerDir = path.join(SCRIPTS_DIR, 'runner');
  const runner = existsSync(runnerDir)
    ? readdirSync(runnerDir).filter(runnable).map((name) => `runner/${name}`)
    : [];
  return [...readdirSync(SCRIPTS_DIR).filter(runnable), ...runner].sort();
}

/**
 * The workspace globs, read out of pnpm-workspace.yaml rather than hardcoded.
 *
 * Hardcoding `apps/*` here would mean a new workspace directory is invisible to
 * this guard from the day it is added — the exact failure that let the migrate
 * lines survive, one directory over. Only the flat `- "apps/*"` list shape this
 * repo uses is understood, and an empty parse is a hard failure below: a guard
 * that silently scans nothing passes forever.
 */
function workspaceGlobs() {
  const yaml = readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [];
  let inPackages = false;
  for (const line of yaml.split('\n')) {
    if (/^packages:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const entry = line.match(/^\s+-\s*['"]?([^'"\s]+)['"]?\s*$/);
    if (entry) {
      globs.push(entry[1]);
      continue;
    }
    if (line.trim() !== '') break; // the next top-level key ends the list
  }
  return globs;
}

/** Every package.json a `pnpm <script>` can be run from — the root manifest plus
 * each workspace package — as repo-relative paths with `/` separators, which is
 * how the allowlist keys are spelled. */
function packageManifests() {
  const manifests = ['package.json'];
  for (const glob of workspaceGlobs()) {
    const parent = path.posix.dirname(glob);
    const dirs =
      path.posix.basename(glob) === '*'
        ? readdirSync(path.join(REPO_ROOT, parent), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${parent}/${entry.name}`)
        : [glob];
    for (const dir of dirs) {
      if (existsSync(path.join(REPO_ROOT, dir, 'package.json'))) {
        manifests.push(`${dir}/package.json`);
      }
    }
  }
  return manifests.sort();
}

/** One manifest's `scripts` block, or an empty one. */
function packageScripts(manifest) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, manifest), 'utf8')).scripts ?? {};
}

/**
 * The file with its whole-line comments removed.
 *
 * These headers EXPLAIN the hazard — they quote the flag in order to say never
 * to use it — and a guard that cannot tell an explanation from an invocation
 * would forbid documenting the rule it enforces. Only whole-line comments are
 * dropped: a trailing `// …--persist-to` still trips the check, which is the
 * safe direction for a guard to be wrong in.
 */
function code(source) {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*')
      );
    })
    .join('\n');
}

test("the sweep reads the local runner's own modules too", () => {
  assert.ok(scriptFiles().includes('os-up.mjs'));
  assert.ok(scriptFiles().includes('runner/config.mjs'), 'scripts/runner/ must be swept like scripts/');
});

test('no script opens a second runtime over the live store', () => {
  const offenders = [];
  for (const name of scriptFiles()) {
    if (ALLOWED.has(name)) continue;
    const source = code(readFileSync(path.join(SCRIPTS_DIR, name), 'utf8'));
    for (const marker of SECOND_RUNTIME_MARKERS) {
      if (marker.test(source)) offenders.push(`${name} (matched ${marker})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these scripts reach the local store directly:\n  ${offenders.join('\n  ')}\n` +
      'That starts a second workerd over the sqlite file the running Tower owns ' +
      '(bead ro-mad; the 2026-08-02 corruption). Read and write through the ' +
      'loopback ingest door instead — see scripts/ingest-door.mjs and ' +
      'scripts/signal-panels-refresh.mjs for the shape.',
  );
});

// The same sweep, over the other place a wrangler command can live. A pnpm
// script is run by hand beside a live os:up exactly like a script under
// scripts/ is — `pnpm migrate:local` was, every time — so the rule is the same
// and so is the allowlist.
test('no package.json script opens a second runtime over the live store', () => {
  const manifests = packageManifests();
  // A guard that scans nothing passes forever. These two assertions are what
  // makes a reformatted pnpm-workspace.yaml (or a moved workspace) a loud
  // failure instead of a silent hole.
  assert.ok(
    manifests.includes('package.json'),
    'the root package.json is where migrate:local lived — it must be scanned',
  );
  assert.ok(
    manifests.length >= 3,
    `only ${manifests.length} manifest(s) found (${manifests.join(', ')}) — the workspace ` +
      'globs in pnpm-workspace.yaml did not resolve, so this guard is scanning almost nothing',
  );

  const offenders = [];
  for (const manifest of manifests) {
    for (const [name, body] of Object.entries(packageScripts(manifest))) {
      const key = `${manifest}#${name}`;
      if (ALLOWED_PACKAGE_SCRIPTS.has(key)) continue;
      for (const marker of SECOND_RUNTIME_MARKERS) {
        if (marker.test(body)) offenders.push(`${key} (matched ${marker})`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these pnpm scripts reach the local store directly:\n  ${offenders.join('\n  ')}\n` +
      'A package.json script has nowhere to put a guard: it spawns a second workerd over ' +
      'the sqlite file the running Tower owns (bead ro-mad; the 2026-08-02 corruption) and ' +
      'nothing asks first. Point the entry at a small script that probes the ingest door ' +
      'and refuses — scripts/ingest-dev.mjs is the template (bead ro-7pa).',
  );
});

// The lanes that reach the store through the door, named explicitly so a revert
// reads as a failure about THEM, not as a nameless rule about a directory. Two
// were second WRITERS beside a live os:up before they were ported:
// `signal-insights-publish.mjs` (ro-2zk.3) and `config-apply.mjs` (ro-bko).
// `bing-ai-import.mjs` (ro-2dn) never was one — it is here so it never becomes
// one: it writes an archive, which is the shape of thing that most tempts a
// script to open D1 and R2 itself.
test('the ported lanes reach the store through the door', () => {
  for (const name of [
    'bing-ai-import.mjs',
    'config-apply.mjs',
    'signal-collect.mjs',
    'signal-dumps-download.mjs',
    'signal-insights-publish.mjs',
    'signal-panels-refresh.mjs',
  ]) {
    const source = readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
    assert.match(
      source,
      /from '\.\/ingest-door\.mjs'/,
      `${name} must reach the store through scripts/ingest-door.mjs`,
    );
  }
});

// The scripts that still open the file may only do so when nothing else can be
// holding it — and each ASKS before it acts, rather than assuming. The claim
// their allowlist entries make is checked here against the code that makes it;
// what each refusal then says is pinned in ingest-dev.test.mjs and
// os-up.test.mjs.
test('the scripts that still open the store ask the door first', () => {
  const interlocks = new Map([
    ['ingest-dev.mjs', /doorIsHeld/],
    ['os-up.mjs', /runnerArmDecision/],
  ]);
  for (const [name, marker] of interlocks) {
    const source = code(readFileSync(path.join(SCRIPTS_DIR, name), 'utf8'));
    assert.match(
      source,
      marker,
      `${name} opens the local store, so it must refuse while the ingest door answers`,
    );
  }
});

// An allowlist nobody prunes is a rule that has quietly stopped being one.
test('every allowlisted script still exists and still needs its entry', () => {
  const present = new Set(scriptFiles());
  for (const [name, reason] of ALLOWED) {
    assert.ok(present.has(name), `${name} is allowlisted but no longer exists — drop the entry`);
    assert.ok(reason.length > 20, `${name} needs a real reason, not a label`);
    const source = code(readFileSync(path.join(SCRIPTS_DIR, name), 'utf8'));
    assert.ok(
      SECOND_RUNTIME_MARKERS.some((marker) => marker.test(source)),
      `${name} no longer opens the store — remove it from the allowlist`,
    );
  }
});

// Same pruning, for the package.json side. This is what made the one exception
// removable rather than permanent: while `workers/ingest/package.json#dev` was a
// bare wrangler line the entry was demanded, and the moment ro-y1g / ro-nyz
// pointed it at scripts/ingest-dev.mjs this test failed until the entry was
// deleted. The loop is empty today and that is the whole result.
test('every allowlisted pnpm script still exists and still needs its entry', () => {
  for (const [key, reason] of ALLOWED_PACKAGE_SCRIPTS) {
    const [manifest, name] = key.split('#');
    assert.ok(
      existsSync(path.join(REPO_ROOT, manifest)),
      `${key} is allowlisted but ${manifest} no longer exists — drop the entry`,
    );
    const body = packageScripts(manifest)[name];
    assert.ok(body, `${key} is allowlisted but that script is gone — drop the entry`);
    assert.ok(reason.length > 20, `${key} needs a real reason, not a label`);
    assert.ok(
      SECOND_RUNTIME_MARKERS.some((marker) => marker.test(body)),
      `${key} no longer opens the store — remove it from the allowlist`,
    );
  }
});
