// What this suite pins is the SPLIT, not the op semantics — those are
// scripts/config-apply-core.test.mjs's, unchanged, and they still run through
// this module because the core re-exports it.
//
// Two properties are load-bearing here and nowhere else:
//
//   1. config-documents.mjs imports NOTHING from `node:`. The whole reason it
//      exists is that `workers/ingest` bundles it, and workerd has no
//      filesystem; a stray `import path from 'node:path'` would pass every test
//      in this repo and fail at `wrangler deploy`.
//   2. The pipeline runs against documents that never touched a disk, with the
//      same refusals and the same expect guard, so the ingest Worker and the
//      terminal cannot drift.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_DOCUMENT_FILES,
  ChangesetError,
  MISSING,
  applyDocumentOps,
  configDocumentFile,
  configDocumentKey,
  resolveOps,
  serializeDocument,
  validateSchemaAndSafety,
} from './config-documents.mjs';
import { CONFIG_DOCUMENT_FILES as VIA_CORE } from './config-apply-core.mjs';
import { SCHEDULED_JOBS, scheduleFor } from './scheduled-jobs.mjs';
import { DEFAULT_WALL_LAYOUT } from './wall-layout.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A `readDocument` over a plain object of file → document. Every Worker read
 * looks like this; so does every test below. */
function documentsFrom(map) {
  return async (file) => {
    if (!Object.prototype.hasOwnProperty.call(map, file)) {
      throw new Error('no such document');
    }
    return structuredClone(map[file]);
  };
}

function changeset(ops) {
  return { version: 1, slug: 'test-change', createdAt: '2026-09-04T12:00:00.000Z', ops };
}

test('config-documents.mjs imports nothing from node:', async () => {
  const source = await readFile(path.join(REPO_ROOT, 'scripts/config-documents.mjs'), 'utf8');
  const imports = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    imports.filter((spec) => spec.startsWith('node:')),
    [],
    'a node: import here would break the ingest Worker bundle, not this test run',
  );
  assert.ok(imports.includes('./config-registers.mjs'), 'the declaration map is still the source');
});

test('the seed list is derived and carries the four settable files', () => {
  assert.deepEqual([...CONFIG_DOCUMENT_FILES], [...VIA_CORE], 'the core re-exports the same list');
  for (const file of [
    'config/constants.json',
    'config/pull.json',
    'config/integrations.json',
    'config/tower.json',
    'config/counters.json',
    'config/signal-panels.json',
  ]) {
    assert.ok(CONFIG_DOCUMENT_FILES.includes(file), `${file} is a document the store holds`);
  }
  assert.deepEqual(
    [...CONFIG_DOCUMENT_FILES],
    [...new Set(CONFIG_DOCUMENT_FILES)],
    'no file is listed twice',
  );
  for (const file of CONFIG_DOCUMENT_FILES) {
    assert.match(file, /^config\/[a-z0-9-]+\.json$/, 'documents are config/*.json, nothing else');
  }
});

test('a document that never touched a disk applies the same ops', async () => {
  const docs = {
    'config/tower.json': { countdown: { label: 'Launch', target: '2026-10-01' } },
  };
  const cs = changeset([
    {
      kind: 'file-json-set',
      file: 'config/tower.json',
      pointer: '/countdown/label',
      expect: 'Launch',
      value: 'Ship',
    },
  ]);
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, documents } = await resolveOps(cs, null, {
    readDocument: documentsFrom(docs),
  });
  assert.deepEqual(mismatches, []);
  assert.deepEqual(applyDocumentOps(resolved, documents), ['config/tower.json']);
  assert.equal(documents.get('config/tower.json').countdown.label, 'Ship');
  assert.equal(docs['config/tower.json'].countdown.label, 'Launch', 'the reader handed a copy');
});

test('a stale expect refuses the whole set, and says what is there now', async () => {
  const cs = changeset([
    {
      kind: 'file-json-set',
      file: 'config/tower.json',
      pointer: '/countdown/label',
      expect: 'Launch',
      value: 'Ship',
    },
    {
      kind: 'file-json-set',
      file: 'config/tower.json',
      pointer: '/countdown/target',
      expect: '2026-10-01',
      value: '2026-11-01',
    },
  ]);
  const { mismatches } = await resolveOps(cs, null, {
    readDocument: documentsFrom({
      'config/tower.json': { countdown: { label: 'Somebody else', target: '2026-10-01' } },
    }),
  });
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].current, 'Somebody else');
  assert.equal(mismatches[0].op.pointer, '/countdown/label');
});

test('a pointer nothing holds resolves MISSING rather than throwing', async () => {
  const cs = changeset([
    {
      kind: 'file-json-set',
      file: 'config/tower.json',
      pointer: '/countdown/label',
      expect: null,
      value: 'Ship',
    },
  ]);
  const { mismatches } = await resolveOps(cs, null, {
    readDocument: documentsFrom({ 'config/tower.json': { countdown: {} } }),
  });
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].current, MISSING);
});

