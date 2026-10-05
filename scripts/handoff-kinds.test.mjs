import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDOFF_KINDS } from './task-snapshot-summary.mjs';
import { BEADS_HANDOFF_KINDS } from '../packages/contract/src/task-snapshot.mjs';

// THE DRIFT GUARD BEHIND `noticeos_kind` (bead ro-4l0q).
//
// A Tower handoff carries `noticeos_kind` naming the surface that raised the
// work (`config/beads.README.md` §Handoff metadata). The set of legal values is
// represented on six surfaces that ship on different clocks — the
// emitter's type, the poller's array, the ingest validator's shared array, the Tower's
// reader chain, the shared display type, and the operator-facing table in the
// README. The validator imports its array; the other boundaries must agree.
//
// Since `ro-05hb` drift is SURVIVABLE — the ingest validator drops an
// unrecognized kind's own row and logs `beads_handoff_kind_unknown`, instead of
// 422'ing the whole project's snapshot and blanking the portfolio's board. It
// is not VISIBLE, though: a fifth kind added to the emitter and forgotten in
// the poller is a marker that simply never appears on the row that raised it,
// with nothing red anywhere. That is what this file exists to turn into a
// failing gate.
//
// WHY A REGEX OVER THE TS SOURCES INSTEAD OF AN IMPORT: `pnpm test:scripts` is
// bare `node --test` with no TS loader and no build artifact to import
// (wrangler bundles the Workers; nothing emits JS for them). Importing the
// TypeScript would mean adding a transpile step to the one suite whose whole
// value is running before anything is built. The poller is the exception and is
// imported from its pure `.mjs` module, without initializing the live runner.
//
// This file asserts AGREEMENT, not a pinned list. Adding a sixth kind is a
// legitimate change; making it in one file and not the others is not.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function source(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * Every single- or double-quoted literal in a fragment, in order.
 *
 * The fragments below are each one declaration's right-hand side, so there is
 * nothing else in them to catch by accident.
 */
function quoted(fragment) {
  return [...fragment.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

/**
 * The one capture group of `pattern`, or a failure naming the file.
 *
 * A regex that has gone stale — the constant renamed, the declaration
 * reformatted — must fail LOUDLY here. Returning an empty list instead would
 * let two silently-unread sources "agree" with each other, which is the exact
 * failure this file is supposed to catch.
 */
function capture(relative, pattern, what) {
  const match = source(relative).match(pattern);
  assert.ok(
    match,
    `${relative}: could not find ${what}. The guard in scripts/handoff-kinds.test.mjs reads it by regex — if the declaration moved or was reformatted, update the pattern here in the same change.`,
  );
  return match[1];
}

// ─────────────────────────────────────────────────────────────────────────────
// The six statements of the list

/** The emitter: `export type TaskHandoffKind = "query" | "finding" | …;` */
function emitterKinds() {
  return quoted(
    capture(
      'apps/tower/src/lib/task-handoff.ts',
      /export type TaskHandoffKind\s*=([^;]+);/,
      'the `TaskHandoffKind` union',
    ),
  );
}

function pollerKinds() {
  assert.match(source('scripts/runner/task-snapshot.mjs'), /export \* from '\.\.\/task-snapshot-summary\.mjs';/);
  assert.match(source('scripts/os-up.mjs'), /export\s*\{[^}]*\bHANDOFF_KINDS\b[^}]*\}\s*from '\.\/runner\/task-snapshot\.mjs';/);
  return HANDOFF_KINDS;
}

