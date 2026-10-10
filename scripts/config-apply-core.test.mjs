import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ADDABLE_CONTAINERS,
  ADDABLE_DOCUMENTS,
  ALLOWED_FILES,
  ChangesetError,
  MISSING,
  applyFileOps,
  archiveChangeset,
  deepEqual,
  nextArchiveNumber,
  pointerDelete,
  pointerGet,
  pointerInsert,
  pointerSet,
  resolve,
  validateSchemaAndSafety,
} from './config-apply-core.mjs';
import { documentRefusal } from './config-documents.mjs';

// The FILE half of the pipeline, shared by `pnpm config:apply` and the Tower's
// write lane: pointer writes, the read-modify-write, the archive's numbering,
// and the refusals that stand between a request body and a repo file. The
// CLI's own suite covers the store lane against a stubbed ingest door.
//
// Every case runs against a THROWAWAY repo root. `repoRoot` is a parameter on
// each function precisely so a test never has to write into the real config/.

async function tempRepo(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'config-core-'));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  for (const [rel, value] of Object.entries(files)) {
    await fs.writeFile(path.join(root, rel), JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
  return root;
}

/** The smallest layout the Wall can draw: one row, taking the screen, with the
 * asset grid in it. Enough for the pipeline's own checks; the layout GRAMMAR
 * is tested in apps/tower/test/wall-layout.test.ts. */
const DRAWABLE_WALL = {
  version: 1,
  rows: [{ id: 'sites', height: 'fill', widgets: [{ id: 'sites', type: 'sites', width: 1 }] }],
};

function changeset(ops, overrides = {}) {
  return {
    version: 1,
    slug: 'test-changeset',
    createdAt: '2026-09-04T00:00:00.000Z',
    ops,
    ...overrides,
  };
}

function fileOp(overrides = {}) {
  return {
    kind: 'file-json-set',
    file: 'config/constants.json',
    pointer: '/flag_defaults/alpha',
    expect: 0.01,
    value: 0.05,
    ...overrides,
  };
}

const CONSTANTS = {
  monthly_caps: { data_usd: 25, inference_usd: 10 },
  flag_defaults: { alpha: 0.01, min_baseline_per_day: 3 },
};

test('pointerGet returns MISSING for an absent segment, and the value for a present null', () => {
  const doc = { a: { b: 1 }, n: null, list: [{ url: 'x' }] };
  assert.equal(pointerGet(doc, '/a/b'), 1);
  assert.equal(pointerGet(doc, '/list/0/url'), 'x');
  assert.equal(pointerGet(doc, '/n'), null);
  assert.equal(pointerGet(doc, '/a/nope'), MISSING);
  assert.equal(pointerGet(doc, '/list/9'), MISSING);
});

// A changeset EDITS values that already exist; it never invents structure. That
// is the difference between a settings write and an arbitrary file write, and it
// is enforced here rather than by whoever happens to build the op.
test('pointerSet refuses to create structure, and refuses the whole document', () => {
  const doc = { a: { b: 1 }, list: [1, 2] };
  pointerSet(doc, '/a/b', 2);
  assert.equal(doc.a.b, 2);
  pointerSet(doc, '/list/1', 9);
  assert.deepEqual(doc.list, [1, 9]);
  assert.throws(() => pointerSet(doc, '/a/new', 1), /sets a missing key/);
  assert.throws(() => pointerSet(doc, '/list/5', 1), /out-of-range array index/);
  assert.throws(() => pointerSet(doc, '', 1), /refusing to replace the whole document/);
});

test('deepEqual compares JSON structurally, not by reference', () => {
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual(0, '0'), false);
  assert.equal(deepEqual(null, undefined), false);
});

test('the file allowlist is the boundary — anything outside it is refused by name', () => {
  // A file that declares a KNOB answers with the knob it declares rather than
  // with the four wholesale-editable files, which are not what the writer was
  // reaching for.
  assert.throws(
    () => validateSchemaAndSafety(changeset([fileOp({ file: 'config/signal-panels.json' })])),
    /is not a settable knob in config\/signal-panels\.json/,
  );
  assert.throws(
    () => validateSchemaAndSafety(changeset([fileOp({ file: '../.dev.vars' })])),
    /is not editable/,
  );
  assert.throws(
    () => validateSchemaAndSafety(changeset([fileOp({ pointer: '' })])),
    /refusing to replace an entire file/,
  );
  const noExpect = fileOp();
  delete noExpect.expect;
  assert.throws(() => validateSchemaAndSafety(changeset([noExpect])), /missing "expect"/);
  assert.throws(() => validateSchemaAndSafety(changeset([], { slug: 'Not Kebab' })), /kebab-case/);
  // The allowlist is explicit, never a config/ glob: four named files.
  assert.deepEqual([...ALLOWED_FILES].sort(), [
    'config/constants.json',
    'config/integrations.json',
    'config/pull.json',
    'config/tower.json',
  ]);
});

test('resolve reads current values off disk and reports every stale op at once', async () => {
  const root = await tempRepo({ 'config/constants.json': CONSTANTS });
  const cs = changeset([
    fileOp(),
    fileOp({ pointer: '/monthly_caps/data_usd', expect: 999, value: 40 }),
    fileOp({ pointer: '/flag_defaults/nope', expect: null, value: 1 }),
  ]);

  const { resolved, mismatches } = await resolve(cs, null, { repoRoot: root });

  assert.equal(resolved[0].current, 0.01);
  assert.equal(mismatches.length, 2);
  assert.equal(mismatches[0].current, 25);
  assert.equal(mismatches[1].current, MISSING);
});

test('a store op cannot be applied by a lane that has no store', async () => {
  const root = await tempRepo({ 'config/constants.json': CONSTANTS });
  const cs = changeset([
    { kind: 'store-asset-set', asset: 'meals.example', column: 'status', expect: 'live', value: 'retired' },
  ]);
  await assert.rejects(resolve(cs, null, { repoRoot: root }), ChangesetError);
  await assert.rejects(
    resolve(cs, null, { repoRoot: root }),
    /PATCH \/api\/assets\/:id/,
  );
});

