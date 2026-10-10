import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// DESK CONSOLIDATION, WITH SUPPORTED WALL CONSUMERS (`ro-78qo.1`, `ro-ujb9.41`).
//
// doc 14 makes `HeroChart` the desk's one time-series surface and `Kpi` its one
// headline figure. The pre-D28 Wall's own `Spark` and `DailyBars` left the
// Tower with its cards (bead `ro-trai.20`); `Stat` and the `AttentionBand`
// desk table followed once only the gallery and their own tests drew them
// (bead `ro-trai.25`). The list below is empty until a component is
// deprecated again; the retired ones are guarded against coming back.
//
// The desk boundary is an exact caller check. Every file importing one today is
// listed below; a file that is not listed and imports one fails this test, and a
// listed file that has stopped importing one ALSO fails, so the list cannot rot
// into a permission slip. New supported Wall consumers and their regression
// tests need an explicit entry and reason; they do not need a fictional removal
// bead. Desk rebuilds remove their entries; unused components can be deleted.
//
// The sister of `ui-lexicon.test.mjs`, `ui-noun.test.mjs` and
// `component-registry.test.mjs`: the same shape, the same exact-match list with
// a reason, and the same rule that an entry which stops being true is deleted
// rather than kept. It reads SOURCE TEXT for the same reason they do — these are
// `.tsx` files with path aliases only Vite resolves.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

const SCAN_DIRS = ['apps/tower/src', 'apps/tower/test'];

/**
 * Components unavailable to new desk consumers, the desk replacement, and
 * explicitly supported Wall, gallery and regression-test imports.
 */
const DEPRECATED = {};

/** Components deleted once no screen drew them, and the import each was
 * reached by. A file at the path or an import of the specifier is a revival. */
const RETIRED = [
  { file: 'apps/tower/src/components/Stat.tsx', specifier: '"@/components/Stat"', instead: '`Kpi` inside a `KpiStrip`' },
  {
    file: 'apps/tower/src/components/bands/AttentionBand.tsx',
    specifier: '"@/components/bands/AttentionBand"',
    instead: "/alerts' rows, `AlertRow`'s `Recurrence` and `AttentionAllClear`, and `lib/attention`",
  },
];

/** What each retired component points at. A replacement that does not exist
 * makes this whole file advice rather than a ratchet. */
const REPLACEMENTS = [
  'apps/tower/src/components/surface/Sparkline.tsx',
  'apps/tower/src/components/surface/HeroChart.tsx',
  'apps/tower/src/components/surface/KpiStrip.tsx',
];

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) found.push(rel);
  }
  return found;
}

const read = (name) => readFileSync(path.join(REPO_ROOT, name), 'utf8');

/**
 * Files importing `@/components/<name>`. The quotes are part of the match, so
 * `Stat` cannot resolve on `StateChip` and `Spark` cannot resolve on a
 * `SparkLegend` somebody adds later. A component importing ITSELF (the file the
 * component lives in) is not a call site.
 */
function importersOf(name, files) {
  const specifier = `"@/components/${name}"`;
  return files.filter(
    (file) => file !== DEPRECATED[name].file && read(file).includes(specifier),
  );
}

const FILES = SCAN_DIRS.flatMap(sourceFiles);

test('retired provider and signed-bar implementations do not return', () => {
  const revived = FILES.filter((file) =>
    /\b(?:WebSearchChart|SignedBars|SignedBarPoint)\b/.test(read(file)),
  );
  assert.deepEqual(
    revived,
    [],
    'Provider comparisons and signed monthly charts use HeroChart; do not restore unused implementations.',
  );
});

// Bead ro-trai.25: deleted because nothing drew them; a revival is a second
// desk design for a fact the registry already draws.
test('retired desk components do not return', () => {
  const revived = [];
  for (const entry of RETIRED) {
    if (FILES.includes(entry.file)) revived.push(`${entry.file} exists again — use ${entry.instead}`);
    for (const file of FILES) {
      if (read(file).includes(entry.specifier)) revived.push(`${file} imports ${entry.specifier} — use ${entry.instead}`);
    }
  }
  assert.deepEqual(revived, [], `retired components came back:\n  ${revived.join('\n  ')}`);
});

// A guard that scans nothing passes forever.
test('the deprecation ratchet has files to scan', () => {
  assert.ok(
    FILES.length > 50,
    `only ${FILES.length} source file(s) found — the directory walk did not resolve`,
  );
  assert.ok(
    FILES.includes('apps/tower/src/routes/KitchenSinkRoute.tsx'),
    'the gallery must be in the scan — it imports every supported Wall component',
  );
});

test('every desk-restricted component exists and documents its boundary', () => {
  for (const [name, entry] of Object.entries(DEPRECATED)) {
    assert.ok(
      FILES.includes(entry.file),
      `${name} is gone from ${entry.file} — delete its entry here and its registry entry`,
    );
    assert.match(
      read(entry.file),
      /@deprecated/,
      `${entry.file} must carry an @deprecated tag on its export: the guard is the mechanism, ` +
        'but a reader opening the file is who the tag is for',
    );
  }
});

test('the components that replace them exist', () => {
  const missing = REPLACEMENTS.filter((file) => !FILES.includes(file));
  assert.deepEqual(
    missing,
    [],
    `these replacements are missing:\n  ${missing.join('\n  ')}\n` +
      'A deprecation pointing at nothing is a complaint, not a plan.',
  );
});

test('no unregistered file imports a desk-restricted component', () => {
  const offenders = [];

  for (const [name, entry] of Object.entries(DEPRECATED)) {
    for (const file of importersOf(name, FILES)) {
      if (entry.callers.includes(file)) continue;
      offenders.push(`${file}  imports  ${name}  —  use ${entry.instead}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these files import a desk-restricted component:\n  ${offenders.join('\n  ')}\n` +
      'New desk consumers use apps/tower/src/components/surface/ (doc 14). ' +
      'A supported Wall consumer or its regression test needs an explicit callers entry ' +
      'with its purpose. Wall specialization is not a reason to allow duplicate desk designs.',
  );
});

// The other half of the ratchet: a list nobody prunes stops being a decision.
test('every recorded call site still is one', () => {
  const stale = [];

  for (const [name, entry] of Object.entries(DEPRECATED)) {
    const importers = new Set(importersOf(name, FILES));
    for (const caller of entry.callers) {
      if (!FILES.includes(caller)) stale.push(`${caller} no longer exists (listed under ${name})`);
      else if (!importers.has(caller)) {
        stale.push(`${caller} no longer imports ${name} — delete the line`);
      }
    }
  }

  assert.deepEqual(
    stale,
    [],
    `these recorded call sites are no longer true — delete them:\n  ${stale.join('\n  ')}\n` +
      'Unused entries become permission slips. When a component\'s list empties, delete the ' +
      'component, its registry entry and its entry here.',
  );
});

// The guard has to be able to FAIL, or a broken matcher reads as a clean tree.
test('the matcher sees a new import and is not fooled by a longer name', () => {
  const sample = 'import { Stat } from "@/components/Stat";';
  assert.ok(sample.includes('"@/components/Stat"'), 'an exact specifier must match');
  const decoy = 'import { StateChip } from "@/components/StateChip";';
  assert.equal(
    decoy.includes('"@/components/Stat"'),
    false,
    'a longer component name must not resolve as the shorter one',
  );
  const relative = 'import { Spark } from "./Spark";';
  assert.equal(
    relative.includes('"@/components/Spark"'),
    false,
    'the alias is the one import form this repo uses; a relative one would be a separate defect',
  );
});
