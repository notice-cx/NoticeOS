// The config store. Two rules hold the design up, and everything below is one
// of them asserted from a different angle:
//
//   1. An install that has not seeded behaves exactly as it did before. Every
//      read falls back to the copy compiled into this Worker, so applying the
//      migration is not a change of behaviour — seeding is.
//   2. A write never degrades. A Save that silently did nothing is the worst
//      outcome available, so a stale version and a stale `expect` each refuse
//      with a sentence and change nothing.
//
// Against real Postgres: the version guard, the one transaction that writes
// documents and audit rows together, and the store's own checks are facts
// about the store rather than about a mock.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_DOCUMENT_FILES,
  applyConfigOps,
  configSourceLine,
  forgetConfigCache,
  getConfigDocument,
  getConfigDocuments,
  listConfigDocuments,
  readCollectorConfigs,
  seedConfigDocuments,
} from '../src/config-store.js';
import { emptyTables, reset } from './helpers.js';
// The copy compiled into the Worker under test (the suite's fixture config) —
// what a reader shows for a key a stored document lacks.
import bundledConstants from './fixture-config/constants.json';

const NOW = Date.parse('2026-09-05T09:00:00.000Z');
const ACTOR = 'operator';

beforeEach(async () => {
  await reset();
  await emptyTables(['config_documents', 'config_changes']);
  forgetConfigCache();
});
afterEach(() => {
  forgetConfigCache();
});

async function seedTower(countdownLabel = 'Launch'): Promise<number> {
  const result = await seedConfigDocuments(
    env,
    {
      documents: {
        'config/tower.json': { countdown: { label: countdownLabel, target: '2026-10-01' } },
      },
      actor: 'config:seed',
    },
    NOW,
  );
  expect(result.ok).toBe(true);
  return result.seeded[0]!.version;
}

/** `config/integrations.json` as the store holds it before an operator has
 * mapped anything: one lane row, its posture written down, and no mapping
 * field — the state every asset starts in. Seeded rather than left to the
 * compiled fallback because a case about one lane row must state the row it
 * is about; it is also a copy, which the case below pins. */
async function seedIntegrations(): Promise<void> {
  const result = await seedConfigDocuments(
    env,
    {
      documents: {
        'config/integrations.json': {
          catalog: [{ id: 'ga4', label: 'Google Analytics 4' }],
          assets: {
            'meadow.example': {
              ga4: { status: 'live', note: 'Collector proved it.', since: '2026-07-29' },
            },
          },
        },
      },
      actor: 'config:seed',
    },
    NOW,
  );
  expect(result.ok).toBe(true);
}

describe('the documents the store may hold', () => {
  it('is derived from the register declarations, and is all config/*.json', () => {
    expect(CONFIG_DOCUMENT_FILES).toContain('config/constants.json');
    expect(CONFIG_DOCUMENT_FILES).toContain('config/tower.json');
    expect(CONFIG_DOCUMENT_FILES).toContain('config/pull.json');
    expect(CONFIG_DOCUMENT_FILES).toContain('config/integrations.json');
    for (const file of CONFIG_DOCUMENT_FILES) expect(file).toMatch(/^config\/[a-z0-9-]+\.json$/);
  });
});

describe('reading before anything is seeded', () => {
  it('answers the copy compiled into this Worker, and says so', async () => {
    const read = await getConfigDocument(env, 'config/constants.json');
    expect(read.source).toBe('file');
    expect(read.version).toBeNull();
    expect(read.body).not.toBeNull();
    // The bundled constants are the real file, so this is the operator's own
    // rate rather than a fixture — the point being that a lane reading it gets
    // the value it got yesterday.
    expect(read.body).toHaveProperty('operator_rate_usd_per_min');
  });

  it('leaves every collector on its compiled config', async () => {
    const { documents, sources } = await readCollectorConfigs(env);
    expect(documents).toEqual({});
    // Six files, every one of them answered by the copy compiled into this
    // Worker — which is what makes an unseeded run byte-identical to yesterday's.
    expect(Object.values(sources)).toEqual(Array(6).fill('file'));
  });

  it('names a file this Worker does not carry rather than inventing one', async () => {
    // config/beads.json is deliberately NOT bundled here: it holds the task
    // hub's host and port, which has no business in a deployed ingest bundle.
    const read = await getConfigDocument(env, 'config/beads.json');
    expect(read.source).toBe('file');
    expect(read.body).toBeNull();
  });
});