// A GUARD THAT CAN SAY "NOTHING IS THERE" (bead `ro-j71v`). `expect` is a JSON
// value, so an absent key had no honest spelling — the Sources tab sent `""` for
// one and every first mapping on every asset came back stale. These are the
// rule: the word is understood, it creates exactly one declared optional key,
// and it is still a guard.
const LANE_FILE = 'config/integrations.json';
const LANE_DOC = {
  assets: { 'meals.example': { ga4: { status: 'live', note: 'proved', since: '2026-07-29' } } },
};
const firstWrite = (pointer, value) => ({
  kind: 'file-json-set',
  file: LANE_FILE,
  pointer,
  expectAbsent: true,
  value,
});

test('expectAbsent writes the first value into a declared optional field', async () => {
  const cs = changeset([firstWrite('/assets/meals.example/ga4/propertyId', '313598867')]);
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, documents } = await resolveOps(cs, null, {
    readDocument: documentsFrom({ [LANE_FILE]: LANE_DOC }),
  });
  assert.deepEqual(mismatches, []);
  assert.equal(resolved[0].current, MISSING);
  applyDocumentOps(resolved, documents, { at: '2026-09-05T09:00:00.000Z' });
  assert.deepEqual(documents.get(LANE_FILE).assets['meals.example'].ga4, {
    status: 'live',
    note: 'proved',
    since: '2026-07-29',
    propertyId: '313598867',
  });
});

test('expectAbsent is still a guard — a field already filled in is a mismatch', async () => {
  const cs = changeset([firstWrite('/assets/meals.example/ga4/ref', 'mine')]);
  const { mismatches } = await resolveOps(cs, null, {
    readDocument: documentsFrom({
      [LANE_FILE]: {
        assets: { 'meals.example': { ga4: { status: 'live', ref: 'somebody else wrote this' } } },
      },
    }),
  });
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].expect, MISSING);
  assert.equal(mismatches[0].current, 'somebody else wrote this');
});

test('expectAbsent creates that one key and refuses every other shape', async () => {
  // A row, a required field, and a parent that is not there either — none of
  // them is a field awaiting its first value.
  for (const pointer of [
    '/assets/meals.example/clarity',
    '/assets/meals.example/ga4/status',
    '/assets/meals.example/ga4/nested/propertyId',
  ]) {
    assert.throws(
      () => validateSchemaAndSafety(changeset([firstWrite(pointer, 'live')])),
      (err) => err instanceof ChangesetError && /declared OPTIONAL field/.test(err.message),
      pointer,
    );
  }
  // Two claims about one pointer, and a flag that is not `true`.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-set',
            file: LANE_FILE,
            pointer: '/assets/meals.example/ga4/propertyId',
            expect: '',
            expectAbsent: true,
            value: '1',
          },
        ]),
      ),
    (err) => err instanceof ChangesetError && /never both/.test(err.message),
  );
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-set',
            file: LANE_FILE,
            pointer: '/assets/meals.example/ga4/propertyId',
            expectAbsent: false,
            value: '1',
          },
        ]),
      ),
    (err) => err instanceof ChangesetError && /is true or is not there at all/.test(err.message),
  );
});

// THE OTHER HALF OF THAT GUARD (bead `ro-pkpz`). A first write puts a key there
// that was not there; nothing could take it away again, so a mapping was a
// one-way door and a first save carried no Undo. A `file-json-delete` is now
// licensed at the same pointer `expectAbsent` is — one declared OPTIONAL field
// of a row that already exists — and these are the four things that has to be
// true of: it removes exactly that key, it is still a guard, it refuses
// everything a first write refuses, and the two ops are each other's inverse.
const unset = (pointer, expect) => ({
  kind: 'file-json-delete',
  file: LANE_FILE,
  pointer,
  expect,
});

test('a delete takes one declared optional field back off the row', async () => {
  const cs = changeset([unset('/assets/meals.example/ga4/propertyId', '313598867')]);
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, documents } = await resolveOps(cs, null, {
    readDocument: documentsFrom({
      [LANE_FILE]: {
        assets: {
          'meals.example': {
            ga4: { status: 'live', note: 'proved', since: '2026-07-29', propertyId: '313598867' },
          },
        },
      },
    }),
  });
  assert.deepEqual(mismatches, []);
  applyDocumentOps(resolved, documents, { at: '2026-09-05T09:00:00.000Z' });
  // The key is GONE rather than blank — an absent field is what the collector
  // reads as "fall back", and `""` would be a value nobody meant.
  assert.deepEqual(documents.get(LANE_FILE).assets['meals.example'].ga4, {
    status: 'live',
    note: 'proved',
    since: '2026-07-29',
  });
});

test('a delete is still a guard — a field that moved is a mismatch', async () => {
  const cs = changeset([unset('/assets/meals.example/ga4/propertyId', '313598867')]);
  const { mismatches } = await resolveOps(cs, null, {
    readDocument: documentsFrom({
      [LANE_FILE]: {
        assets: { 'meals.example': { ga4: { status: 'live', propertyId: '444555666' } } },
      },
    }),
  });
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].current, '444555666');
});