test('applyFileOps writes each touched file once, 2-space JSON with a trailing newline', async () => {
  const root = await tempRepo({ 'config/constants.json': CONSTANTS });
  const cs = changeset([
    fileOp(),
    fileOp({ pointer: '/monthly_caps/data_usd', expect: 25, value: 40 }),
  ]);

  const { resolved, mismatches, fileCache } = await resolve(cs, null, { repoRoot: root });
  assert.deepEqual(mismatches, []);
  const written = await applyFileOps(resolved, fileCache, { repoRoot: root });

  assert.deepEqual(written, ['installation/constants.json']);
  const raw = await fs.readFile(path.join(root, 'installation/constants.json'), 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(raw.includes('\n  "monthly_caps"'), true);
  const doc = JSON.parse(raw);
  assert.equal(doc.flag_defaults.alpha, 0.05);
  assert.equal(doc.monthly_caps.data_usd, 40);
  // Untouched keys survive byte-for-byte semantics: this is a read-modify-write
  // of one value, never a re-serialization of somebody's idea of the file.
  assert.equal(doc.flag_defaults.min_baseline_per_day, 3);
});

// config/ holds the product's defaults, the installation folder holds this
// installation's own copy. A write starts from the default when the
// installation has none, lands in the installation, and the default is never
// rewritten; the next read takes the installation's copy.
test('a write lands in the installation folder and leaves the product default alone', async () => {
  const root = await tempRepo({ 'config/constants.json': CONSTANTS });
  const before = await fs.readFile(path.join(root, 'config/constants.json'), 'utf8');

  const first = await resolve(changeset([fileOp()]), null, { repoRoot: root });
  assert.deepEqual(first.mismatches, []);
  await applyFileOps(first.resolved, first.fileCache, { repoRoot: root });
  assert.equal(await fs.readFile(path.join(root, 'config/constants.json'), 'utf8'), before);

  // The second edit expects the installation's value, not the default's.
  const second = await resolve(changeset([fileOp({ expect: 0.05, value: 0.02 })]), null, { repoRoot: root });
  assert.deepEqual(second.mismatches, []);
  assert.deepEqual(await applyFileOps(second.resolved, second.fileCache, { repoRoot: root }), ['installation/constants.json']);
  const installed = JSON.parse(await fs.readFile(path.join(root, 'installation/constants.json'), 'utf8'));
  assert.equal(installed.flag_defaults.alpha, 0.02);
  assert.equal(await fs.readFile(path.join(root, 'config/constants.json'), 'utf8'), before);
});

test('the archive takes the next four-digit number, migration-style', async () => {
  const root = await tempRepo();
  assert.equal(await nextArchiveNumber({ repoRoot: root }), 1);

  const first = await archiveChangeset(changeset([fileOp()], { slug: 'first-edit' }), { repoRoot: root });
  assert.equal(first, 'installation/changesets/0001_first-edit.json');

  const second = await archiveChangeset(changeset([fileOp()], { slug: 'second-edit' }), { repoRoot: root });
  assert.equal(second, 'installation/changesets/0002_second-edit.json');

  // A file that is not a numbered changeset (a README) never moves the counter.
  await fs.writeFile(path.join(root, 'installation/changesets/README.md'), '# archive\n', 'utf8');
  assert.equal(await nextArchiveNumber({ repoRoot: root }), 3);

  const stored = JSON.parse(await fs.readFile(path.join(root, first), 'utf8'));
  assert.equal(stored.slug, 'first-edit');
  assert.equal(stored.version, 1);
  assert.equal(stored.ops.length, 1);
});

// file-json-insert / file-json-delete: the ops that change a config file's
// SHAPE. The pipeline's rule is "never create structure", which is what keeps a
// settings write from being an arbitrary file write; adding an asset needs
// exactly the opposite, so these two get their OWN allowlist (one container per
// file, addressed by asset id) rather than widening the one that governs
// `file-json-set`.

const INTEGRATIONS = {
  version: 1,
  catalog: [{ id: 'gsc', label: 'Google Search Console' }],
  assets: { 'meals.example': { gsc: { status: 'live' } } },
};
const COUNTERS = { assets: { 'meals.example': { cards: [] } } };
const PULL = [
  { asset: 'meals.example', url: 'https://meals.example/m', enabled: true },
  { asset: 'nosh.example', url: 'https://nosh.example/o', enabled: true },
];
// The two panel registers. Both carry file-level metadata beside their
// `/assets` map (the roster's refresh block is what a pass costs), which is
// exactly what the one-container rule keeps an asset write away from.
const SIGNAL_PANELS = {
  version: 1,
  refresh: { windowDays: 35, freshnessMaxAgeDays: 7, providerCostUsdPerPass: 0 },
  assets: {
    'meals.example': {
      enabled: true,
      reason: 'live-lanes',
      task: 'ex-12.5',
      // A LEGACY key: stored rows still carry one, and a field write must
      // leave it.
      note: 'GSC + GA4 live.',
      since: '2026-08-03',
    },
  },
};
const SERP_PANEL = {
  assets: {
    'meals.example': { queries: ['meals', 'meals calculator'] },
  },
};
// The portfolio's legal entities. An asset's owner is a string on one of these
// rows rather than an entry of the asset's own, which is why a delete reaches it
// with a guarded SET.
const ENTITIES = {
  version: 1,
  entities: [
    { slug: 'first-co', name: 'First Co' },
    {
      slug: 'second-co',
      name: 'Second Co LLC',
      assets: ['meals.example', 'fees.example'],
    },
  ],
};

function insertOp(overrides = {}) {
  return {
    kind: 'file-json-insert',
    file: 'config/integrations.json',
    pointer: '/assets/brandnew.test',
    value: { uptime: { status: 'needs-setup' } },
    ...overrides,
  };
}

function deleteOp(overrides = {}) {
  return {
    kind: 'file-json-delete',
    file: 'config/integrations.json',
    pointer: '/assets/meals.example',
    expect: INTEGRATIONS.assets['meals.example'],
    ...overrides,
  };
}

test('pointerInsert adds a key, appends, or splices in at a position', () => {
  const doc = { assets: { a: 1 }, list: [1, 2] };
  pointerInsert(doc, '/assets/b', 2);
  assert.deepEqual(doc.assets, { a: 1, b: 2 });
  pointerInsert(doc, '/list/-', 3);
  assert.deepEqual(doc.list, [1, 2, 3]);

  // An INDEX splices in and shifts the rest down (RFC 6902's `add` for an
  // array), which is what undoing a removal needs. Which registers may say one
  // is `positionedInsert`'s answer, one level up; this primitive just does it.
  // The end of the list is a position too.
  pointerInsert(doc, '/list/1', 9);
  assert.deepEqual(doc.list, [1, 9, 2, 3]);
  pointerInsert(doc, '/list/4', 5);
  assert.deepEqual(doc.list, [1, 9, 2, 3, 5]);

  // The one thing an insert must never do is silently replace a configuration.
  assert.throws(() => pointerInsert(doc, '/assets/a', 9), /refusing to overwrite/);
  // Past the end is a claim about a list that has moved, not an append.
  assert.throws(() => pointerInsert(doc, '/list/9', 9), /an index from 0 to 5 is allowed/);
  assert.throws(() => pointerInsert(doc, '/nope/x', 1), /walks through a missing key/);
});

test('pointerDelete removes a key and SPLICES an array element rather than holing it', () => {
  const doc = { assets: { a: 1, b: 2 }, list: [1, 2, 3] };
  pointerDelete(doc, '/assets/a');
  assert.deepEqual(doc.assets, { b: 2 });
  pointerDelete(doc, '/list/1');
  assert.deepEqual(doc.list, [1, 3]);

  assert.throws(() => pointerDelete(doc, '/assets/gone'), /removes a missing key/);
  assert.throws(() => pointerDelete(doc, '/list/9'), /out-of-range array index/);
});

// This key set is pinned so growing it is a decision, not a side effect of
// declaring a register. It is the ASSET LIFECYCLE's list: the files an asset is
// born into and deleted out of, which is exactly the list the Settings tab's
// Delete confirmation names and clears. An asset's own value events and
// registered dimensions are part of what the asset IS, so they leave with it.
test('the add/remove allowlist names one container per file, and nothing else', () => {
  assert.deepEqual([...ADDABLE_CONTAINERS.keys()].sort(), [
    'config/counters.json',
    'config/ga4-custom-dimensions.json',
    'config/integrations.json',
    'config/pull.json',
    'config/serp-panel.json',
    'config/signal-panels.json',
    'config/value-events.json',
  ]);

  // A file a value may be SET in is not automatically a file that may GROW.
  assert.throws(
    () => validateSchemaAndSafety(changeset([insertOp({ file: 'config/constants.json' })])),
    /may not touch/,
  );
  // And the reverse: these three may grow by an asset but not be edited. "May
  // add an asset's entry" and "may rewrite any value in this file" are separate
  // permissions, refusable separately. One of them declares a scalar KNOB, so
  // its refusal names the pointers that would have worked instead of the
  // wholesale allowlist; a knob licenses one pointer and not the file.
  for (const [file, rule] of [
    ['config/counters.json', /is not editable/],
    ['config/signal-panels.json', /is not a settable knob/],
    ['config/serp-panel.json', /is not editable/],
  ]) {
    assert.throws(
      () => validateSchemaAndSafety(changeset([fileOp({ file })])),
      rule,
      `file ${file}`,
    );
  }

  // Only a declared row of this file, and nothing between or above one.
  for (const pointer of ['/assets', '/assets/NOT VALID']) {
    assert.throws(
      () => validateSchemaAndSafety(changeset([insertOp({ pointer })])),
      /must be \/assets\/<asset-id>/,
      `pointer ${pointer}`,
    );
  }
  // `/catalog/0` IS a row of this file (the catalog is an array register with
  // declared fields, so an insert may name a POSITION in it), and what decides
  // is the VALUE. The same shape as the lane case below.
  assert.throws(
    () => validateSchemaAndSafety(changeset([insertOp({ pointer: '/catalog/0' })])),
    /is not a field here — this one declares id, label/,
  );
  // ONE LANE INSIDE AN ASSET'S ENTRY is a row too, since `asset-lane` declared
  // it. So the pointer is legal and the VALUE is what decides: a lane cell
  // needs the fields a lane cell has, and the refusal names them.
  assert.throws(
    () => validateSchemaAndSafety(changeset([insertOp({ pointer: '/assets/meals.example/gsc' })])),
    /is not a field here — this one declares/,
  );
  assert.doesNotThrow(() =>
    validateSchemaAndSafety(
      changeset([
        insertOp({
          pointer: '/assets/meals.example/gsc',
          value: { status: 'needs-setup', note: 'Nobody has decided it yet.', since: '2026-09-05' },
        }),
      ]),
    ),
  );

  // A tracked query's own list is an array register with declared fields, so a
  // POSITION in it is a row an insert may name, which is how undoing a removal
  // puts the term back where it was. The pointer is legal and the value
  // decides, exactly as above; the LIST itself still is not.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          insertOp({ file: 'config/serp-panel.json', pointer: '/assets/meals.example/queries/0' }),
        ]),
      ),
    /is not a field here — this one declares query, label/,
  );
  assert.doesNotThrow(() =>
    validateSchemaAndSafety(
      changeset([
        insertOp({
          file: 'config/serp-panel.json',
          pointer: '/assets/meals.example/queries/0',
          value: 'big mac calories',
        }),
      ]),
    ),
  );

  // The two panel registers hold more than their `/assets` map, and nothing
  // above it is reachable: not the refresh cadence, not the list holding a
  // panel's terms.
  for (const [file, pointer] of [
    ['config/signal-panels.json', '/refresh'],
    ['config/signal-panels.json', '/assets/meals.example/enabled'],
    ['config/serp-panel.json', '/assets/meals.example/queries'],
  ]) {
    assert.throws(
      () => validateSchemaAndSafety(changeset([insertOp({ file, pointer })])),
      /must be \/assets\/<asset-id>/,
      `${file} ${pointer}`,
    );
  }
});

test('an insert carries no expect — its guard is fixed at absence', () => {
  assert.throws(
    () => validateSchemaAndSafety(changeset([insertOp({ expect: null })])),
    /takes no "expect"/,
  );
  const noValue = insertOp();
  delete noValue.value;
  assert.throws(() => validateSchemaAndSafety(changeset([noValue])), /missing "value"/);
  assert.throws(
    () => validateSchemaAndSafety(changeset([insertOp({ value: 'a string' })])),
    /must be a JSON object/,
  );
});

test('a delete carries the value it believes it is removing, and no replacement', () => {
  const noExpect = deleteOp();
  delete noExpect.expect;
  assert.throws(() => validateSchemaAndSafety(changeset([noExpect])), /missing "expect"/);
  assert.throws(
    () => validateSchemaAndSafety(changeset([deleteOp({ value: {} })])),
    /takes no "value"/,
  );
});