describe('seeding', () => {
  it('loads a document and stamps version 1 with an audit row', async () => {
    expect(await seedTower()).toBe(1);

    const read = await getConfigDocument(env, 'config/tower.json');
    expect(read.source).toBe('store');
    expect(read.version).toBe(1);
    expect(read.updatedBy).toBe('config:seed');
    expect(read.body).toMatchObject({ countdown: { label: 'Launch' } });

    const [change] = await env.STORE.read((tx) =>
      tx.query<{ document_key: string; actor: string; version_before: number; version_after: number }>(
        'SELECT document_key, actor, version_before, version_after FROM noticeos.config_changes',
      ),
    );
    expect(change).toMatchObject({
      document_key: 'tower',
      actor: 'config:seed',
      version_before: 0,
      version_after: 1,
    });
  });

  it('never overwrites — a second seed skips, naming the version it is at', async () => {
    await seedTower('Launch');
    const again = await seedConfigDocuments(
      env,
      {
        documents: { 'config/tower.json': { countdown: { label: 'From the file', target: 'x' } } },
        actor: 'config:seed',
      },
      NOW,
    );
    expect(again.seeded).toEqual([]);
    expect(again.skipped).toEqual([{ file: 'config/tower.json', version: 1 }]);
    forgetConfigCache();
    const read = await getConfigDocument(env, 'config/tower.json');
    expect(read.body).toMatchObject({ countdown: { label: 'Launch' } });
  });

  it('a forced re-seed needs a reason, and bumps the version when it has one', async () => {
    await seedTower('Launch');
    const noReason = await seedConfigDocuments(
      env,
      {
        documents: { 'config/tower.json': { countdown: { label: 'Forced', target: 'x' } } },
        actor: 'config:seed',
        force: ['config/tower.json'],
      },
      NOW,
    );
    expect(noReason.ok).toBe(false);
    expect(noReason.refused[0]?.detail).toMatch(/reason/);

    const forced = await seedConfigDocuments(
      env,
      {
        documents: { 'config/tower.json': { countdown: { label: 'Forced', target: 'x' } } },
        actor: 'config:seed',
        force: ['config/tower.json'],
        reason: 'the checkout is the source after a restore',
      },
      NOW,
    );
    expect(forced.seeded).toEqual([{ file: 'config/tower.json', version: 2 }]);
  });

  it('refuses a path no register names', async () => {
    const result = await seedConfigDocuments(
      env,
      { documents: { 'config/secrets.json': { a: 1 } }, actor: 'config:seed' },
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.refused[0]?.file).toBe('config/secrets.json');
  });
});