test('a delete removes only what a first write may create', () => {
  // A REQUIRED field, and a pointer two levels down — the same two shapes
  // `expectAbsent` refuses, because the licence is one predicate.
  for (const pointer of [
    '/assets/meals.example/ga4/status',
    '/assets/meals.example/ga4/nested/propertyId',
  ]) {
    assert.throws(
      () => validateSchemaAndSafety(changeset([unset(pointer, 'anything')])),
      (err) => err instanceof ChangesetError && /declared OPTIONAL field/.test(err.message),
      pointer,
    );
  }
  // And it still carries a delete's own guard, wherever it is licensed.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          { kind: 'file-json-delete', file: LANE_FILE, pointer: '/assets/meals.example/ga4/propertyId' },
        ]),
      ),
    (err) => err instanceof ChangesetError && /missing "expect"/.test(err.message),
  );
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([{ ...unset('/assets/meals.example/ga4/propertyId', 'x'), value: 'y' }]),
      ),
    (err) => err instanceof ChangesetError && /takes no "value"/.test(err.message),
  );
  // An INSERT at a field is refused: a field's first value is a set that says
  // `expectAbsent`, and licensing an insert there would widen the permission
  // that keeps "a row may be added" separate from "this file may be rewritten".
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          {
            kind: 'file-json-insert',
            file: LANE_FILE,
            pointer: '/assets/meals.example/ga4/propertyId',
            value: '313598867',
          },
        ]),
      ),
    (err) => err instanceof ChangesetError && /is not a row of/.test(err.message),
  );
});

test('the first write and the delete are one another exactly', async () => {
  const before = structuredClone(LANE_DOC);
  const forward = changeset([firstWrite('/assets/meals.example/ga4/propertyId', '313598867')]);
  validateSchemaAndSafety(forward);
  const first = await resolveOps(forward, null, { readDocument: documentsFrom({ [LANE_FILE]: before }) });
  applyDocumentOps(first.resolved, first.documents, { at: '2026-09-05T09:00:00.000Z' });
  const written = first.documents.get(LANE_FILE);

  const back = changeset([unset('/assets/meals.example/ga4/propertyId', '313598867')]);
  validateSchemaAndSafety(back);
  const second = await resolveOps(back, null, { readDocument: documentsFrom({ [LANE_FILE]: written }) });
  assert.deepEqual(second.mismatches, []);
  applyDocumentOps(second.resolved, second.documents, { at: '2026-09-05T09:00:00.000Z' });
  // Byte for byte the document the write started from — which is what makes the
  // Undo in the toast an undo rather than an approximation.
  assert.deepEqual(second.documents.get(LANE_FILE), before);
});

// THE PROSE THE PRODUCT RETIRED (bead `ro-ujb9.96.6.20`). An installation seeded
// before 2026-09-23 still stores the data-source catalog's paragraphs; nothing
// declares them any more, so a delete is licensed by `RETIRED_KEYS` and by
// nothing else — and only a delete.
const LEGACY_DOC = {
  honestyRule: 'A data source is live only when the OS can consume it.',
  stateMeaning: { live: 'The OS can consume this data source now.' },
  states: ['live', 'degraded', 'needs-setup', 'skipped', 'not-applicable'],
  catalog: [
    { id: 'gsc', label: 'Google Search Console', docRef: 'docs/11-integrations.md', liveMeans: 'A pull runs.', perProperty: 'Grant access.' },
  ],
  assets: {},
};

test('a retired paragraph leaves a stored document by a guarded delete', async () => {
  const cs = changeset([
    { kind: 'file-json-delete', file: LANE_FILE, pointer: '/honestyRule', expect: LEGACY_DOC.honestyRule },
    { kind: 'file-json-delete', file: LANE_FILE, pointer: '/stateMeaning', expect: LEGACY_DOC.stateMeaning },
    { kind: 'file-json-delete', file: LANE_FILE, pointer: '/catalog/0/liveMeans', expect: 'A pull runs.' },
    { kind: 'file-json-delete', file: LANE_FILE, pointer: '/catalog/0/perProperty', expect: 'Grant access.' },
  ]);
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, documents } = await resolveOps(cs, null, {
    readDocument: documentsFrom({ [LANE_FILE]: LEGACY_DOC }),
  });
  assert.deepEqual(mismatches, []);
  applyDocumentOps(resolved, documents, { at: '2026-09-24T09:00:00.000Z' });
  assert.deepEqual(documents.get(LANE_FILE), {
    states: LEGACY_DOC.states,
    catalog: [{ id: 'gsc', label: 'Google Search Console', docRef: 'docs/11-integrations.md' }],
    assets: {},
  });
});

test('a retired paragraph can only leave: no insert, no first write, and still a guard', async () => {
  assert.throws(
    () => validateSchemaAndSafety(changeset([
      { kind: 'file-json-insert', file: LANE_FILE, pointer: '/honestyRule', value: 'back again' },
    ])),
    (err) => err instanceof ChangesetError,
  );
  assert.throws(
    () => validateSchemaAndSafety(changeset([
      { kind: 'file-json-set', file: LANE_FILE, pointer: '/catalog/0/liveMeans', expectAbsent: true, value: 'back again' },
    ])),
    (err) => err instanceof ChangesetError,
  );
  assert.throws(
    () => validateSchemaAndSafety(changeset([
      { kind: 'file-json-delete', file: LANE_FILE, pointer: '/honestyRule' },
    ])),
    (err) => err instanceof ChangesetError && /missing "expect"/.test(err.message),
  );
  // A key it does not name is not licensed by it: a catalog row's required label.
  assert.throws(
    () => validateSchemaAndSafety(changeset([
      { kind: 'file-json-delete', file: LANE_FILE, pointer: '/catalog/0/label', expect: 'Google Search Console' },
    ])),
    (err) => err instanceof ChangesetError,
  );
  // A paragraph somebody already removed is a mismatch, not a silent success.
  const gone = changeset([
    { kind: 'file-json-delete', file: LANE_FILE, pointer: '/honestyRule', expect: LEGACY_DOC.honestyRule },
  ]);
  const { mismatches } = await resolveOps(gone, null, {
    readDocument: documentsFrom({ [LANE_FILE]: { states: [], catalog: [], assets: {} } }),
  });
  assert.equal(mismatches.length, 1);
});