test('config/pull.json is an ARRAY: an insert appends, a delete names an index', () => {
  const append = insertOp({
    file: 'config/pull.json',
    pointer: '/-',
    value: { asset: 'brandnew.test', url: 'https://brandnew.test/m', enabled: true },
  });
  validateSchemaAndSafety(changeset([append]));

  // An append is the only insert THIS array takes. It is the one register in the
  // map whose rows are OPAQUE (whole asset endpoints the wizard files and
  // unfiles), so nothing reads their order and an index would be a claim about
  // nothing; every array register with declared FIELDS may name a position,
  // because that is what puts a removed row back where it was.
  assert.throws(
    () => validateSchemaAndSafety(changeset([{ ...append, pointer: '/0' }])),
    /pointer must be "\/-"/,
  );
  // And an appended entry has to carry its own asset id, or nothing could ever
  // find it again to remove it.
  assert.throws(
    () => validateSchemaAndSafety(changeset([{ ...append, value: { url: 'https://x.test' } }])),
    /needs an "asset" id/,
  );
  // Removal is by index, guarded by the whole entry as `expect`.
  validateSchemaAndSafety(
    changeset([deleteOp({ file: 'config/pull.json', pointer: '/1', expect: PULL[1] })]),
  );
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([deleteOp({ file: 'config/pull.json', pointer: '/nosh.example', expect: PULL[1] })]),
      ),
    /must be \/<index>/,
  );
});

// Splicing renumbers everything after it, so a second index-addressed op would
// have been resolved against indices that no longer exist.
test('only one array entry may be spliced in or out per changeset', () => {
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          deleteOp({ file: 'config/pull.json', pointer: '/0', expect: PULL[0] }),
          deleteOp({ file: 'config/pull.json', pointer: '/1', expect: PULL[1] }),
        ]),
      ),
    /only one entry may be spliced in or out per changeset/,
  );
});

test('an insert onto a key that is already taken resolves as a mismatch, and writes nothing', async () => {
  const root = await tempRepo({ 'config/integrations.json': INTEGRATIONS });
  const cs = changeset([insertOp({ pointer: '/assets/meals.example' })]);

  const { mismatches, fileCache } = await resolve(cs, null, { repoRoot: root });
  assert.equal(mismatches.length, 1);
  // The guard on an insert is absence, so that is what it "expected".
  assert.equal(mismatches[0].expect, MISSING);
  assert.deepEqual(mismatches[0].current, INTEGRATIONS.assets['meals.example']);

  // Nothing was applied — the caller refuses the whole set on any mismatch.
  assert.deepEqual(await applyFileOps([], fileCache, { repoRoot: root }), []);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, 'config/integrations.json'), 'utf8')),
    INTEGRATIONS,
  );
});

test('a delete whose expect no longer matches the entry is a mismatch', async () => {
  const root = await tempRepo({ 'config/integrations.json': INTEGRATIONS });
  const cs = changeset([deleteOp({ expect: { gsc: { status: 'needs-setup' } } })]);

  const { mismatches } = await resolve(cs, null, { repoRoot: root });
  assert.equal(mismatches.length, 1);
  assert.deepEqual(mismatches[0].current, INTEGRATIONS.assets['meals.example']);
});

