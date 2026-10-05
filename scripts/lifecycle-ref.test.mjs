import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ASSET_STATUS,
  LIFECYCLE_ANNOTATION_KIND,
  LIFECYCLE_REF_PREFIX,
  lifecycleMoveRef,
} from './config-apply-core.mjs';

// THE DRIFT GUARD BEHIND `lifecycle:<from>><to>` (bead `ro-mz39`).
//
// A stage move is recorded on the annotation timeline, and Restore reads the
// most recent recorded move into `retired` to decide which stage to bring an
// archived asset back to (bead `ro-3085`, commit f2ce513). TWO writers move
// `assets.status`: the Tower's Settings tab, and `pnpm config:apply` in the
// operator's terminal. They must write the SAME string — a CLI that spelled the
// ref differently would archive an asset and leave Restore reading nothing,
// which is the exact silence ro-3085 was filed to end.
//
// The string is therefore stated twice: `apps/tower/shared/asset-detail.ts` for
// the Tower, `scripts/config-apply-core.mjs` for the terminal. It is not
// possible to state it once. `pnpm test:scripts` is bare `node --test` with no
// TS loader and no build artifact to import — wrangler bundles the Workers and
// nothing emits JS for the shared modules — so a Node script cannot import that
// TypeScript, and the whole value of this suite is that it runs before anything
// is built. `scripts/handoff-kinds.test.mjs` documents the same reasoning at
// length for the handoff-kind list.
//
// So this file READS the TypeScript and compares its answer to the .mjs's, move
// by move, over every stage in the lifecycle enum. It asserts AGREEMENT, not a
// pinned format: changing the ref shape is a legitimate change; changing it in
// one writer and not the other is not.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = 'apps/tower/shared/asset-detail.ts';
// The store that refuses a kind it does not know: the Postgres baseline, where
// annotations live (bead ro-ujb9.76.5.7).
const MIGRATION = 'db/postgres/migrations/0001_baseline.sql';

function source(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * The one capture group of `pattern`, or a failure naming the file.
 *
 * A regex that has gone stale — the constant renamed, the function reformatted —
 * must fail LOUDLY here rather than read back nothing, because a source nobody
 * read cannot disagree with anything.
 */
function capture(relative, pattern, what) {
  const match = source(relative).match(pattern);
  assert.ok(
    match,
    `${relative}: could not find ${what}. The guard in scripts/lifecycle-ref.test.mjs reads it by regex — if the declaration moved or was reformatted, update the pattern here in the same change.`,
  );
  return match[1];
}

/** The Tower's `LIFECYCLE_ANNOTATION_KIND` — `annotations.kind` for a move. */
function towerKind() {
  return capture(
    SHARED,
    /export const LIFECYCLE_ANNOTATION_KIND[^=]*=\s*["']([^"']+)["']/,
    'the `LIFECYCLE_ANNOTATION_KIND` constant',
  );
}

/** The Tower's `LIFECYCLE_REF_PREFIX`. */
function towerPrefix() {
  return capture(
    SHARED,
    /export const LIFECYCLE_REF_PREFIX\s*=\s*["']([^"']+)["']/,
    'the `LIFECYCLE_REF_PREFIX` constant',
  );
}

/**
 * What the Tower's `lifecycleMoveRef` returns for one move, worked out from its
 * source rather than run.
 *
 * The body is a single template literal, so the substitution is mechanical: the
 * prefix constant and the two ends of the move are the only interpolations in
 * it. A leftover `${…}` means the function grew a part this guard does not
 * understand, and that fails rather than silently comparing half a string.
 */
function towerRefFor(move) {
  const template = capture(
    SHARED,
    /export function lifecycleMoveRef\([^)]*\)[^{]*\{\s*return\s*`([^`]*)`/,
    'the template literal `lifecycleMoveRef` returns',
  );
  const built = template
    .replaceAll('${LIFECYCLE_REF_PREFIX}', towerPrefix())
    .replaceAll('${move.from}', move.from)
    .replaceAll('${move.to}', move.to);
  assert.doesNotMatch(
    built,
    /\$\{/,
    `${SHARED}: \`lifecycleMoveRef\` interpolates something scripts/lifecycle-ref.test.mjs does not know how to substitute (${template}). Teach the guard the new part in the same change.`,
  );
  return built;
}

/**
 * Every kind the store's CHECK constraint accepts — the thing that would refuse
 * a write, whatever the two sources agree on between themselves.
 *
 * Scoped to the `annotations` table first: `flags` has a `kind` column with a
 * CHECK of its own, and an unanchored read finds that one.
 */
function storeKinds() {
  const table = capture(
    MIGRATION,
    /CREATE TABLE noticeos\.annotations \(([\s\S]*?)\n\);/,
    'the `annotations` CREATE TABLE',
  );
  const check = table.match(/kind\s+text NOT NULL CHECK \(kind IN \(([^)]*)\)\)/);
  assert.ok(
    check,
    `${MIGRATION}: the annotations table no longer declares a \`kind … CHECK (kind IN (…))\`. The guard in scripts/lifecycle-ref.test.mjs reads it by regex — update the pattern here in the same change.`,
  );
  return [...check[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

// ─────────────────────────────────────────────────────────────────────────────

test('both writers spell the same stage move the same way', () => {
  const moves = [];
  for (const from of ASSET_STATUS) {
    for (const to of ASSET_STATUS) {
      if (from === to) continue;
      moves.push({ from, to });
    }
  }
  assert.ok(moves.length > 0, 'ASSET_STATUS read back empty, so nothing was compared');

  for (const move of moves) {
    assert.equal(
      lifecycleMoveRef(move),
      towerRefFor(move),
      `scripts/config-apply-core.mjs and ${SHARED} disagree on the ref for ${move.from} → ${move.to}. ` +
        'Both write it; Restore reads it. Change them together.',
    );
  }

  // The prefix is what stops an operator-written ref from being read as a move,
  // so it is asserted on its own rather than only inside the whole string.
  assert.equal(LIFECYCLE_REF_PREFIX, towerPrefix());
});

test('the kind a move is recorded under is one the store accepts', () => {
  assert.equal(
    LIFECYCLE_ANNOTATION_KIND,
    towerKind(),
    `scripts/config-apply-core.mjs and ${SHARED} record a stage move under different annotation kinds, so Restore would not find the CLI's rows.`,
  );
  assert.ok(
    storeKinds().includes(LIFECYCLE_ANNOTATION_KIND),
    `${MIGRATION}: the annotations.kind CHECK constraint does not accept ${JSON.stringify(
      LIFECYCLE_ANNOTATION_KIND,
    )} — it lists ${storeKinds().join(', ')}. Widening it is a migration, which is operator-only (AGENTS.md).`,
  );
});