describe('writing', () => {
  it('applies the ops, bumps the version and records who and why', async () => {
    await seedTower();
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/tower.json',
            pointer: '/countdown/label',
            expect: 'Launch',
            value: 'Ship',
          },
        ],
        expectVersions: { 'config/tower.json': 1 },
        actor: ACTOR,
        reason: 'the launch date moved',
        slug: 'countdown-label',
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: true, applied: 1 });

    const read = await getConfigDocument(env, 'config/tower.json');
    expect(read.version).toBe(2);
    expect(read.body).toMatchObject({ countdown: { label: 'Ship' } });

    const [change] = await env.STORE.read((tx) =>
      tx.query<{ actor: string; reason: string; version_before: number; version_after: number; ops: string }>(
        `SELECT actor, reason, version_before, version_after, ops
           FROM noticeos.config_changes WHERE version_after = 2`,
      ),
    );
    expect(change).toMatchObject({ actor: ACTOR, reason: 'the launch date moved', version_before: 1 });
    expect(JSON.parse(change!.ops)).toHaveLength(1);
  });

  it('refuses a change to a document neither the store nor this Worker holds, naming the seed', async () => {
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-insert',
            file: 'config/beads.json',
            pointer: '/spokes/-',
            value: { asset: 'meadow.example', prefix: 'meadow', database: 'meadow' },
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toEqual({
      ok: false,
      error: 'not_seeded',
      detail: 'Not seeded · config/beads.json · pnpm config:seed',
      files: ['config/beads.json'],
    });
    expect(await listConfigDocuments(env)).toEqual({ documents: [] });
  });

  it('seeds an unseeded document from the compiled copy rather than refusing', async () => {
    // A freshly deployed Tower can save without a terminal step. The audit row
    // says the document entered the store here.
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/signal-panels.json',
            pointer: '/refresh/windowDays',
            expect: 35,
            value: 20,
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: true });
    const read = await getConfigDocument(env, 'config/signal-panels.json');
    expect(read.source).toBe('store');
    expect(read.version).toBe(1);
    expect(read.body).toMatchObject({ refresh: { windowDays: 20 } });
  });

  // The first Save of the TV layout on a new installation: the product's
  // config/tower.json ships `"wall": null`; a store seeded without that key
  // holds no `/wall` at all. The editor guards its first Save with the `null`
  // it read, and both stores must take it — then the next Save, guarded by the
  // layout the first one wrote.
  it.each([
    ['the product default, "wall": null', { readme: 'config/tower.README.md', wall: null }],
    ['a document with no /wall key', { readme: 'config/tower.README.md' }],
  ])('saves the TV layout twice on a store holding %s', async (_label, seeded) => {
    const seed = await seedConfigDocuments(
      env,
      { documents: { 'config/tower.json': seeded }, actor: 'config:seed' },
      NOW,
    );
    expect(seed.ok).toBe(true);
    const row = (id: string) => ({ id, height: 'auto', widgets: [{ id, type: id, width: 1 }] });
    const fill = { id: 'sites', height: 'fill', widgets: [{ id: 'sites', type: 'sites', width: 1 }] };
    const created = { layout: { version: 1, rows: [row('strip'), fill] }, history: [] };
    const first = await applyConfigOps(
      env,
      {
        ops: [{ kind: 'file-json-set', file: 'config/tower.json', pointer: '/wall', expect: null, value: created }],
        actor: ACTOR,
        slug: 'wall-layout',
      },
      NOW,
    );
    expect(first).toMatchObject({ ok: true, applied: 1 });

    const updated = {
      layout: { version: 1, rows: [fill, row('strip')] },
      history: [{ savedAt: '2026-09-05T09:00:00.000Z', reason: 'Rearranged rows', layout: created.layout }],
    };
    const second = await applyConfigOps(
      env,
      {
        ops: [{ kind: 'file-json-set', file: 'config/tower.json', pointer: '/wall', expect: created, value: updated }],
        actor: ACTOR,
        slug: 'wall-layout',
      },
      NOW,
    );
    expect(second).toMatchObject({ ok: true, applied: 1 });
    const read = await getConfigDocument(env, 'config/tower.json');
    expect(read.version).toBe(3);
    expect(read.body).toEqual({ readme: 'config/tower.README.md', wall: updated });
  });

  // A setting shown from the built-in copy: a stored constants document seeded
  // before a key existed lacks it; Settings shows the value compiled into the
  // Workers and guards its Save with it. The Save creates the key, and the next
  // Save is guarded by what it saved.
  it.each([
    ['monthly_caps', '/monthly_caps/data_usd', 'data_usd', (d: Record<string, unknown>) => { delete d.monthly_caps; }],
    ['a flag_defaults key', '/flag_defaults/alpha', 'alpha', (d: Record<string, unknown>) => { delete (d.flag_defaults as Record<string, unknown>).alpha; }],
    ['flag_defaults', '/flag_defaults/alpha', 'alpha', (d: Record<string, unknown>) => { delete d.flag_defaults; }],
  ])('saves a setting on a stored constants document missing %s, then guards it', async (_label, pointer, key, drop) => {
    const stored = structuredClone(bundledConstants) as Record<string, unknown>;
    drop(stored);
    expect((await seedConfigDocuments(env, { documents: { 'config/constants.json': stored }, actor: 'config:seed' }, NOW)).ok).toBe(true);
    const shown = pointer.split('/').slice(1).reduce<unknown>((at, token) => (at as Record<string, unknown>)[token], bundledConstants) as number;
    expect(typeof shown).toBe('number');
    const save = (expectValue: number, value: number) =>
      applyConfigOps(env, { ops: [{ kind: 'file-json-set', file: 'config/constants.json', pointer, expect: expectValue, value }], actor: ACTOR, slug: 'settings' }, NOW);

    expect(await save(shown, 7)).toMatchObject({ ok: true, applied: 1 });
    const read = await getConfigDocument(env, 'config/constants.json');
    expect(read.version).toBe(2);
    const container = pointer.split('/')[1]!;
    expect((read.body as Record<string, Record<string, unknown>>)[container]).toMatchObject({ [key]: 7 });

    // Guarded once it exists: the built-in value is now a stale guard.
    expect(await save(shown, 8)).toMatchObject({ ok: false, error: 'expect_mismatch', mismatches: [{ pointer, current: 7, expect: shown }] });
    expect(await save(7, 8)).toMatchObject({ ok: true, applied: 1 });
  });

  it('refuses a /wall the television could not draw, in the editor\'s own words', async () => {
    // `config/tower.json` is wholesale editable, so no register or knob has an
    // opinion about `/wall`; the layout rule lives in scripts/wall-layout.mjs,
    // which validateSchemaAndSafety runs, so every door refuses in the sentence
    // the editor prints under Save.
    await seedTower();
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/tower.json',
            pointer: '/wall',
            expect: null,
            value: { layout: { version: 1, rows: [] }, history: [] },
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: 'invalid_changeset' });
    if (result.ok === false && result.error === 'invalid_changeset') {
      expect(result.detail).toContain('A layout needs at least one row.');
    }
    // Nothing written: the version is untouched and no layout landed.
    const read = await getConfigDocument(env, 'config/tower.json');
    expect(read.version).toBe(1);
    expect(read.body).not.toHaveProperty('wall');
  });

  it('takes a layout it CAN draw through the same door', async () => {
    await seedTower();
    const layout = {
      version: 1,
      rows: [
        { id: 'assets', height: 'fill', widgets: [{ id: 'assets', type: 'assets', width: 1 }] },
      ],
    };
    const result = await applyConfigOps(
      env,
      {
        ops: [
          // An insert, because `/wall` is a key `config/tower.json` does not
          // have until somebody arranges a Wall — the declared document the
          // add-asset vocabulary licenses (ADDABLE_DOCUMENTS).
          {
            kind: 'file-json-insert',
            file: 'config/tower.json',
            pointer: '/wall',
            value: { layout, history: [] },
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: true });
    expect((await getConfigDocument(env, 'config/tower.json')).body).toMatchObject({
      wall: { layout },
    });
  });

  // The compiled copy is read-only for the life of the isolate. A write seeds
  // an unseeded document from the copy compiled into this Worker, and
  // `applyDocumentOps` mutates the document it is handed — the caller owns
  // persisting it. A read that answered the module object itself would let the
  // first save on an unseeded install rewrite the Worker's own compiled config
  // in memory, and rule 1 above would stop being true the moment a write did
  // not land. Emptying the table is that failure, made deliberate.
  it('leaves the copy compiled into this Worker untouched when it seeds from it', async () => {
    const before = (await getConfigDocument(env, 'config/signal-panels.json')).body;
    expect(before).toMatchObject({ refresh: { windowDays: 35 } });

    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/signal-panels.json',
            pointer: '/refresh/windowDays',
            expect: 35,
            value: 20,
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: true });

    // The store forgets what the write put there; only the compiled copy is
    // left to answer.
    await emptyTables(['config_documents']);
    forgetConfigCache();
    const read = await getConfigDocument(env, 'config/signal-panels.json');
    expect(read.source).toBe('file');
    expect(read.body).toMatchObject({ refresh: { windowDays: 35 } });
    expect(read.body).toEqual(before);

    // And the same op is still a first write rather than a stale one.
    const again = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/signal-panels.json',
            pointer: '/refresh/windowDays',
            expect: 35,
            value: 30,
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(again).toMatchObject({ ok: true });
    expect((await getConfigDocument(env, 'config/signal-panels.json')).body).toMatchObject({
      refresh: { windowDays: 30 },
    });
  });

  // The stamp is the pipeline's, not the lane's: the rule lives in
  // `applyDocumentOps`, which both halves run, so this asserts the deployed
  // path stamps exactly what the dev write lane's own suite asserts for a
  // file, from the changeset's own instant.
  it("refreshes the date a document states about itself, from the write's own day", async () => {
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/signal-panels.json',
            pointer: '/refresh/windowDays',
            expect: 35,
            value: 42,
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: true });
    const read = await getConfigDocument(env, 'config/signal-panels.json');
    expect(read.body).toMatchObject({ updated: '2026-09-05', refresh: { windowDays: 42 } });
  });

  // `since` on the roster means when the decision was taken, and `enabled` is
  // the decision. Declared on the register, applied by the shared pipeline —
  // which is why the deployed door does it without knowing about a roster.
  it("dates a roster row's decision when the decision changes", async () => {
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/signal-panels.json',
            pointer: '/assets/meadow.example/enabled',
            expect: true,
            value: false,
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: true });
    const read = await getConfigDocument(env, 'config/signal-panels.json');
    expect((read.body as { assets: Record<string, { enabled: boolean; since: string }> }).assets[
      'meadow.example'
    ]).toMatchObject({ enabled: false, since: '2026-09-05' });
  });

  it('refuses a stale expect with what is actually there, and writes nothing', async () => {
    await seedTower('Somebody else');
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/tower.json',
            pointer: '/countdown/label',
            expect: 'Launch',
            value: 'Ship',
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: 'expect_mismatch' });
    if (result.ok === false && result.error === 'expect_mismatch') {
      expect(result.mismatches[0]).toMatchObject({
        file: 'config/tower.json',
        pointer: '/countdown/label',
        current: 'Somebody else',
      });
    }
    expect((await getConfigDocument(env, 'config/tower.json')).version).toBe(1);
  });

  // Every mapping field in `config/integrations.json` is sparse — the key is
  // absent until an operator maps the asset. `expectAbsent` is the guard for a
  // key that is not there, and it creates that one declared optional field and
  // nothing above it.
  it('writes the first value into a field nothing had written yet', async () => {
    await seedIntegrations();
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/integrations.json',
            pointer: '/assets/meadow.example/ga4/propertyId',
            expectAbsent: true,
            value: '123456789',
          },
        ],
        actor: ACTOR,
        slug: 'map-the-property',
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: true, applied: 1 });
    const read = await getConfigDocument(env, 'config/integrations.json');
    const ga4 = (read.body as { assets: Record<string, { ga4: Record<string, unknown> }> }).assets[
      'meadow.example'
    ]!.ga4;
    expect(ga4).toMatchObject({ status: 'live', propertyId: '123456789' });
  });

  it('refuses an empty string as the guard for a key that is not there', async () => {
    await seedIntegrations();
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/integrations.json',
            pointer: '/assets/meadow.example/ga4/propertyId',
            expect: '',
            value: '123456789',
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: 'expect_mismatch' });
    if (result.ok === false && result.error === 'expect_mismatch') {
      expect(result.mismatches[0]).toMatchObject({ expect: '', current: null, absent: true });
    }
  });

  it('refuses a first write onto a field that is already filled in', async () => {
    await seedIntegrations();
    const first = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/integrations.json',
            pointer: '/assets/meadow.example/ga4/propertyId',
            expectAbsent: true,
            value: '123456789',
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(first).toMatchObject({ ok: true });

    const second = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/integrations.json',
            pointer: '/assets/meadow.example/ga4/propertyId',
            expectAbsent: true,
            value: '444555666',
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(second).toMatchObject({ ok: false, error: 'expect_mismatch' });
    if (second.ok === false && second.error === 'expect_mismatch') {
      expect(second.mismatches[0]).toMatchObject({
        expectAbsent: true,
        current: '123456789',
        absent: false,
      });
    }
  });

  // A mapping field can be taken back off: `""` is a blank string, not
  // removal, so the delete is licensed at the same pointer `expectAbsent` is,
  // by the same predicate.
  it('takes a mapping back off, and leaves the rest of the row alone', async () => {
    await seedIntegrations();
    const wrote = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/integrations.json',
            pointer: '/assets/meadow.example/ga4/propertyId',
            expectAbsent: true,
            value: '123456789',
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(wrote).toMatchObject({ ok: true });

    const removed = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-delete',
            file: 'config/integrations.json',
            pointer: '/assets/meadow.example/ga4/propertyId',
            expect: '123456789',
          },
        ],
        actor: ACTOR,
        slug: 'unmap-the-property',
      },
      NOW,
    );
    expect(removed).toMatchObject({ ok: true, applied: 1 });

    const read = await getConfigDocument(env, 'config/integrations.json');
    // The KEY is gone rather than blank: an absent field is what the collector
    // reads as "fall back to the credential's own property map".
    expect(
      (read.body as { assets: Record<string, { ga4: Record<string, unknown> }> }).assets[
        'meadow.example'
      ]!.ga4,
    ).toEqual({ status: 'live', note: 'Collector proved it.', since: '2026-07-29' });
  });

  it('refuses a removal whose value somebody else has already moved', async () => {
    await seedIntegrations();
    await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/integrations.json',
            pointer: '/assets/meadow.example/ga4/propertyId',
            expectAbsent: true,
            value: '444555666',
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-delete',
            file: 'config/integrations.json',
            pointer: '/assets/meadow.example/ga4/propertyId',
            expect: '123456789',
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: 'expect_mismatch' });
    if (result.ok === false && result.error === 'expect_mismatch') {
      expect(result.mismatches[0]).toMatchObject({ expect: '123456789', current: '444555666' });
    }
  });

  it('will not remove a required field, or anything deeper than one field', async () => {
    await seedIntegrations();
    const before = (await getConfigDocument(env, 'config/integrations.json')).body;
    for (const pointer of [
      '/assets/meadow.example/ga4/status',
      '/assets/meadow.example/ga4/nested/propertyId',
    ]) {
      const result = await applyConfigOps(
        env,
        {
          ops: [
            { kind: 'file-json-delete', file: 'config/integrations.json', pointer, expect: 'live' },
          ],
          actor: ACTOR,
        },
        NOW,
      );
      expect(result).toMatchObject({ ok: false, error: 'invalid_changeset' });
    }
    expect((await getConfigDocument(env, 'config/integrations.json')).body).toEqual(before);
  });

  it('will not invent a row, a required field or a parent on the way', async () => {
    await seedIntegrations();
    const before = (await getConfigDocument(env, 'config/integrations.json')).body;
    for (const pointer of [
      '/assets/meadow.example/clarity',
      '/assets/meadow.example/ga4/status',
      '/assets/meadow.example/ga4/nested/propertyId',
    ]) {
      const result = await applyConfigOps(
        env,
        {
          ops: [
            { kind: 'file-json-set', file: 'config/integrations.json', pointer, expectAbsent: true, value: 'live' },
          ],
          actor: ACTOR,
        },
        NOW,
      );
      expect(result).toMatchObject({ ok: false, error: 'invalid_changeset' });
      if (result.ok === false && result.error === 'invalid_changeset') {
        expect(result.detail).toContain('declared OPTIONAL field');
      }
    }
    expect((await getConfigDocument(env, 'config/integrations.json')).body).toEqual(before);
  });

  it('refuses a stale version before it looks at a single op', async () => {
    await seedTower();
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/tower.json',
            pointer: '/countdown/label',
            expect: 'Launch',
            value: 'Ship',
          },
        ],
        expectVersions: { 'config/tower.json': 7 },
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: 'version_mismatch' });
    if (result.ok === false && result.error === 'version_mismatch') {
      expect(result.files[0]).toMatchObject({ expected: 7, observed: 1 });
    }
  });

  it('refuses an op the declarations do not license', async () => {
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/counters.json',
            pointer: '/assets/meadow.example/cards/0/label',
            expect: 'anything',
            value: 'anything else',
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: 'invalid_changeset' });
  });

  it('refuses a store column by name — that write has its own route', async () => {
    const result = await applyConfigOps(
      env,
      {
        ops: [
          { kind: 'store-asset-set', asset: 'meadow.example', column: 'status', expect: 'live', value: 'retired' },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    // The refusal is the route the write belongs to.
    expect(result).toMatchObject({
      ok: false,
      error: 'store_op_not_accepted',
      detail: 'Store columns save through PATCH /api/assets/:id',
    });
  });

  it('refuses a change with no actor — an audit row with no name is not one', async () => {
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/tower.json',
            pointer: '/countdown/label',
            expect: 'Launch',
            value: 'Ship',
          },
        ],
        actor: '  ',
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: 'invalid_changeset' });
  });

  it('lands several files together or not at all', async () => {
    // An asset is born into three registers at once. One stale op refuses the
    // whole set, and neither document moves.
    await seedConfigDocuments(
      env,
      {
        documents: {
          'config/tower.json': { countdown: { label: 'Launch', target: '2026-10-01' } },
          'config/signal-panels.json': { refresh: { windowDays: 35 }, assets: {} },
        },
        actor: 'config:seed',
      },
      NOW,
    );
    const result = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/tower.json',
            pointer: '/countdown/label',
            expect: 'Launch',
            value: 'Ship',
          },
          {
            kind: 'file-json-set',
            file: 'config/signal-panels.json',
            pointer: '/refresh/windowDays',
            expect: 999,
            value: 20,
          },
        ],
        actor: ACTOR,
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: 'expect_mismatch' });
    expect((await getConfigDocument(env, 'config/tower.json')).body).toMatchObject({
      countdown: { label: 'Launch' },
    });
    expect((await getConfigDocument(env, 'config/signal-panels.json')).body).toMatchObject({
      refresh: { windowDays: 35 },
    });
  });
});