/** The ingest validator imports the released shared contract. */
function validatorKinds() {
  assert.match(
    source('workers/ingest/src/beads-snapshots.ts'),
    /import\s*\{\s*BEADS_HANDOFF_KINDS\s*\}\s*from\s*['"]@noticeos\/contract\/task-snapshot['"];/,
    'The ingest validator must use the shared handoff-kind contract.',
  );
  return [...BEADS_HANDOFF_KINDS];
}

/**
 * The Tower's reader: an inline `kind !== "x" && kind !== "y" && …` refusal in
 * `readHandoff`, not a named constant — so it is read as the whole chain.
 */
function towerReaderKinds() {
  const chain = capture(
    'apps/tower/worker/beads-snapshot.ts',
    /if \(((?:\s*kind !== "[^"]+"\s*(?:&&)?)+)\)/,
    'the `kind !== …` chain in `readHandoff`',
  );
  return quoted(chain);
}

/**
 * The shared display type: `export type HandoffKind = DecisionKind | "page" | …`.
 *
 * It names `DecisionKind` rather than restating `query` and `finding`, and that
 * indirection is the point of the type — so it is resolved from the same file
 * rather than treated as a two-item list that would fail against everything.
 */
function sharedTypeKinds() {
  const file = 'apps/tower/shared/asset-detail.ts';
  const decisionKinds = quoted(
    capture(file, /export type DecisionKind\s*=([^;]+);/, 'the `DecisionKind` union'),
  );
  const handoffUnion = capture(file, /export type HandoffKind\s*=([^;]+);/, 'the `HandoffKind` union');
  assert.ok(
    handoffUnion.includes('DecisionKind'),
    `${file}: \`HandoffKind\` no longer builds on \`DecisionKind\`. Update the guard in scripts/handoff-kinds.test.mjs to read whatever it says now.`,
  );
  return [...decisionKinds, ...quoted(handoffUnion)];
}

/**
 * The operator-facing table in `config/beads.README.md` §Handoff metadata —
 * one row per kind, the kind backticked in the first cell.
 *
 * The README is a source here rather than documentation ABOUT the sources: it
 * is where a person filing a handoff bead by hand looks up what to write, so a
 * kind the code accepts and the table omits is a real gap.
 */
function readmeKinds() {
  const lines = source('config/beads.README.md').split('\n');
  const header = lines.findIndex((line) => /^\|\s*`noticeos_kind`\s*\|/.test(line));
  assert.notEqual(
    header,
    -1,
    'config/beads.README.md: could not find the `noticeos_kind` table header. The guard in scripts/handoff-kinds.test.mjs reads the table under §Handoff metadata.',
  );
  const kinds = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const cell = line.split('|')[1] ?? '';
    const kind = cell.match(/`([^`]+)`/);
    if (kind) kinds.push(kind[1]);
  }
  return kinds;
}

/** Read in the order a change travels: emitted, polled, validated, rendered. */
const SOURCES = [
  { where: 'apps/tower/src/lib/task-handoff.ts', what: 'TaskHandoffKind', read: emitterKinds },
  { where: 'scripts/os-up.mjs', what: 'HANDOFF_KINDS', read: pollerKinds },
  { where: 'workers/ingest/src/beads-snapshots.ts', what: 'BEADS_HANDOFF_KINDS', read: validatorKinds },
  { where: 'apps/tower/worker/beads-snapshot.ts', what: 'readHandoff', read: towerReaderKinds },
  { where: 'apps/tower/shared/asset-detail.ts', what: 'HandoffKind', read: sharedTypeKinds },
  { where: 'config/beads.README.md', what: '§Handoff metadata table', read: readmeKinds },
];

const label = (entry) => `${entry.where} (${entry.what})`;

// ─────────────────────────────────────────────────────────────────────────────

test('every statement of the handoff-kind list reads back non-empty', () => {
  for (const entry of SOURCES) {
    const kinds = entry.read();
    assert.ok(
      Array.isArray(kinds) && kinds.length > 0,
      `${label(entry)} read back empty. An unread source cannot disagree with anything, so the drift check below would pass on nothing.`,
    );
    assert.equal(
      new Set(kinds).size,
      kinds.length,
      `${label(entry)} lists a kind twice: ${kinds.join(', ')}`,
    );
  }
});

test('the handoff-kind list is the same set everywhere it is stated', () => {
  const read = SOURCES.map((entry) => ({
    label: label(entry),
    kinds: [...new Set(entry.read())].sort(),
  }));

  // The consensus is the largest group of sources that agree, so the message
  // can name the ODD ONE OUT rather than printing six lists and leaving the
  // reader to diff them. Ties are impossible with an odd split and harmless
  // otherwise: whichever group wins, every source outside it is still named.
  const groups = new Map();
  for (const entry of read) {
    const key = entry.kinds.join(',');
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  if (groups.size === 1) return;

  const [[agreedKey, agreed]] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const expected = agreedKey.split(',');
  const oddOnesOut = read
    .filter((entry) => entry.kinds.join(',') !== agreedKey)
    .map((entry) => {
      const missing = expected.filter((kind) => !entry.kinds.includes(kind));
      const extra = entry.kinds.filter((kind) => !expected.includes(kind));
      const said = [
        ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
        ...(extra.length ? [`has ${extra.join(', ')} that nothing else does`] : []),
      ].join('; ');
      return `  ${entry.label} — ${said}`;
    });

  assert.fail(
    [
      'The handoff-kind list has drifted, so a bead of the odd kind files with correct metadata and never gets reported back onto the row that raised it.',
      '',
      `${agreed.length} of ${read.length} sources agree on: ${expected.join(', ')}`,
      '',
      ...oddOnesOut,
      '',
      'Widen every statement of the list in the same change — config/beads.README.md §Handoff metadata lists where they all are.',
    ].join('\n'),
  );
});