// The roster's and the entity register's own descriptions (bead
// `ro-ujb9.96.6.16`): documentation no screen drew, now in each README. An
// older store drops them by the same guarded delete, and they cannot come back.
test('the roster and entity descriptions leave a stored document and cannot return', async () => {
  const PANELS = 'config/signal-panels.json';
  const ENTITIES = 'config/entities.json';
  const legacyPanels = {
    version: 1,
    updated: '2026-08-05',
    purpose: 'The roster of sites whose panels are kept current.',
    refresh: { windowDays: 35, freshnessMaxAgeDays: 7, costNote: 'A refresh pass makes zero provider calls.' },
    assets: {},
  };
  const legacyEntities = { version: 1, purpose: 'Which legal entity owns which sites.', entities: [] };
  const cs = changeset([
    { kind: 'file-json-delete', file: PANELS, pointer: '/purpose', expect: legacyPanels.purpose },
    { kind: 'file-json-delete', file: PANELS, pointer: '/refresh/costNote', expect: legacyPanels.refresh.costNote },
    { kind: 'file-json-delete', file: ENTITIES, pointer: '/purpose', expect: legacyEntities.purpose },
  ]);
  validateSchemaAndSafety(cs);
  const { resolved, mismatches, documents } = await resolveOps(cs, null, {
    readDocument: documentsFrom({ [PANELS]: legacyPanels, [ENTITIES]: legacyEntities }),
  });
  assert.deepEqual(mismatches, []);
  applyDocumentOps(resolved, documents, { at: '2026-09-24T09:00:00.000Z' });
  assert.deepEqual(documents.get(PANELS), {
    version: 1,
    updated: '2026-09-24',
    refresh: { windowDays: 35, freshnessMaxAgeDays: 7 },
    assets: {},
  });
  assert.deepEqual(documents.get(ENTITIES), { version: 1, entities: [] });

  for (const op of [
    { kind: 'file-json-insert', file: ENTITIES, pointer: '/purpose', value: 'back again' },
    { kind: 'file-json-set', file: PANELS, pointer: '/refresh/costNote', expectAbsent: true, value: 'back again' },
    { kind: 'file-json-delete', file: PANELS, pointer: '/purpose' },
  ]) {
    assert.throws(() => validateSchemaAndSafety(changeset([op])), (err) => err instanceof ChangesetError);
  }
});

// THE NO-NIGHTLY-REPORT DECLARATION (bead `ro-ujb9.96.8`). One list of asset
// ids in the saved constants, absent until the first asset declares. The asset
// Settings switch writes it as ONE setting: a first write creates the key, a set
// replaces the list, and the Undo of the first write is the delete — all three
// through the same guard, so the switch's Undo is exact.
const CONSTANTS = 'config/constants.json';
const NO_REPORT = '/no_nightly_report';
const CONSTANTS_DOC = { flag_defaults: { alpha: 0.01 }, os_time_zone: 'UTC' };

test('a first write creates the no-report list and its delete takes it back exactly', async () => {
  const forward = changeset([
    { kind: 'file-json-set', file: CONSTANTS, pointer: NO_REPORT, expectAbsent: true, value: ['areas.example'] },
  ]);
  validateSchemaAndSafety(forward);
  const first = await resolveOps(forward, null, { readDocument: documentsFrom({ [CONSTANTS]: CONSTANTS_DOC }) });
  assert.deepEqual(first.mismatches, []);
  applyDocumentOps(first.resolved, first.documents, { at: '2026-09-23T09:00:00.000Z' });
  const written = first.documents.get(CONSTANTS);
  assert.deepEqual(written.no_nightly_report, ['areas.example']);

  const back = changeset([{ kind: 'file-json-delete', file: CONSTANTS, pointer: NO_REPORT, expect: ['areas.example'] }]);
  validateSchemaAndSafety(back);
  const second = await resolveOps(back, null, { readDocument: documentsFrom({ [CONSTANTS]: written }) });
  assert.deepEqual(second.mismatches, []);
  applyDocumentOps(second.resolved, second.documents, { at: '2026-09-23T09:00:00.000Z' });
  assert.deepEqual(second.documents.get(CONSTANTS), CONSTANTS_DOC);
});

test('the no-report first write is still a guard — a list already there is a mismatch', async () => {
  const cs = changeset([
    { kind: 'file-json-set', file: CONSTANTS, pointer: NO_REPORT, expectAbsent: true, value: ['fees.example'] },
  ]);
  const { mismatches } = await resolveOps(cs, null, {
    readDocument: documentsFrom({ [CONSTANTS]: { ...CONSTANTS_DOC, no_nightly_report: ['areas.example'] } }),
  });
  assert.equal(mismatches.length, 1);
  assert.deepEqual(mismatches[0].current, ['areas.example']);
});

