import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { LIFECYCLE_ANNOTATION_KIND } from '../packages/contract/src/configuration.mjs';

// A stage move is recorded on the annotation timeline under one kind, and the
// store refuses a kind its CHECK constraint does not list, so the kind both
// writers use must be one the Postgres baseline accepts.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = 'db/postgres/migrations/0001_baseline.sql';

/**
 * Every kind the `annotations` CHECK constraint accepts. Scoped to that table
 * first: `flags` has a `kind` column with a CHECK of its own, and an unanchored
 * read finds that one.
 */
function storeKinds() {
  const sql = readFileSync(path.join(ROOT, MIGRATION), 'utf8');
  const table = sql.match(/CREATE TABLE noticeos\.annotations \(([\s\S]*?)\n\);/);
  assert.ok(table, `${MIGRATION}: could not find the \`annotations\` CREATE TABLE; update the pattern here in the same change.`);
  const check = table[1].match(/kind\s+text NOT NULL CHECK \(kind IN \(([^)]*)\)\)/);
  assert.ok(
    check,
    `${MIGRATION}: the annotations table no longer declares a \`kind … CHECK (kind IN (…))\`; update the pattern here in the same change.`,
  );
  return [...check[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

test('the kind a stage move is recorded under is one the store accepts', () => {
  assert.ok(
    storeKinds().includes(LIFECYCLE_ANNOTATION_KIND),
    `${MIGRATION}: the annotations.kind CHECK constraint does not accept ${JSON.stringify(
      LIFECYCLE_ANNOTATION_KIND,
    )} — it lists ${storeKinds().join(', ')}. Widening it is a migration, which is operator-only (AGENTS.md).`,
  );
});