test('an asset is added to all three registers, and removed from them again', async () => {
  const root = await tempRepo({
    'config/integrations.json': INTEGRATIONS,
    'config/counters.json': COUNTERS,
    'config/pull.json': PULL,
  });
  const readBack = async (rel) => JSON.parse(await fs.readFile(path.join(root, rel.replace(/^config\//, 'installation/')), 'utf8'));

  const add = changeset([
    insertOp(),
    insertOp({ file: 'config/counters.json', value: { cards: [] } }),
    insertOp({
      file: 'config/pull.json',
      pointer: '/-',
      value: { asset: 'brandnew.test', url: 'https://brandnew.test/m', enabled: true },
    }),
  ]);
  validateSchemaAndSafety(add);
  const added = await resolve(add, null, { repoRoot: root });
  assert.deepEqual(added.mismatches, []);
  const written = await applyFileOps(added.resolved, added.fileCache, { repoRoot: root });
  assert.deepEqual(written.sort(), [
    'installation/counters.json',
    'installation/integrations.json',
    'installation/pull.json',
  ]);

  const integrations = await readBack('config/integrations.json');
  assert.deepEqual(integrations.assets['brandnew.test'], { uptime: { status: 'needs-setup' } });
  // The rest of the file is untouched: this is a read-modify-write of one key.
  assert.deepEqual(integrations.catalog, INTEGRATIONS.catalog);
  assert.ok('meals.example' in integrations.assets);
  assert.equal((await readBack('config/pull.json')).length, 3);
  assert.equal((await readBack('config/pull.json'))[2].asset, 'brandnew.test');

  // …and back out again. The delete's expect is the entry as just written.
  const remove = changeset([
    deleteOp({ pointer: '/assets/brandnew.test', expect: { uptime: { status: 'needs-setup' } } }),
    deleteOp({
      file: 'config/counters.json',
      pointer: '/assets/brandnew.test',
      expect: { cards: [] },
    }),
    deleteOp({
      file: 'config/pull.json',
      pointer: '/2',
      expect: { asset: 'brandnew.test', url: 'https://brandnew.test/m', enabled: true },
    }),
  ]);
  validateSchemaAndSafety(remove);
  const removed = await resolve(remove, null, { repoRoot: root });
  assert.deepEqual(removed.mismatches, []);
  await applyFileOps(removed.resolved, removed.fileCache, { repoRoot: root });

  assert.deepEqual(await readBack('config/integrations.json'), INTEGRATIONS);
  assert.deepEqual(await readBack('config/counters.json'), COUNTERS);
  // Spliced, not holed: the array is the same list it started as.
  assert.deepEqual(await readBack('config/pull.json'), PULL);
});

// The two panel registers key by asset id, and a deleted asset must not go on
// being named by the file that decides what the weekly collector buys.
test('the two panel registers grow and shrink by one asset, and nothing else moves', async () => {
  const root = await tempRepo({
    'config/signal-panels.json': SIGNAL_PANELS,
    'config/serp-panel.json': SERP_PANEL,
  });
  const readBack = async (rel) => JSON.parse(await fs.readFile(path.join(root, rel.replace(/^config\//, 'installation/')), 'utf8'));

  const rosterRow = {
    enabled: false,
    reason: 'no-lane-yet',
    task: 'ex-12.2',
    since: '2026-09-04',
  };
  const panel = { queries: ['brandnew calculator'] };

  const add = changeset([
    insertOp({ file: 'config/signal-panels.json', value: rosterRow }),
    insertOp({ file: 'config/serp-panel.json', value: panel }),
  ]);
  validateSchemaAndSafety(add);
  const added = await resolve(add, null, { repoRoot: root });
  assert.deepEqual(added.mismatches, []);
  assert.deepEqual(
    (await applyFileOps(added.resolved, added.fileCache, { repoRoot: root })).sort(),
    ['installation/serp-panel.json', 'installation/signal-panels.json'],
  );

  const roster = await readBack('config/signal-panels.json');
  assert.deepEqual(roster.assets['brandnew.test'], rosterRow);
  // The refresh block is what a panel pass costs and how far back it reads. An
  // asset being added must not be able to reach it.
  assert.deepEqual(roster.refresh, SIGNAL_PANELS.refresh);
  assert.ok('meals.example' in roster.assets);
  assert.deepEqual((await readBack('config/serp-panel.json')).assets['brandnew.test'], panel);

  const remove = changeset([
    deleteOp({
      file: 'config/signal-panels.json',
      pointer: '/assets/brandnew.test',
      expect: rosterRow,
    }),
    deleteOp({
      file: 'config/serp-panel.json',
      pointer: '/assets/brandnew.test',
      expect: panel,
    }),
  ]);
  validateSchemaAndSafety(remove);
  const removed = await resolve(remove, null, { repoRoot: root });
  assert.deepEqual(removed.mismatches, []);
  await applyFileOps(removed.resolved, removed.fileCache, { repoRoot: root });

  assert.deepEqual(await readBack('config/signal-panels.json'), SIGNAL_PANELS);
  assert.deepEqual(await readBack('config/serp-panel.json'), SERP_PANEL);
});

// A deleted asset comes off its owner's list: the asset's own entries go, and
// the id it left on the entity that owned it is written out of that row's list
// in one changeset, so the terminal cannot leave a ghost the Tower would not.
test("an asset's id leaves the entity that owned it, and the row itself stays", async () => {
  const root = await tempRepo({
    'config/integrations.json': INTEGRATIONS,
    'config/entities.json': ENTITIES,
  });
  const readBack = async (rel) => JSON.parse(await fs.readFile(path.join(root, rel.replace(/^config\//, 'installation/')), 'utf8'));

  const remove = changeset([
    deleteOp(),
    {
      kind: 'file-json-set',
      file: 'config/entities.json',
      pointer: '/entities/1/assets',
      expect: ['meals.example', 'fees.example'],
      value: ['fees.example'],
    },
  ]);
  validateSchemaAndSafety(remove);
  const removed = await resolve(remove, null, { repoRoot: root });
  assert.deepEqual(removed.mismatches, []);
  assert.deepEqual(
    (await applyFileOps(removed.resolved, removed.fileCache, { repoRoot: root })).sort(),
    ['installation/entities.json', 'installation/integrations.json'],
  );

  const entities = await readBack('config/entities.json');
  // The entity is a legal person: it keeps its row, its name, and every other
  // asset it owns. Only the id of the asset that no longer exists is gone.
  assert.deepEqual(entities.entities[1], {
    slug: 'second-co',
    name: 'Second Co LLC',
    assets: ['fees.example'],
  });
  assert.deepEqual(entities.entities[0], ENTITIES.entities[0]);
});

test('a list that moved since the delete was offered is a mismatch, and nothing is written', async () => {
  const root = await tempRepo({ 'config/entities.json': ENTITIES });
  const stale = changeset([
    {
      kind: 'file-json-set',
      file: 'config/entities.json',
      pointer: '/entities/1/assets',
      // What the page rendered before a second asset was claimed.
      expect: ['meals.example'],
      value: [],
    },
  ]);
  validateSchemaAndSafety(stale);
  const resolved = await resolve(stale, null, { repoRoot: root });
  assert.equal(resolved.mismatches.length, 1);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, 'config/entities.json'), 'utf8')),
    ENTITIES,
  );
});

// The date a file states about itself.
//
// `config/integrations.json` and `config/signal-panels.json` each carry a
// top-level `updated` beside their version. Nothing reads the field; what is
// wrong is a file allowed to state a fact about itself falsely. The rule is
// DECLARED (`DOCUMENT_STAMPS`) and applied by `applyDocumentOps`, the one place
// every entry point applies its ops, so the terminal, the dev write lane and
// the ingest Worker stamp identically, and a file the declaration does not name
// is stamped by nothing.
const DATED_INTEGRATIONS = { ...INTEGRATIONS, updated: '2026-08-09' };
const DATED_SIGNAL_PANELS = { ...SIGNAL_PANELS, updated: '2026-08-05' };

test("an insert and a delete each leave the file's own updated date equal to the apply date", async () => {
  const root = await tempRepo({ 'config/integrations.json': DATED_INTEGRATIONS });
  const readBack = async (rel) => JSON.parse(await fs.readFile(path.join(root, rel.replace(/^config\//, 'installation/')), 'utf8'));
  const at = '2026-09-05T18:30:00.000Z';

  const add = changeset([insertOp()], { createdAt: at });
  validateSchemaAndSafety(add);
  const added = await resolve(add, null, { repoRoot: root });
  assert.deepEqual(added.mismatches, []);
  await applyFileOps(added.resolved, added.fileCache, { repoRoot: root, at });
  assert.equal((await readBack('config/integrations.json')).updated, '2026-09-05');

  // A DELETE is a change to the file too.
  const remove = changeset([deleteOp({ pointer: '/assets/brandnew.test', expect: insertOp().value })], {
    createdAt: '2026-09-06T02:00:00.000Z',
  });
  validateSchemaAndSafety(remove);
  const removed = await resolve(remove, null, { repoRoot: root });
  assert.deepEqual(removed.mismatches, []);
  await applyFileOps(removed.resolved, removed.fileCache, {
    repoRoot: root,
    at: '2026-09-06T02:00:00.000Z',
  });
  const after = await readBack('config/integrations.json');
  assert.equal(after.updated, '2026-09-06');
  // And it changed NOTHING else: the file is back to what it was, one date on.
  assert.deepEqual(after, { ...DATED_INTEGRATIONS, updated: '2026-09-06' });
});

test('a set stamps the roster file too, and a file that states no date gains none', async () => {
  const root = await tempRepo({
    'config/signal-panels.json': DATED_SIGNAL_PANELS,
    // The same register in a file that never claimed a date. A stamp REFRESHES
    // what is there; creating structure is the one thing this pipeline never
    // does, and a file that claims nothing is not lying.
    'config/serp-panel.json': SERP_PANEL,
  });
  const readBack = async (rel) => JSON.parse(await fs.readFile(path.join(root, rel.replace(/^config\//, 'installation/')), 'utf8'));
  const at = '2026-09-07T09:00:00.000Z';

  const cs = changeset(
    [
      {
        kind: 'file-json-set',
        file: 'config/signal-panels.json',
        pointer: '/refresh/windowDays',
        expect: 35,
        value: 60,
      },
      insertOp({ file: 'config/serp-panel.json', pointer: '/assets/brandnew.test', value: { queries: ['x'] } }),
    ],
    { createdAt: at },
  );
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, fileCache } = await resolve(cs, null, { repoRoot: root });
  assert.deepEqual(mismatches, []);
  await applyFileOps(resolved, fileCache, { repoRoot: root, at });

  assert.equal((await readBack('config/signal-panels.json')).updated, '2026-09-07');
  assert.equal('updated' in (await readBack('config/serp-panel.json')), false);
});

// A roster row's decision date moves with the decision.
//
// `since` is defined as "when the decision was taken", and the Growth tab edits
// `enabled`, `reason`, `task` and `since` as four independent cells, so the
// pipeline has to stamp the NEW decision with its own day. The pair is DECLARED
// on the register (`stamps`) rather than written into the surface, so it holds
// for a hand-written changeset and for a deployed Save as well as for the
// click, and CollectionEditor's one-changeset-per-cell contract is untouched.
test('flipping a roster row dates the decision, in both directions', async () => {
  const root = await tempRepo({ 'config/signal-panels.json': DATED_SIGNAL_PANELS });
  const readBack = async () =>
    JSON.parse(await fs.readFile(path.join(root, 'installation/signal-panels.json'), 'utf8'));
  const flip = (expect_, value) => ({
    kind: 'file-json-set',
    file: 'config/signal-panels.json',
    pointer: '/assets/meals.example/enabled',
    expect: expect_,
    value,
  });
  const apply = async (cs) => {
    validateSchemaAndSafety(cs);
    const { resolved, mismatches, fileCache } = await resolve(cs, null, { repoRoot: root });
    assert.deepEqual(mismatches, []);
    await applyFileOps(resolved, fileCache, { repoRoot: root, at: cs.createdAt });
  };

  // OFF. Nothing in the changeset names `since`; the pipeline moves it.
  await apply(changeset([flip(true, false)], { createdAt: '2026-09-05T11:00:00.000Z' }));
  let roster = await readBack();
  assert.equal(roster.assets['meals.example'].enabled, false);
  assert.equal(roster.assets['meals.example'].since, '2026-09-05');
  // The rest of the row is the operator's and is left alone.
  assert.equal(roster.assets['meals.example'].note, SIGNAL_PANELS.assets['meals.example'].note);

  // BACK ON — the undo's own op, and the same rule. The row dates the decision
  // standing in it now, which is the one taken on the day of the undo.
  await apply(changeset([flip(false, true)], { createdAt: '2026-09-08T11:00:00.000Z' }));
  roster = await readBack();
  assert.equal(roster.assets['meals.example'].enabled, true);
  assert.equal(roster.assets['meals.example'].since, '2026-09-08');
});

test('a roster write that decides nothing new moves no date', async () => {
  const root = await tempRepo({ 'config/signal-panels.json': DATED_SIGNAL_PANELS });
  const readBack = async () =>
    JSON.parse(await fs.readFile(path.join(root, 'installation/signal-panels.json'), 'utf8'));

  // Editing the TASK is not the decision, so the day the decision was taken
  // stands. (The file's own `updated` still moves: that IS a change to the
  // file.)
  const cs = changeset(
    [
      {
        kind: 'file-json-set',
        file: 'config/signal-panels.json',
        pointer: '/assets/meals.example/task',
        expect: SIGNAL_PANELS.assets['meals.example'].task,
        value: 'ex-12.7',
      },
    ],
    { createdAt: '2026-09-09T11:00:00.000Z' },
  );
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, fileCache } = await resolve(cs, null, { repoRoot: root });
  assert.deepEqual(mismatches, []);
  await applyFileOps(resolved, fileCache, { repoRoot: root, at: cs.createdAt });

  const roster = await readBack();
  assert.equal(roster.assets['meals.example'].since, '2026-08-03');
  assert.equal(roster.updated, '2026-09-09');
});

// A data source's posture is dated the same way.
//
// `asset-lane` is the roster register's sibling: `since` means "when this
// posture was recorded", and the Sources tab writes `status` and `note` as two
// cells with no date field at all. One declared `stamps` pair, the same
// mechanism, both files.
const POSTURED_INTEGRATIONS = {
  ...INTEGRATIONS,
  assets: {
    'meals.example': {
      gsc: { status: 'live', note: 'GSC pull live since the property was verified.', since: '2026-08-03' },
    },
  },
};

test("changing a data source's posture dates the cell; changing its reason does not", async () => {
  const root = await tempRepo({ 'config/integrations.json': POSTURED_INTEGRATIONS });
  const readBack = async () =>
    JSON.parse(await fs.readFile(path.join(root, 'installation/integrations.json'), 'utf8'));
  const apply = async (cs) => {
    validateSchemaAndSafety(cs);
    const { resolved, mismatches, fileCache } = await resolve(cs, null, { repoRoot: root });
    assert.deepEqual(mismatches, []);
    await applyFileOps(resolved, fileCache, { repoRoot: root, at: cs.createdAt });
  };
  const cell = (field, expect_, value) => ({
    kind: 'file-json-set',
    file: 'config/integrations.json',
    pointer: `/assets/meals.example/gsc/${field}`,
    expect: expect_,
    value,
  });

  // Declining the source is a new posture: the pipeline dates it, nothing in
  // the changeset names `since`.
  await apply(changeset([cell('status', 'live', 'skipped')], { createdAt: '2026-09-05T11:00:00.000Z' }));
  let lane = (await readBack()).assets['meals.example'].gsc;
  assert.equal(lane.status, 'skipped');
  assert.equal(lane.since, '2026-09-05');
  assert.equal(lane.note, POSTURED_INTEGRATIONS.assets['meals.example'].gsc.note);

  // Rewording the reason is not a decision, so the day the posture was taken
  // stands.
  await apply(
    changeset(
      [cell('note', POSTURED_INTEGRATIONS.assets['meals.example'].gsc.note, 'Declined: the property was sold on 2026-09-04.')],
      { createdAt: '2026-09-09T11:00:00.000Z' },
    ),
  );
  lane = (await readBack()).assets['meals.example'].gsc;
  assert.equal(lane.status, 'skipped');
  assert.equal(lane.since, '2026-09-05');
});

test('an asset filed into the roster keeps the date its author gave it', async () => {
  // An INSERT is a new row, not a decision that moved: the wizard writes the
  // asset's own `since` and the stamp must not overwrite it with a second
  // reading of the same clock.
  const root = await tempRepo({ 'config/signal-panels.json': DATED_SIGNAL_PANELS });
  const row = { enabled: false, reason: 'no-lane-yet', since: '2026-09-01' };
  const cs = changeset([insertOp({ file: 'config/signal-panels.json', value: row })], {
    createdAt: '2026-09-05T11:00:00.000Z',
  });
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, fileCache } = await resolve(cs, null, { repoRoot: root });
  assert.deepEqual(mismatches, []);
  await applyFileOps(resolved, fileCache, { repoRoot: root, at: cs.createdAt });

  const roster = JSON.parse(
    await fs.readFile(path.join(root, 'installation/signal-panels.json'), 'utf8'),
  );
  assert.deepEqual(roster.assets['brandnew.test'], row);
});

test('a panel delete whose expect has moved is refused rather than applied', async () => {
  const root = await tempRepo({ 'config/serp-panel.json': SERP_PANEL });
  const cs = changeset([
    deleteOp({
      file: 'config/serp-panel.json',
      pointer: '/assets/meals.example',
      // A panel somebody grew since this was read.
      expect: { queries: ['meals'] },
    }),
  ]);
  const { mismatches } = await resolve(cs, null, { repoRoot: root });
  assert.equal(mismatches.length, 1);
  assert.deepEqual(mismatches[0].current, SERP_PANEL.assets['meals.example']);
});

test('display_name is a store column now, bounded at 80 characters', () => {
  const rename = (value) => ({
    kind: 'store-asset-set',
    asset: 'meals.example',
    column: 'display_name',
    expect: 'Meal Planner',
    value,
  });
  validateSchemaAndSafety(changeset([rename('My Plate')]));
  assert.throws(() => validateSchemaAndSafety(changeset([rename('  ')])), /1–80 characters/);
  assert.throws(
    () => validateSchemaAndSafety(changeset([rename('x'.repeat(81))])),
    /1–80 characters/,
  );
  assert.throws(() => validateSchemaAndSafety(changeset([rename(7)])), /1–80 characters/);
});

// The DECLARED registers. Every list-shaped config register has a container,
// a key and per-field rules in `config-registers.mjs`, and this module derives
// its allowlists and its refusals from them. What follows is one pass per
// register file: an insert, a set INSIDE a row, a delete, and the refusals that
// stand between a wrong row and a config file.

const DOMAIN_COSTS = {
  domains: [
    { domain: 'fees.example', asset: 'fees.example', kind: 'registration', paidUsd: 36.32, paidOn: '2026-06-28' },
    { domain: 'nosh.example', asset: 'nosh.example', kind: 'registration', paidUsd: 109.69, paidOn: '2026-06-19' },
  ],
};
const RECURRING_COSTS = {
  costs: [
    {
      id: 'claude-code',
      label: 'Claude Code (Max)',
      asset: 'root-os',
      family: 'inference',
      amountUsdPerMonth: 200,
      from: '2026-06',
    },
  ],
};
const VALUE_EVENTS = { assets: { 'meals.example': { valueEvents: ['sign_up', 'auth_complete'] } } };
// `SIGNAL_PANELS` and `SERP_PANEL` are declared at the top of this file: they
// are the same two files a whole-asset add/remove touches, and the same two an
// operator edits row by row.
const BEADS = {
  hub: { host: '127.0.0.1' },
  spokes: [{ asset: 'root-os', prefix: 'ro', database: 'ro', repo: '.' }],
};

test('a declared register takes an insert, a set inside a row, and a delete', async () => {
  const root = await tempRepo({
    'config/domain-costs.json': DOMAIN_COSTS,
    'config/recurring-costs.json': RECURRING_COSTS,
  });
  const readBack = async (rel) => JSON.parse(await fs.readFile(path.join(root, rel.replace(/^config\//, 'installation/')), 'utf8'));

  const cs = changeset([
    {
      kind: 'file-json-insert',
      file: 'config/domain-costs.json',
      pointer: '/domains/-',
      value: {
        domain: 'teller.example',
        asset: 'fees.example',
        kind: 'registration',
        paidUsd: 6.69,
        paidOn: '2026-06-28',
      },
    },
    {
      kind: 'file-json-set',
      file: 'config/domain-costs.json',
      pointer: '/domains/0/paidUsd',
      expect: 36.32,
      value: 40,
    },
    {
      kind: 'file-json-set',
      file: 'config/recurring-costs.json',
      // The label, not the amount: the amount is fixed once added, and a price
      // change is a new row.
      pointer: '/costs/0/label',
      expect: 'Claude Code (Max)',
      value: 'Claude Max',
    },
  ]);
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, fileCache } = await resolve(cs, null, { repoRoot: root });
  assert.deepEqual(mismatches, []);
  await applyFileOps(resolved, fileCache, { repoRoot: root });

  const domains = (await readBack('config/domain-costs.json')).domains;
  assert.equal(domains.length, 3);
  assert.equal(domains[2].domain, 'teller.example');
  assert.equal(domains[0].paidUsd, 40);
  assert.equal((await readBack('config/recurring-costs.json')).costs[0].label, 'Claude Max');

  const remove = changeset([
    {
      kind: 'file-json-delete',
      file: 'config/domain-costs.json',
      pointer: '/domains/1',
      expect: DOMAIN_COSTS.domains[1],
    },
  ]);
  validateSchemaAndSafety(remove);
  const gone = await resolve(remove, null, { repoRoot: root });
  assert.deepEqual(gone.mismatches, []);
  await applyFileOps(gone.resolved, gone.fileCache, { repoRoot: root });
  assert.deepEqual(
    (await readBack('config/domain-costs.json')).domains.map((d) => d.domain),
    ['fees.example', 'teller.example'],
  );
});

// Undoing a removal puts the row back where it was.
//
// A delete SPLICES, so an insert that could only append would return the row
// at the end of the list, visible wherever a table is drawn in file order. An
// indexed insert is RFC 6902's `add` for an array, and it is what makes the
// Undo in the toast an undo.
test('an array insert may name a position, and puts a removed row back in it', async () => {
  const root = await tempRepo({ 'config/domain-costs.json': DOMAIN_COSTS });
  const readBack = async () =>
    (JSON.parse(await fs.readFile(path.join(root, 'installation/domain-costs.json'), 'utf8'))).domains;

  const removed = DOMAIN_COSTS.domains[0];
  const out = changeset([
    { kind: 'file-json-delete', file: 'config/domain-costs.json', pointer: '/domains/0', expect: removed },
  ]);
  validateSchemaAndSafety(out);
  const gone = await resolve(out, null, { repoRoot: root });
  assert.deepEqual(gone.mismatches, []);
  await applyFileOps(gone.resolved, gone.fileCache, { repoRoot: root });
  assert.deepEqual((await readBack()).map((d) => d.domain), ['nosh.example']);

  // The undo names the index the row was spliced out of.
  const back = changeset([
    { kind: 'file-json-insert', file: 'config/domain-costs.json', pointer: '/domains/0', value: removed },
  ]);
  validateSchemaAndSafety(back);
  const restored = await resolve(back, null, { repoRoot: root });
  assert.deepEqual(restored.mismatches, [], 'an indexed insert asks about a POSITION, not absence');
  await applyFileOps(restored.resolved, restored.fileCache, { repoRoot: root });
  assert.deepEqual((await readBack()).map((d) => d.domain), ['fees.example', 'nosh.example']);

  // Past the end is a claim about a list that has moved — refused, loudly,
  // rather than quietly appended as if the pointer had said "-".
  await assert.rejects(
    () =>
      resolve(
        changeset([
          { kind: 'file-json-insert', file: 'config/domain-costs.json', pointer: '/domains/7', value: removed },
        ]),
        null,
        { repoRoot: root },
      ),
    /nothing to insert before — \/domains holds 2 entries/,
  );
});

// A join key is set when the row is created and not renamed.
//
// The Tower renders such a field as text rather than a control, but a UI-only
// rule is a suggestion: this is the door a hand-written rename changeset comes
// through, and it is refused here too. A rename needs matching edits in files
// (and collectors) this pipeline cannot make, so the way to change one is to
// remove the row and record the new one.
test('a read-only field is refused a rename, at its own pointer and inside a whole row', () => {
  const renameField = {
    kind: 'file-json-set',
    file: 'config/recurring-costs.json',
    pointer: '/costs/0/id',
    expect: 'claude-code',
    value: 'claude-max',
  };
  assert.throws(
    () => validateSchemaAndSafety(changeset([renameField])),
    /id is set when a row is created and not changed afterwards/,
  );
  // The catalog's join key and a domain order's name answer the same way.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-set',
            file: 'config/integrations.json',
            pointer: '/catalog/0/id',
            expect: 'ga4',
            value: 'ga-4',
          },
        ]),
      ),
    /id is set when a row is created/,
  );
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-set',
            file: 'config/domain-costs.json',
            pointer: '/domains/0/domain',
            expect: 'fees.example',
            value: 'fin.dev',
          },
        ]),
      ),
    /domain is set when a row is created/,
  );

  // Its NEIGHBOURS are untouched — the rule is one field, not one row.
  validateSchemaAndSafety(
    changeset([
      {
        kind: 'file-json-set',
        file: 'config/recurring-costs.json',
        pointer: '/costs/0/label',
        expect: 'Claude Code (Max)',
        value: 'Claude Max',
      },
    ]),
  );

  // A whole ROW is replaced for two honest reasons — a scalar row, and clearing
  // an optional field — and a read-only value riding along unchanged is fine.
  const row = RECURRING_COSTS.costs[0];
  validateSchemaAndSafety(
    changeset([
      {
        kind: 'file-json-set',
        file: 'config/recurring-costs.json',
        pointer: '/costs/0',
        expect: row,
        value: { ...row, note: 'the annual plan' },
      },
    ]),
  );
  // A value that MOVED is the same rename by another pointer.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-set',
            file: 'config/recurring-costs.json',
            pointer: '/costs/0',
            expect: row,
            value: { ...row, id: 'claude-max' },
          },
        ]),
      ),
    /id is set when a row is created/,
  );

  // CREATING is untouched: a new row must set its own key.
  validateSchemaAndSafety(
    changeset([
      {
        kind: 'file-json-insert',
        file: 'config/recurring-costs.json',
        pointer: '/costs/-',
        value: {
          id: 'chatgpt',
          label: 'ChatGPT Team',
          asset: 'root-os',
          family: 'inference',
          amountUsdPerMonth: 60,
          from: '2026-09',
        },
      },
    ]),
  );
});

// An `asset-id` field has to name an asset that exists, or a recurring cost
// can be booked against an asset no row in `assets` has: money that silently
// leaves the by-asset split while the total goes on including it. The
// candidates are `config/integrations.json` `/assets`, the config-side roster
// every asset is filed into on Create; the store is deliberately out of reach
// here, because `pnpm config:apply` shares this module and may not open it.
test('a row naming an asset the roster does not have is refused, by both entry points', async () => {
  const root = await tempRepo({
    'config/integrations.json': INTEGRATIONS,
    'config/recurring-costs.json': RECURRING_COSTS,
    'config/domain-costs.json': DOMAIN_COSTS,
  });
  const cost = (asset) => ({
    kind: 'file-json-insert',
    file: 'config/recurring-costs.json',
    pointer: '/costs/-',
    value: {
      id: 'chatgpt',
      label: 'ChatGPT Team',
      asset,
      family: 'inference',
      amountUsdPerMonth: 60,
      from: '2026-09',
    },
  });

  // The shape check passes it — which is exactly the hole.
  validateSchemaAndSafety(changeset([cost('meals.fod')]));
  await assert.rejects(
    () => resolve(changeset([cost('meals.fod')]), null, { repoRoot: root }),
    /asset "meals\.fod" is not one of meals\.example/,
  );

  // An asset the roster HAS goes through untouched.
  const ok = await resolve(changeset([cost('meals.example')]), null, { repoRoot: root });
  assert.deepEqual(ok.mismatches, []);

  // A field set is checked the same way, at the field's own pointer.
  await assert.rejects(
    () =>
      resolve(
        changeset([
          {
            kind: 'file-json-set',
            file: 'config/domain-costs.json',
            pointer: '/domains/0/asset',
            expect: 'fees.example',
            value: 'fin.code',
          },
        ]),
        null,
        { repoRoot: root },
      ),
    /asset "fin\.code" is not one of/,
  );
});

// A repo with no roster refuses nothing. "Nobody answered" is not "nothing is
// allowed": the same reading the browser gives an empty picker, and what keeps
// a throwaway root (and an early checkout) applying its changesets.
test('an absent roster file leaves the asset check silent rather than refusing everything', async () => {
  const root = await tempRepo({ 'config/recurring-costs.json': RECURRING_COSTS });
  const cs = changeset([
    {
      kind: 'file-json-insert',
      file: 'config/recurring-costs.json',
      pointer: '/costs/-',
      value: {
        id: 'chatgpt',
        label: 'ChatGPT Team',
        asset: 'nobody.example',
        family: 'inference',
        amountUsdPerMonth: 60,
        from: '2026-09',
      },
    },
  ]);
  const { mismatches } = await resolve(cs, null, { repoRoot: root });
  assert.deepEqual(mismatches, []);
});

test('a set inside a declared row is checked against the FIELD, by name and rule', () => {
  const set = (pointer, value, expect = null) => ({
    kind: 'file-json-set',
    file: 'config/domain-costs.json',
    pointer,
    expect,
    value,
  });
  validateSchemaAndSafety(changeset([set('/domains/0/paidUsd', 12.5)]));
  assert.throws(
    () => validateSchemaAndSafety(changeset([set('/domains/0/paidUsd', 'twelve')])),
    // The pointer names the key for whoever reads the file; the sentence
    // names the field by its label, as the Tower shows it.
    /\/domains\/0\/paidUsd — Paid \(USD\) must be a number$/,
  );
  assert.throws(
    () => validateSchemaAndSafety(changeset([set('/domains/0/paidUsd', -1)])),
    /Paid \(USD\) must be at least 0$/,
  );
  assert.throws(() => validateSchemaAndSafety(changeset([set('/domains/0/kind', 'gift')])), /Order must be one of/);
  assert.throws(
    () => validateSchemaAndSafety(changeset([set('/domains/0/paidOn', '2026-02-30')])),
    /Paid on must be a date/,
  );
  // A field nobody declared is refused by NAME, and the refusal lists the ones
  // that exist — this file is not on the wholesale allowlist, so nothing else
  // licenses the write.
  assert.throws(
    () => validateSchemaAndSafety(changeset([set('/domains/0/currency', 'USD')])),
    /not a declared field in config\/domain-costs\.json/,
  );
  assert.throws(
    () => validateSchemaAndSafety(changeset([set('/notAContainer/0/paidUsd', 1)])),
    /is not editable/,
  );
});

test('the wholesale four keep their freedom, and gain field checks where a register overlaps', () => {
  const set = (file, pointer, value) => ({ kind: 'file-json-set', file, pointer, expect: null, value });
  // integrations.json is BOTH wholesale-settable and the home of the catalog
  // register: a lane status is unvalidated, and an undeclared key elsewhere in
  // the file still passes on the file's own permission rather than being newly
  // refused. A catalog field is the product's own definition: every one is
  // fixed, so a set is refused.
  validateSchemaAndSafety(changeset([set('config/integrations.json', '/assets/meals.example/gsc/status', 'live')]));
  validateSchemaAndSafety(changeset([set('config/integrations.json', '/states/0/anything', 1)]));
  for (const [pointer, value] of [['/catalog/0/label', 'Search Console'], ['/catalog/0/layer', 'os'], ['/catalog/0/docRef', 'docs/x.md']]) {
    assert.throws(
      () => validateSchemaAndSafety(changeset([set('config/integrations.json', pointer, value)])),
      /is set when a row is created and not changed afterwards/,
      pointer,
    );
  }
});

// A product update still reaches an installation: a new data source arrives as
// one catalog row inserted, and that row is checked against the declaration
// like any other insert.
test('a new data source still arrives as a checked catalog row', () => {
  const row = { id: 'example-source', label: 'Example source', scope: 'property', layer: 'provider', credential: 'shared', docRef: 'docs/11-integrations.md' };
  const insert = (value) => ({ kind: 'file-json-insert', file: 'config/integrations.json', pointer: '/catalog/-', value });
  validateSchemaAndSafety(changeset([insert(row)]));
  assert.throws(
    () => validateSchemaAndSafety(changeset([insert({ ...row, layer: 'nowhere' })])),
    /Layer must be one of/,
  );
  assert.throws(
    () => validateSchemaAndSafety(changeset([insert({ ...row, liveMeans: 'a paragraph' })])),
    /liveMeans is not a field here/,
  );
});

test('a per-asset register carries the asset in its container', async () => {
  const root = await tempRepo({
    'config/value-events.json': VALUE_EVENTS,
    'config/serp-panel.json': SERP_PANEL,
  });
  const readBack = async (rel) => JSON.parse(await fs.readFile(path.join(root, rel.replace(/^config\//, 'installation/')), 'utf8'));

  const cs = changeset([
    {
      kind: 'file-json-insert',
      file: 'config/value-events.json',
      pointer: '/assets/meals.example/valueEvents/-',
      value: 'plan_save_click',
    },
    {
      kind: 'file-json-set',
      file: 'config/serp-panel.json',
      pointer: '/assets/meals.example/queries/1',
      expect: 'meals calculator',
      value: { query: 'meals calculator', label: 'Calculator seam' },
    },
  ]);
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, fileCache } = await resolve(cs, null, { repoRoot: root });
  assert.deepEqual(mismatches, []);
  await applyFileOps(resolved, fileCache, { repoRoot: root });

  assert.deepEqual((await readBack('config/value-events.json')).assets['meals.example'].valueEvents, [
    'sign_up',
    'auth_complete',
    'plan_save_click',
  ]);
  // A bare tracked query gaining its cluster is one value replacing another at
  // the row's own pointer — the mixed shape the panel README sanctions.
  assert.deepEqual((await readBack('config/serp-panel.json')).assets['meals.example'].queries[1], {
    query: 'meals calculator',
    label: 'Calculator seam',
  });

  // A GA4 event name is checked as the emitter writes it.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-insert',
            file: 'config/value-events.json',
            pointer: '/assets/meals.example/valueEvents/-',
            value: 'Calculation Complete',
          },
        ]),
      ),
    { message: 'op #1: GA4 event: verbatim as the site emits it (calculation_complete, never "Calculation complete")' },
  );
  // An asset the file has no entry for is FILED first, through the holder
  // register beside the list — a pointer never creates structure.
  validateSchemaAndSafety(
    changeset([
      {
        kind: 'file-json-insert',
        file: 'config/value-events.json',
        pointer: '/assets/nosh.example',
        value: { valueEvents: [] },
      },
    ]),
  );

  // And that is how the Tower declares an asset's FIRST value event: one insert
  // carrying the whole entry, applied here end to end so the surface's op and
  // the lane's answer cannot drift apart.
  const seed = changeset([
    {
      kind: 'file-json-insert',
      file: 'config/value-events.json',
      pointer: '/assets/nosh.example',
      value: { valueEvents: ['calculation_complete'] },
    },
  ]);
  validateSchemaAndSafety(seed);
  const seeded = await resolve(seed, null, { repoRoot: root });
  assert.deepEqual(seeded.mismatches, []);
  await applyFileOps(seeded.resolved, seeded.fileCache, { repoRoot: root });
  assert.deepEqual((await readBack('config/value-events.json')).assets['nosh.example'], {
    valueEvents: ['calculation_complete'],
  });

  // Its exact inverse — what the Undo in the toast sends.
  const undo = changeset([
    {
      kind: 'file-json-delete',
      file: 'config/value-events.json',
      pointer: '/assets/nosh.example',
      expect: { valueEvents: ['calculation_complete'] },
    },
  ]);
  validateSchemaAndSafety(undo);
  const reverted = await resolve(undo, null, { repoRoot: root });
  assert.deepEqual(reverted.mismatches, []);
  await applyFileOps(reverted.resolved, reverted.fileCache, { repoRoot: root });
  assert.equal((await readBack('config/value-events.json')).assets['nosh.example'], undefined);
});