test('the no-report list is written whole, and only as a list of asset ids', () => {
  const set = (pointer, value) =>
    changeset([{ kind: 'file-json-set', file: CONSTANTS, pointer, expect: [], value }]);
  validateSchemaAndSafety(set(NO_REPORT, ['areas.example', 'fees.example']));
  validateSchemaAndSafety(set(NO_REPORT, []));
  for (const [pointer, value, reason] of [
    [NO_REPORT, 'areas.example', /must be a list of asset ids/],
    [NO_REPORT, ['Area Lookup!'], /is not an asset id/],
    [NO_REPORT, ['fees.example', 'fees.example'], /listed twice/],
    [`${NO_REPORT}/0`, 'fees.example', /as one list/],
  ]) {
    assert.throws(
      () => validateSchemaAndSafety(set(pointer, value)),
      (err) => err instanceof ChangesetError && reason.test(err.message),
      `${pointer} ${JSON.stringify(value)}`,
    );
  }
  // The insert that births the same document is held to the same shape.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([{ kind: 'file-json-insert', file: CONSTANTS, pointer: NO_REPORT, value: [42] }]),
      ),
    (err) => err instanceof ChangesetError && /is not an asset id/.test(err.message),
  );
  // And a first write is licensed at the declared document ONLY: one level
  // down is still a key nothing may invent.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([
          { kind: 'file-json-set', file: CONSTANTS, pointer: '/monthly_caps/inference_usd', expectAbsent: true, value: 5 },
        ]),
      ),
    (err) => err instanceof ChangesetError && /declared OPTIONAL field/.test(err.message),
  );
});

// A DECLARED DOCUMENT NOBODY HAS SAVED (bead `ro-nuz9`). The product ships
// `config/tower.json` with `"wall": null`; a store seeded without the key and
// the journey fixture hold no `/wall` at all. The TV layout editor guarded its
// first Save with `expect: null`, so on a store without the key the first Save
// was refused as "Changed elsewhere". One rule for every declared document:
// either spelling of "not saved yet" in the store matches either spelling of
// it in the guard, and the write lands.
const TOWER = 'config/tower.json';
const MOVED_WALL = { ...DEFAULT_WALL_LAYOUT, rows: [...DEFAULT_WALL_LAYOUT.rows].reverse() };
const FIRST_JOB = SCHEDULED_JOBS[0];
const DECLARED = [
  [TOWER, '/wall', { readme: 'config/tower.README.md' }, { layout: MOVED_WALL, history: [] }],
  [TOWER, '/countdown', { readme: 'config/tower.README.md' }, { emoji: '🚀', label: 'Launch', targetAt: '2026-10-01T09:00:00.000Z' }],
  [CONSTANTS, '/schedules', CONSTANTS_DOC, { [FIRST_JOB.id]: scheduleFor(FIRST_JOB) }],
  [CONSTANTS, NO_REPORT, CONSTANTS_DOC, ['areas.example']],
];
const FIRST_SAVES = {
  'expect null': (file, pointer, value) => ({ kind: 'file-json-set', file, pointer, expect: null, value }),
  expectAbsent: (file, pointer, value) => ({ kind: 'file-json-set', file, pointer, expectAbsent: true, value }),
  insert: (file, pointer, value) => ({ kind: 'file-json-insert', file, pointer, value }),
};

test('the first save of a declared document lands whether the store holds null or no key at all', async () => {
  for (const [file, pointer, base, value] of DECLARED) {
    const key = pointer.slice(1);
    for (const [spelling, stored] of [['no key', base], ['null', { ...base, [key]: null }]]) {
      for (const [guard, op] of Object.entries(FIRST_SAVES)) {
        const at = `${file} ${pointer} · store ${spelling} · ${guard}`;
        const cs = changeset([op(file, pointer, value)]);
        validateSchemaAndSafety(cs);
        const { resolved, mismatches, documents } = await resolveOps(cs, null, {
          readDocument: documentsFrom({ [file]: stored }),
        });
        assert.deepEqual(mismatches, [], at);
        applyDocumentOps(resolved, documents, { at: '2026-09-24T09:00:00.000Z' });
        assert.deepEqual(documents.get(file), { ...base, [key]: value }, at);
      }
    }
  }
});

test('the TV layout saves twice in a row: created on a store with no /wall, then updated on what it wrote', async () => {
  const created = { layout: MOVED_WALL, history: [] };
  const first = await resolveOps(
    changeset([{ kind: 'file-json-set', file: TOWER, pointer: '/wall', expect: null, value: created }]),
    null,
    { readDocument: documentsFrom({ [TOWER]: {} }) },
  );
  assert.deepEqual(first.mismatches, []);
  applyDocumentOps(first.resolved, first.documents, { at: '2026-09-24T09:00:00.000Z' });
  const stored = first.documents.get(TOWER);
  assert.deepEqual(stored, { wall: created });

  const updated = {
    layout: DEFAULT_WALL_LAYOUT,
    history: [{ savedAt: '2026-09-24T09:01:00.000Z', reason: 'Rearranged rows', layout: MOVED_WALL }],
  };
  const second = await resolveOps(
    changeset([{ kind: 'file-json-set', file: TOWER, pointer: '/wall', expect: created, value: updated }]),
    null,
    { readDocument: documentsFrom({ [TOWER]: stored }) },
  );
  assert.deepEqual(second.mismatches, []);
  applyDocumentOps(second.resolved, second.documents, { at: '2026-09-24T09:01:00.000Z' });
  assert.deepEqual(second.documents.get(TOWER), { wall: updated });
});