describe('what the collectors read once it is seeded', () => {
  it('hands the stored document to the lanes that take one, and says so per file', async () => {
    await seedConfigDocuments(
      env,
      {
        documents: {
          'config/counters.json': { assets: { 'meadow.example': { heading: 'Stored', cards: [] } } },
          'config/pull.json': [{ asset: 'meadow.example', enabled: false, mode: 'prometheus' }],
          'config/integrations.json': { catalog: [], assets: { 'meadow.example': {} } },
        },
        actor: 'config:seed',
      },
      NOW,
    );
    forgetConfigCache();
    const { documents, sources } = await readCollectorConfigs(env);
    expect(documents['config/counters.json']).toMatchObject({ assets: { 'meadow.example': { heading: 'Stored' } } });
    expect(documents['config/pull.json']).toHaveLength(1);
    expect(documents['config/integrations.json']).toMatchObject({
      assets: { 'meadow.example': {} },
    });
    expect(sources).toMatchObject({
      'config/counters.json': 'store',
      'config/pull.json': 'store',
      'config/integrations.json': 'store',
      // Seeded nothing, so still the compiled copy — and a mixed install is the
      // ordinary one, which is why the answer is per file rather than per run.
      'config/serp-panel.json': 'file',
      'config/ga4-custom-dimensions.json': 'file',
      'config/constants.json': 'file',
    });
  });

  it('falls back to the compiled copy when the stored shape is wrong', async () => {
    await seedConfigDocuments(
      env,
      { documents: { 'config/pull.json': { notAnArray: true } }, actor: 'config:seed' },
      NOW,
    );
    forgetConfigCache();
    const { documents, sources } = await readCollectorConfigs(env, ['config/pull.json']);
    expect(documents['config/pull.json']).toBeUndefined();
    // And the run says `file`, because the file is what it ran on.
    expect(sources['config/pull.json']).toBe('file');
  });
});