test('an object register keyed by asset id takes rows and field sets', async () => {
  const root = await tempRepo({ 'config/signal-panels.json': SIGNAL_PANELS });
  const readBack = async () =>
    JSON.parse(await fs.readFile(path.join(root, 'installation/signal-panels.json'), 'utf8'));

  const cs = changeset([
    {
      kind: 'file-json-insert',
      file: 'config/signal-panels.json',
      pointer: '/assets/nosh.example',
      value: { enabled: false, reason: 'no-lane-yet' },
    },
    {
      kind: 'file-json-set',
      file: 'config/signal-panels.json',
      pointer: '/assets/meals.example/enabled',
      expect: true,
      value: false,
    },
  ]);
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, fileCache } = await resolve(cs, null, { repoRoot: root });
  assert.deepEqual(mismatches, []);
  await applyFileOps(resolved, fileCache, { repoRoot: root });

  const doc = await readBack();
  assert.deepEqual(doc.assets['nosh.example'], { enabled: false, reason: 'no-lane-yet' });
  assert.equal(doc.assets['meals.example'].enabled, false);

  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-insert',
            file: 'config/signal-panels.json',
            pointer: '/assets/nosh.example',
            value: { enabled: true },
          },
        ]),
      ),
    /Reason is required/,
  );
});