test('a saved declared document is still guarded: "not saved yet" is stale once somebody saved one', async () => {
  const saved = { layout: DEFAULT_WALL_LAYOUT, history: [] };
  for (const [guard, op] of Object.entries(FIRST_SAVES)) {
    const { mismatches } = await resolveOps(changeset([op(TOWER, '/wall', { layout: MOVED_WALL, history: [] })]), null, {
      readDocument: documentsFrom({ [TOWER]: { wall: saved } }),
    });
    assert.equal(mismatches.length, 1, guard);
    assert.equal(mismatches[0].expect, MISSING, guard);
    assert.deepEqual(mismatches[0].current, saved, guard);
  }
  // And a stored `null` is "nothing saved" only at a declared document: an
  // ordinary value that is null is compared as the value it is.
  const { mismatches } = await resolveOps(
    changeset([{ kind: 'file-json-set', file: CONSTANTS, pointer: '/os_time_zone', expectAbsent: true, value: 'UTC' }]),
    null,
    { readDocument: documentsFrom({ [CONSTANTS]: { ...CONSTANTS_DOC, os_time_zone: null } }) },
  );
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].current, null);
});

// A KEY THE SAVED DOCUMENT LACKS (bead `ro-dk4u`). Every reader answers it
// from the built-in copy, so Settings shows the built-in value and guards its
// Save with it. The lane compared that guard with the stored document, where
// the key resolved nowhere, and refused the Save as "Changed elsewhere". Now a
// set there is compared with the built-in copy's value, creates the key, and
// is guarded by the saved value from then on.
const BUILT_IN_CONSTANTS = {
  os_time_zone: 'UTC',
  operator_rate_usd_per_min: 2,
  monthly_caps: { data_usd: 25 },
  flag_defaults: { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 },
};
const builtInFrom = (map) => async (file) => structuredClone(map[file] ?? null);
const setOp = (pointer, expect, value) => ({ kind: 'file-json-set', file: CONSTANTS, pointer, expect, value });

async function saveOnto(stored, ops) {
  const cs = changeset(ops);
  validateSchemaAndSafety(cs);
  const result = await resolveOps(cs, null, {
    readDocument: documentsFrom({ [CONSTANTS]: stored }),
    readBuiltIn: builtInFrom({ [CONSTANTS]: BUILT_IN_CONSTANTS }),
  });
  if (result.mismatches.length === 0) applyDocumentOps(result.resolved, result.documents, { at: '2026-09-24T09:00:00.000Z' });
  return { mismatches: result.mismatches, saved: result.documents.get(CONSTANTS) };
}

test('a setting shown from the built-in copy saves: a stored document missing monthly_caps gains it', async () => {
  const stored = { os_time_zone: 'UTC', flag_defaults: { alpha: 0.01 } };
  const first = await saveOnto(stored, [setOp('/monthly_caps/data_usd', 25, 40)]);
  assert.deepEqual(first.mismatches, [], 'the Save guarded by the value the page showed lands');
  assert.deepEqual(first.saved, { ...stored, monthly_caps: { data_usd: 40 } }, 'only the saved key is created');

  // Guarded once the key exists: the built-in value is now a stale guard.
  const stale = await saveOnto(first.saved, [setOp('/monthly_caps/data_usd', 25, 50)]);
  assert.equal(stale.mismatches.length, 1);
  assert.equal(stale.mismatches[0].current, 40);
  const next = await saveOnto(first.saved, [setOp('/monthly_caps/data_usd', 40, 50)]);
  assert.deepEqual(next.mismatches, []);
  assert.equal(next.saved.monthly_caps.data_usd, 50);
});

test('a setting shown from the built-in copy saves: a missing flag_defaults key, and a missing flag_defaults', async () => {
  const lacksKey = { os_time_zone: 'UTC', flag_defaults: { min_baseline_per_day: 5 } };
  const key = await saveOnto(lacksKey, [setOp('/flag_defaults/alpha', 0.01, 0.02)]);
  assert.deepEqual(key.mismatches, []);
  assert.deepEqual(key.saved.flag_defaults, { min_baseline_per_day: 5, alpha: 0.02 }, 'the saved key beside the other saved one');

  const lacksContainer = { os_time_zone: 'UTC' };
  const container = await saveOnto(lacksContainer, [setOp('/flag_defaults/low_volume_window_hours', 72, 48)]);
  assert.deepEqual(container.mismatches, []);
  assert.deepEqual(container.saved, { os_time_zone: 'UTC', flag_defaults: { low_volume_window_hours: 48 } });

  const rate = await saveOnto(lacksContainer, [setOp('/operator_rate_usd_per_min', 2, 3)]);
  assert.deepEqual(rate.mismatches, []);
  assert.equal(rate.saved.operator_rate_usd_per_min, 3);
});