describe('what a completion line says about config', () => {
  it('names only the files the lane read, and never a document', () => {
    expect(
      configSourceLine(
        { 'config/integrations.json': 'store', 'config/pull.json': 'file' },
        ['config/integrations.json'],
      ),
    ).toEqual({ configSource: { 'config/integrations.json': 'store' } });
  });

  it('says nothing at all when the caller resolved nothing', () => {
    // Every suite in this directory states its own config; a run that read
    // neither the store nor a file must not claim on a log line that it did.
    expect(configSourceLine(undefined, ['config/integrations.json'])).toEqual({});
    expect(configSourceLine({}, ['config/integrations.json'])).toEqual({});
  });
});

describe('the listing', () => {
  it('says what is seeded and what is not', async () => {
    await seedTower();
    const listed = await listConfigDocuments(env);
    expect(listed.documents).toEqual([
      { file: 'config/tower.json', version: 1, updatedAt: new Date(NOW).toISOString(), updatedBy: 'config:seed' },
    ]);

    const reads = await getConfigDocuments(env, CONFIG_DOCUMENT_FILES);
    const unseeded = reads.filter((read) => read.source !== 'store').map((read) => read.file);
    expect(unseeded).not.toContain('config/tower.json');
    expect(unseeded).toContain('config/constants.json');
  });
});