// One cluster, one spelling: the rule config/serp-panel's README states and the
// collector enforces, applied where the row is written instead of a week later.
// Grouping is an exact string match on the stored label, so relabelling one row
// of a cluster into a case variant makes two bets out of one and fails that
// asset's WHOLE panel on the next run.
test('a tracked query may not be relabelled into a second spelling of one cluster', async () => {
  const root = await tempRepo({
    'config/serp-panel.json': {
      assets: {
        'meals.example': {
          queries: [
            'big mac calories',
            { query: 'whopper calories', label: 'Item head' },
            { query: 'mcchicken calories', label: 'Item head' },
          ],
        },
      },
    },
  });
  const relabel = (index, value, expect) => ({
    kind: 'file-json-set',
    file: 'config/serp-panel.json',
    pointer: `/assets/meals.example/queries/${index}/label`,
    expect,
    value,
  });

  await assert.rejects(
    () => resolve(changeset([relabel(2, 'Item Head', 'Item head')]), null, { repoRoot: root }),
    /spells one cluster two ways: "Item head" and "Item Head"/,
  );
  // An APPEND carrying the variant is the same mistake at the other door.
  await assert.rejects(
    () =>
      resolve(
        changeset([
          {
            kind: 'file-json-insert',
            file: 'config/serp-panel.json',
            pointer: '/assets/meals.example/queries/-',
            value: { query: 'quarter pounder calories', label: 'ITEM HEAD' },
          },
        ]),
        null,
        { repoRoot: root },
      ),
    /spells one cluster two ways/,
  );

  // Moving a term to a genuinely different bet is a legitimate edit — the
  // collector has no opinion about it, and neither does this.
  const moved = await resolve(
    changeset([relabel(2, 'Chain compare', 'Item head')]),
    null,
    { repoRoot: root },
  );
  assert.deepEqual(moved.mismatches, []);
  // And joining the cluster with its exact spelling is the point of the field.
  const joined = await resolve(
    changeset([
      {
        kind: 'file-json-set',
        file: 'config/serp-panel.json',
        pointer: '/assets/meals.example/queries/0',
        expect: 'big mac calories',
        value: { query: 'big mac calories', label: 'Item head' },
      },
    ]),
    null,
    { repoRoot: root },
  );
  assert.deepEqual(joined.mismatches, []);
});