test('a key the built-in copy does not hold is still refused, and so is a guard that is not the built-in value', async () => {
  const stored = { os_time_zone: 'UTC' };
  const typo = await saveOnto(stored, [setOp('/monthly_caps/data_uds', 25, 40)]);
  assert.equal(typo.mismatches.length, 1, 'a mistyped pointer resolves nowhere');
  assert.equal(typo.mismatches[0].current, MISSING);
  const wrong = await saveOnto(stored, [setOp('/monthly_caps/data_usd', 30, 40)]);
  assert.equal(wrong.mismatches.length, 1, 'the page showed something the built-in copy does not hold');
  assert.equal(wrong.mismatches[0].current, 25);

  // A door with no built-in copy compares with the saved document alone.
  const { mismatches } = await resolveOps(changeset([setOp('/monthly_caps/data_usd', 25, 40)]), null, {
    readDocument: documentsFrom({ [CONSTANTS]: stored }),
  });
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].current, MISSING);
});

test('the built-in copy licenses object keys only: never a register row, never a taken-back document', async () => {
  const INTEGRATIONS = 'config/integrations.json';
  const row = { id: 'bing-webmaster', label: 'Bing Webmaster Tools', scope: 'property', layer: 'provider', credential: 'shared', docRef: 'docs/11-integrations.md' };
  const { mismatches } = await resolveOps(
    changeset([{ kind: 'file-json-set', file: INTEGRATIONS, pointer: '/catalog/0/label', expect: row.label, value: 'Bing' }]),
    null,
    {
      readDocument: documentsFrom({ [INTEGRATIONS]: { catalog: [], assets: {} } }),
      readBuiltIn: builtInFrom({ [INTEGRATIONS]: { catalog: [row], assets: {} } }),
    },
  );
  assert.equal(mismatches.length, 1, 'a catalog row is born by an insert, not a set');
  assert.equal(mismatches[0].current, MISSING);

  // A countdown taken back by its Undo: a stale field Save may not half-write
  // one, because the built-in copy holds none.
  const stale = await resolveOps(
    changeset([{ kind: 'file-json-set', file: TOWER, pointer: '/countdown/label', expect: 'Launch', value: 'Ship' }]),
    null,
    {
      readDocument: documentsFrom({ [TOWER]: { readme: 'config/tower.README.md' } }),
      readBuiltIn: builtInFrom({ [TOWER]: { readme: 'config/tower.README.md', wall: null } }),
    },
  );
  assert.equal(stale.mismatches.length, 1);
  assert.equal(stale.mismatches[0].current, MISSING);
});

test('a document nothing holds is a refusal naming the file', async () => {
  const cs = changeset([
    {
      kind: 'file-json-set',
      file: 'config/tower.json',
      pointer: '/countdown/label',
      expect: 'Launch',
      value: 'Ship',
    },
  ]);
  await assert.rejects(
    () => resolveOps(cs, null, { readDocument: documentsFrom({}) }),
    (err) => err instanceof ChangesetError && /config\/tower\.json/.test(err.message),
  );
});

test('an absent roster refuses nothing rather than everything', async () => {
  // `recurring-costs` declares an `asset-id` field, so its refusal is the one
  // that needs the roster. With no roster document to read, the id shape is all
  // that can be judged — which is the rule `candidateRefusal` already carries.
  const cs = changeset([
    {
      kind: 'file-json-insert',
      file: 'config/recurring-costs.json',
      pointer: '/costs/-',
      value: {
        id: 'a-subscription',
        asset: 'meals.example',
        label: 'A subscription',
        monthlyUsd: 12,
        startedOn: '2026-01-01',
      },
    },
  ]);
  const { mismatches } = await resolveOps(cs, null, {
    readDocument: documentsFrom({ 'config/recurring-costs.json': { costs: [] } }),
  });
  assert.deepEqual(mismatches, [], 'nothing is there yet, which is what an insert expects');
});

test('serializeDocument is the one spelling a document is written in', () => {
  assert.equal(serializeDocument({ a: 1 }), '{\n  "a": 1\n}\n');
});

// The Postgres store keys a document and its changes by the file's name
// (db/postgres/model.json, config_documents.file; bead ro-ujb9.76.4.1). The
// mapping names two import exceptions: a key outside [a-z0-9-], and two files
// that reduce to one key. Neither can happen to a file the store may hold.
test('every storable file has its own document key in the store, and the key names the file again', () => {
  const keys = CONFIG_DOCUMENT_FILES.map((file) => configDocumentKey(file));
  for (const [index, key] of keys.entries()) {
    assert.match(String(key), /^[a-z0-9][a-z0-9-]*$/u, CONFIG_DOCUMENT_FILES[index]);
    assert.equal(configDocumentFile(key), CONFIG_DOCUMENT_FILES[index]);
  }
  assert.equal(new Set(keys).size, keys.length, 'no two files share a key');
  assert.equal(configDocumentKey('config/tower.json'), 'tower');
  for (const path of ['config/nested/tower.json', 'tower.json', 'config/Tower.json', 'config/tower.jsonc', 'config/.json', 'config/-x.json']) {
    assert.equal(configDocumentKey(path), null, path);
  }
});


