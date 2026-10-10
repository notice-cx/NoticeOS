// The docs index cannot go stale.
//
// docs/README.md lists every numbered doc. The root README once hand-kept the
// same list and missed 21, 24 and 25 while docs/ grew; a list nobody checks is
// a list that drifts. So: every docs/NN-*.md is linked from the index, every
// numbered link in the index opens a real file, and the root README sends a
// reader there.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(REPO_ROOT, 'docs');
const NUMBERED = /^\d{2}-[a-z0-9-]+\.md$/;

const numberedDocs = () => readdirSync(DOCS).filter((name) => NUMBERED.test(name)).sort();
const indexLinks = () =>
  [...readFileSync(path.join(DOCS, 'README.md'), 'utf8').matchAll(/\]\((\d{2}-[a-z0-9-]+\.md)(?:#[^)]*)?\)/g)].map((match) => match[1]);

test('every numbered doc is in the docs index', () => {
  const listed = new Set(indexLinks());
  const missing = numberedDocs().filter((name) => !listed.has(name));
  assert.deepEqual(missing, [], `add these to docs/README.md: ${missing.join(', ')}`);
});

test('every numbered link in the docs index opens a doc that exists', () => {
  const present = new Set(numberedDocs());
  const dead = indexLinks().filter((name) => !present.has(name));
  assert.deepEqual(dead, [], `docs/README.md links to missing docs: ${dead.join(', ')}`);
});

test('the root README sends a reader to the docs index and says how to start', () => {
  const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\]\(docs\/README\.md\)/);
  assert.match(readme, /^pnpm start$/m);
});