// Turning a roster row on is a claim about another file.
//
// config/signal-panels.README.md states the rule and its own validation snippet
// fails a roster with this sentence; the register declares
// `requiresLiveSearchLane`, and the pipeline reads the lanes out of the file the
// snippet reads. A refresh pass over an asset with no live lane writes an EMPTY
// panel dir, indistinguishable on disk from a collapsed one.
test('a roster row is only enabled when integrations.json shows a live search lane', async () => {
  const root = await tempRepo({
    'config/signal-panels.json': SIGNAL_PANELS,
    'config/integrations.json': {
      ...INTEGRATIONS,
      assets: {
        'meals.example': { gsc: { status: 'live' } },
        'nosh.example': { gsc: { status: 'needs-setup' }, ga4: { status: 'needs-setup' } },
      },
    },
  });
  const enable = (asset, expect) => ({
    kind: 'file-json-set',
    file: 'config/signal-panels.json',
    pointer: `/assets/${asset}/enabled`,
    expect,
    value: true,
  });

  // nosh.example has lanes, and none of them is a live search lane.
  await assert.rejects(
    () => resolve(changeset([enable('nosh.example', false)]), null, { repoRoot: root }),
    /enabled but no live search source in integrations\.json/,
  );
  // The same refusal for a whole ROW arriving with `enabled: true` — the shape
  // the add-asset wizard's repair of a missing roster row would take.
  await assert.rejects(
    () =>
      resolve(
        changeset([
          {
            kind: 'file-json-insert',
            file: 'config/signal-panels.json',
            pointer: '/assets/nosh.example',
            value: { enabled: true, reason: 'live-lanes', since: '2026-09-05' },
          },
        ]),
        null,
        { repoRoot: root },
      ),
    /enabled but no live search source/,
  );

  // Turning one OFF is always allowed — that is the decision the file is FOR.
  const off = await resolve(
    changeset([
      {
        kind: 'file-json-set',
        file: 'config/signal-panels.json',
        pointer: '/assets/meals.example/enabled',
        expect: true,
        value: false,
      },
    ]),
    null,
    { repoRoot: root },
  );
  assert.deepEqual(off.mismatches, []);

  // And an asset WITH a live lane goes through: the same row, the other answer.
  const on = await resolve(changeset([enable('meals.example', true)]), null, { repoRoot: root });
  assert.deepEqual(on.mismatches, []);
});

// A repo with no integrations.json cannot answer, so the rule says nothing —
// the same reading every other cross-file rule here gives an absent answer, and
// what keeps the register test above (which ships no lanes) applying its ops.
test('a roster row is left alone when nothing can answer about its lanes', async () => {
  const root = await tempRepo({ 'config/signal-panels.json': SIGNAL_PANELS });
  const { mismatches } = await resolve(
    changeset([
      {
        kind: 'file-json-set',
        file: 'config/signal-panels.json',
        pointer: '/assets/meals.example/enabled',
        expect: true,
        value: true,
      },
    ]),
    null,
    { repoRoot: root },
  );
  assert.deepEqual(mismatches, []);
});

test('the task-hub spokes are a register, and the hub itself is not', async () => {
  const root = await tempRepo({ 'config/beads.json': BEADS });
  const spoke = { asset: 'nosh.example', prefix: 'nom', database: 'nom', repo: '../nom' };
  const cs = changeset([
    { kind: 'file-json-insert', file: 'config/beads.json', pointer: '/spokes/-', value: spoke },
  ]);
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, fileCache } = await resolve(cs, null, { repoRoot: root });
  assert.deepEqual(mismatches, []);
  await applyFileOps(resolved, fileCache, { repoRoot: root });
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, 'installation/beads.json'), 'utf8')).spokes[1],
    spoke,
  );
  // The hub's own connection details are NOT a register, and beads.json is not
  // on the wholesale allowlist: nothing may write them from a browser.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-set',
            file: 'config/beads.json',
            pointer: '/hub/host',
            expect: '127.0.0.1',
            value: '0.0.0.0',
          },
        ]),
      ),
    /is not editable/,
  );
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-insert',
            file: 'config/beads.json',
            pointer: '/spokes/-',
            value: { asset: 'x.test', prefix: 'TOOLOUD', database: 'x', repo: '.' },
          },
        ]),
      ),
    { message: 'op #1: Task prefix: 2–8 lowercase letters, e.g. demo' },
  );
});

test('one spliced array entry per changeset is per CONTAINER, not per file', () => {
  const remove = (pointer, expect) => ({
    kind: 'file-json-delete',
    file: 'config/serp-panel.json',
    pointer,
    expect,
  });
  // Two removals from the SAME list renumber each other.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          remove('/assets/meals.example/queries/0', 'meals'),
          remove('/assets/meals.example/queries/1', 'meals calculator'),
        ]),
      ),
    /only one entry may be spliced in or out per changeset/,
  );
  // Two assets' lists are two different arrays, and do not.
  validateSchemaAndSafety(
    changeset([
      remove('/assets/meals.example/queries/0', 'my plate'),
      remove('/assets/nosh.example/queries/0', { query: 'big mac calories', label: 'Item head' }),
    ]),
  );
});