test('a shared per-asset list is initialized and undone without touching measurement fields', async () => {
  const file = 'config/value-events.json';
  const value = [{ eventName: 'document_open', label: 'Opened a document', group: 'primary' }];
  const op = { kind: 'file-json-insert', file, pointer: '/assets/example.com/productUseStages', value };
  const cs = changeset([op]); validateSchemaAndSafety(cs);
  const current = { assets: { 'example.com': { valueEvents: ['purchase'], retained: 'opaque' } } };
  const first = await resolveOps(cs, null, { readDocument: documentsFrom({ [file]: current }) });
  assert.deepEqual(first.mismatches, []); applyDocumentOps(first.resolved, first.documents);
  assert.deepEqual(first.documents.get(file).assets['example.com'], { ...current.assets['example.com'], productUseStages: value });
  const undo = changeset([{ kind: 'file-json-delete', file, pointer: op.pointer, expect: value }]);
  validateSchemaAndSafety(undo);
  const back = await resolveOps(undo, null, { readDocument: documentsFrom({ [file]: first.documents.get(file) }) });
  applyDocumentOps(back.resolved, back.documents); assert.deepEqual(back.documents.get(file), current);
  const collision = await resolveOps(cs, null, { readDocument: documentsFrom({ [file]: first.documents.get(file) }) });
  assert.equal(collision.mismatches.length, 1);
  const absent = await resolveOps(changeset([{ kind: 'file-json-insert', file, pointer: '/assets/example.com', value: { productUseStages: value } }]), null,
    { readDocument: documentsFrom({ [file]: current }) });
  assert.equal(absent.mismatches.length, 1, 'a concurrent measurement holder can never be overwritten');
});

test('first-list validation rejects invalid stages and supports the existing protected scalar list', async () => {
  const file = 'config/value-events.json'; const pointer = '/assets/example.com/productUseStages';
  for (const value of [{}, [{ eventName: 'a', label: 'A', group: 'unknown' }]]) {
    assert.throws(() => validateSchemaAndSafety(changeset([{ kind: 'file-json-insert', file, pointer, value }])));
    assert.throws(() => validateSchemaAndSafety(changeset([{ kind: 'file-json-set', file, pointer, value, expectAbsent: true }])));
  }
  const op = { kind: 'file-json-insert', file, pointer: '/assets/example.com/valueEvents', value: ['purchase'] };
  validateSchemaAndSafety(changeset([op]));
  const state = { assets: { 'example.com': { productUseStages: [] } } };
  const result = await resolveOps(changeset([op]), null, { readDocument: documentsFrom({ [file]: state }) });
  applyDocumentOps(result.resolved, result.documents);
  assert.deepEqual(result.documents.get(file).assets['example.com'], { productUseStages: [], valueEvents: ['purchase'] });
  assert.throws(() => validateSchemaAndSafety(changeset([{ ...op, value: [123] }])));
});

test('Product use mutations validate the final list, including cross-row edits and recovery', async () => {
  const file='config/value-events.json', list='/assets/example.com/productUseStages';
  const row=i=>({eventName:`document_${i}`,label:`Document ${i}`,group:'primary'});
  const apply=async(stages,ops)=>{
    const cs=changeset(ops.map(op=>({...op,file})));validateSchemaAndSafety(cs);
    const result=await resolveOps(cs,null,{readDocument:documentsFrom({[file]:{assets:{'example.com':{valueEvents:['purchase'],productUseStages:stages}}}})});
    assert.deepEqual(result.mismatches,[]);applyDocumentOps(result.resolved,result.documents);
    return result.documents.get(file).assets['example.com'];
  };
  for(const pointer of [`${list}/-`,`${list}/0`]) {
    await assert.rejects(apply([row(0)],[{kind:'file-json-insert',pointer,value:row(0)}]),ChangesetError);
    await assert.rejects(apply(Array.from({length:32},(_,i)=>row(i)),[{kind:'file-json-insert',pointer,value:row(32)}]),ChangesetError);
  }
  await assert.rejects(apply([row(0),row(1)],[{kind:'file-json-set',pointer:`${list}/1/eventName`,value:'document_0',expect:'document_1'}]),ChangesetError);
  await assert.rejects(apply([row(0)],[{kind:'file-json-set',pointer:`${list}/0/compareTo`,value:'document_0',expectAbsent:true}]),ChangesetError);
  const final=await apply([row(0),row(1)],[
    {kind:'file-json-set',pointer:`${list}/0/eventName`,value:'document_1',expect:'document_0'},
    {kind:'file-json-set',pointer:`${list}/1/eventName`,value:'document_2',expect:'document_1'},
  ]);
  assert.deepEqual(final,{valueEvents:['purchase'],productUseStages:[{...row(0),eventName:'document_1'},{...row(1),eventName:'document_2'}]});
  assert.deepEqual(await apply([row(0),row(0)],[{kind:'file-json-delete',pointer:`${list}/1`,expect:row(0)}]),
    {valueEvents:['purchase'],productUseStages:[row(0)]});
  assert.deepEqual(await apply([row(0),row(0)],[{kind:'file-json-delete',pointer:list,expect:[row(0),row(0)]}]),{valueEvents:['purchase']});
});