test('one declared DOCUMENT may appear in a wholesale-editable file, and nothing else may', () => {
  assert.deepEqual(
    [...ADDABLE_DOCUMENTS.entries()],
    [['config/tower.json', ['/wall', '/countdown']], ['config/constants.json', ['/schedules', '/no_nightly_report']]],
  );

  // The Wall's saved composition is a key config/tower.json does not have until
  // the operator arranges one: a set cannot create it, and no register is
  // shaped like it, so it is declared on its own.
  const wall = { layout: DRAWABLE_WALL, history: [] };
  validateSchemaAndSafety(
    changeset([
      { kind: 'file-json-insert', file: 'config/tower.json', pointer: '/wall', value: wall },
    ]),
  );
  validateSchemaAndSafety(
    changeset([
      { kind: 'file-json-delete', file: 'config/tower.json', pointer: '/wall', expect: wall },
    ]),
  );

  // The countdown is the same shape: optional, one whole block at one pointer,
  // and unmakeable from the product until it could be inserted, since a set
  // never creates a key. The three move together because they are one landmark.
  const countdown = { emoji: '🌁', label: 'SF MOVE', targetAt: '2026-11-16T08:00:00.000Z' };
  validateSchemaAndSafety(
    changeset([
      { kind: 'file-json-insert', file: 'config/tower.json', pointer: '/countdown', value: countdown },
    ]),
  );
  validateSchemaAndSafety(
    changeset([
      { kind: 'file-json-delete', file: 'config/tower.json', pointer: '/countdown', expect: countdown },
    ]),
  );
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          { kind: 'file-json-insert', file: 'config/tower.json', pointer: '/countdown/emoji', value: '🌁' },
        ]),
      ),
    /may not touch/,
  );

  // Exactly that pointer. Nothing under it, and no second key alongside it.
  for (const pointer of ['/wall/layout', '/countdown/label', '/wall/history/0', '/readme']) {
    assert.throws(
      () =>
        validateSchemaAndSafety(
          changeset([
            { kind: 'file-json-insert', file: 'config/tower.json', pointer, value: {} },
          ]),
        ),
      /may not touch/,
      pointer,
    );
  }

  // The guards are the ones every other insert and delete carries.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-insert',
            file: 'config/tower.json',
            pointer: '/wall',
            value: wall,
            expect: null,
          },
        ]),
      ),
    /takes no "expect"/,
  );
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          { kind: 'file-json-delete', file: 'config/tower.json', pointer: '/wall' },
        ]),
      ),
    /missing "expect"/,
  );
});

test('an undrawable /wall is refused here, in the words the editor prints', () => {
  // The layout contract's runtime lives in scripts/wall-layout.mjs, which this
  // pipeline imports, so every door refuses in the same sentence.
  const undrawable = { layout: { version: 1, rows: [] }, history: [] };

  // Inserting the whole landmark, which is how a first layout arrives.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          { kind: 'file-json-insert', file: 'config/tower.json', pointer: '/wall', value: undrawable },
        ]),
      ),
    /A layout needs at least one row\./,
  );

  // Setting it, which is how every later Save arrives.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-set',
            file: 'config/tower.json',
            pointer: '/wall',
            expect: null,
            value: undrawable,
          },
        ]),
      ),
    /A layout needs at least one row\./,
  );

  // The history is checked too: a version nobody can draw is a Revert that
  // would break the Wall the moment it is chosen.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-set',
            file: 'config/tower.json',
            pointer: '/wall',
            expect: null,
            value: {
              layout: DRAWABLE_WALL,
              history: [{ savedAt: '2026-09-05T12:00:00.000Z', reason: 'why', layout: { version: 1, rows: [] } }],
            },
          },
        ]),
      ),
    /wall\.history\[0\]\.layout: A layout needs at least one row\./,
  );

  // A PIECE of a layout is refused whatever it says, because a row or a width
  // lifted out of its document cannot be judged on its own.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-set',
            file: 'config/tower.json',
            pointer: '/wall/layout/rows/0/widgets/0/width',
            expect: 1,
            value: 2,
          },
        ]),
      ),
    /saved whole/,
  );

  // A drawable one passes, at both pointers the contract accepts.
  validateSchemaAndSafety(
    changeset([
      {
        kind: 'file-json-set',
        file: 'config/tower.json',
        pointer: '/wall',
        expect: null,
        value: { layout: DRAWABLE_WALL, history: [] },
      },
    ]),
  );
  validateSchemaAndSafety(
    changeset([
      {
        kind: 'file-json-set',
        file: 'config/tower.json',
        pointer: '/wall/layout',
        expect: null,
        value: DRAWABLE_WALL,
      },
    ]),
  );

  // A delete carries the layout being REMOVED; the Wall falls back to the
  // default composition, which it can always draw.
  validateSchemaAndSafety(
    changeset([
      { kind: 'file-json-delete', file: 'config/tower.json', pointer: '/wall', expect: undrawable },
    ]),
  );
});

test('a column is judged at this door too: one level deep, never empty', () => {
  // The column slot (docs/14-design.md § Regions) is part of the one rule,
  // so config:apply and the ingest's applyConfigOps — both through
  // validateSchemaAndSafety — refuse a layout the Wall cannot draw in the
  // same words the editor prints.
  const withColumn = (rows) => ({
    version: 1,
    rows: [
      {
        id: 'body',
        height: 'fill',
        widgets: [
          { id: 'column', type: 'column', width: 3.1, rows },
          { id: 'feed', type: 'feed', width: 1 },
        ],
      },
    ],
  });
  const saving = (layout) =>
    changeset([
      { kind: 'file-json-set', file: 'config/tower.json', pointer: '/wall', expect: null, value: { layout, history: [] } },
    ]);
  const nested = withColumn([
    {
      id: 'inner',
      height: 'auto',
      widgets: [{ id: 'deeper', type: 'column', width: 1, rows: [{ id: 'x', height: 'auto', widgets: [{ id: 'strip', type: 'strip', width: 1 }] }] }],
    },
  ]);
  assert.throws(() => validateSchemaAndSafety(saving(nested)), /A column cannot hold another column\./);
  assert.throws(() => validateSchemaAndSafety(saving(withColumn([]))), /Row 1, column 1 needs at least one row\./);
  // A drawable column passes.
  validateSchemaAndSafety(
    saving(withColumn([{ id: 'sites', height: 'fill', widgets: [{ id: 'sites', type: 'sites', width: 1 }] }])),
  );
});

test('a layout saved with a retired widget type is taken back whole, never as a piece, and the read-side marker is never written', () => {
  // Seven widget types are retired. A whole `/wall` naming one still reads (as
  // the default), so an Undo that puts one back is not refused; a fresh
  // `/wall/layout` naming one is, and `retired` is what a READ says about the
  // store: written into it, every later read would believe it.
  const old = { version: 1, rows: [{ id: 'assets', height: 'fill', widgets: [{ id: 'assets', type: 'assets', width: 1 }] }] };
  validateSchemaAndSafety(
    changeset([{ kind: 'file-json-set', file: 'config/tower.json', pointer: '/wall', expect: null, value: { layout: old, history: [] } }]),
  );
  assert.throws(
    () => validateSchemaAndSafety(changeset([{ kind: 'file-json-set', file: 'config/tower.json', pointer: '/wall/layout', expect: null, value: old }])),
    /a widget the Wall no longer draws: "assets"/,
  );
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-set',
            file: 'config/tower.json',
            pointer: '/wall',
            expect: null,
            value: { layout: DRAWABLE_WALL, history: [], retired: { saved: null, replaced: true } },
          },
        ]),
      ),
    /set when the layout is read, never saved/,
  );
});

// A WHOLE DOCUMENT, judged by the same declarations: the Tower's build checks
// the product defaults it compiles in with this, so a malformed default fails
// the build naming the file and where. That the shipped and saved documents
// pass is scripts/config-registers.test.mjs's.
test('documentRefusal names what is wrong with a malformed document, and where', () => {
  assert.equal(documentRefusal('config/pull.json', []), null);
  assert.equal(documentRefusal('config/counters.json', { assets: {} }), null);
  const cases = [
    ['config/pull.json', { asset: 'meals.example' }, /must be a JSON array/],
    ['config/pull.json', [42], /^\/0 — /],
    ['config/counters.json', {}, /\/assets is missing/],
    ['config/counters.json', { assets: { 'meals.example': [] } }, /\/assets\/meals\.example — /],
    ['config/counters.json', { assets: { 'Not A Site': {} } }, /is not a valid key/],
    ['config/integrations.json', { catalog: {}, assets: {} }, /\/catalog must be a JSON array/],
    ['config/integrations.json', { catalog: [{ id: 'gsc' }], assets: {} }, /\/catalog\/0 — Label is required/],
    ['config/integrations.json', { catalog: [], assets: { 'meals.example': { gsc: { status: 'on' } } } }, /\/assets\/meals\.example\/gsc — Posture must be one of/],
    ['config/signal-panels.json', { assets: {}, refresh: { windowDays: 0, freshnessMaxAgeDays: 7 } }, /\/refresh\/windowDays — Panel history window must be at least 1/],
  ];
  for (const [file, doc, rule] of cases) {
    assert.match(documentRefusal(file, doc) ?? '', rule, `${file} ${JSON.stringify(doc)}`);
  }
});
