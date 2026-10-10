// An asset row is born. This RPC is the write plumbing under the Tower's Add
// a site. Nothing removes a site: the model gives the application no DELETE on
// one (db/postgres/README.md), and a mistaken add is archived like any site.
//
// Called as functions rather than through a route: they have no HTTP door. The
// Tower reaches them over the private INGEST Service Binding (index.ts's
// `createAsset`), which is one `return` away from these. The real store is the
// point — the CHECK constraints, the foreign keys and the insert that does
// nothing on a conflict are facts about the store, not about a mock.

import { env } from 'cloudflare:test';
import type { Transaction, WorkspaceStore } from '@noticeos/postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAsset, writeAssetColumn } from '../src/asset-state.js';
import { reset } from './helpers.js';
import { storeSites, removeSites, siteInStore } from './sites';

const NEW_ID = 'brandnew.test';
const NOW = Date.parse('2026-09-04T12:00:00.000Z');

beforeEach(reset);

// Every asset these tests invent is removed again, from the store, so the
// seeded list is what the next test starts from.
afterEach(async () => {
  await reset();
  await removeSites((await storeSites()).map((site) => site.id).filter((id) => id.endsWith('.test')));
});

/** The stored row for `id`, or null when it does not exist. */
const stored = (id: string) => siteInStore(id);

describe('createAsset — what a wizard may bring into being', () => {
  it('writes the row, stamps both timestamps from the runtime clock, and reads it back', async () => {
    const result = await createAsset(
      env,
      { id: NEW_ID, displayName: 'Brand New', domain: 'brandnew.test' },
      NOW,
    );

    expect(result).toEqual({
      ok: true,
      asset: {
        id: NEW_ID,
        domain: 'brandnew.test',
        displayName: 'Brand New',
        // docs/14-design.md § Operator flows: a new asset starts onboarding, observing only.
        status: 'onboarding',
        senseOnly: 1,
        isOs: 0,
        createdAt: '2026-09-04T12:00:00.000Z',
        updatedAt: '2026-09-04T12:00:00.000Z',
      },
    });
    expect(await stored(NEW_ID)).toMatchObject({
      display_name: 'Brand New',
      status: 'onboarding',
      sense_only: 1,
      is_os: 0,
      created_at: '2026-09-04T12:00:00.000Z',
      updated_at: '2026-09-04T12:00:00.000Z',
    });
  });

  it('takes an explicit stage and posture when the wizard asked for them', async () => {
    const result = await createAsset(
      env,
      { id: NEW_ID, displayName: 'Brand New', status: 'live', senseOnly: 0 },
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(await stored(NEW_ID)).toMatchObject({
      status: 'live',
      sense_only: 0,
      domain: null,
    });
  });

  // asset #0 is a fact about this repo, and it decides which asset the Tower
  // renders first. No body may claim it.
  it('never mints a second asset #0, whatever the body says', async () => {
    await createAsset(env, { id: NEW_ID, displayName: 'Brand New', isOs: 1 } as never, NOW);
    expect(await stored(NEW_ID)).toMatchObject({ is_os: 0 });
  });

  it('refuses a duplicate id without touching the row that exists', async () => {
    const before = await stored('meals.example');
    const result = await createAsset(
      env,
      { id: 'meals.example', displayName: 'Something Else', status: 'retired' },
      NOW,
    );

    expect(result).toEqual({ ok: false, error: 'asset_exists', asset: 'meals.example', existingStatus: before!.status });
    expect(await stored('meals.example')).toEqual(before);
  });

  // One site per domain (0001_baseline.sql `assets_one_per_domain`): a second
  // id on a domain a site already holds is that site, and the answer names it.
  it('refuses a domain another site holds, naming that site, and writes nothing', async () => {
    const holder = (await storeSites()).find((site) => site.domain !== null && site.domain !== site.id);
    expect(holder).toBeDefined();
    const result = await createAsset(env, { id: 'second.test', displayName: 'Second', domain: holder!.domain }, NOW);
    expect(result).toEqual({ ok: false, error: 'asset_exists', asset: holder!.id, existingStatus: holder!.status });
    expect(await stored('second.test')).toBeNull();
  });

  it.each(['retired', 'live'] as const)('returns the domain holder lifecycle %s without changing it', async status => {
    await createAsset(env, { id: NEW_ID, domain: 'held.test', displayName: 'Held', status }, NOW);
    const before = await stored(NEW_ID);
    expect(await createAsset(env, { id: 'duplicate.test', domain: 'held.test', displayName: 'Again' }, NOW))
      .toEqual({ ok: false, error: 'asset_exists', asset: NEW_ID, existingStatus: status });
    expect(await stored(NEW_ID)).toEqual(before);
    expect(await stored('duplicate.test')).toBeNull();
  });

  it('names the field it refused, and writes nothing', async () => {
    const cases: [unknown, string][] = [
      [{ displayName: 'No Id' }, 'id'],
      [{ id: 'NOT VALID', displayName: 'Bad Id' }, 'id'],
      [{ id: NEW_ID }, 'displayName'],
      [{ id: NEW_ID, displayName: '   ' }, 'displayName'],
      [{ id: NEW_ID, displayName: 'x'.repeat(81) }, 'displayName'],
      [{ id: NEW_ID, displayName: 'Brand New', domain: 'https://brandnew.test/x' }, 'domain'],
      [{ id: NEW_ID, displayName: 'Brand New', status: 'shipping' }, 'status'],
      [{ id: NEW_ID, displayName: 'Brand New', senseOnly: 2 }, 'senseOnly'],
    ];
    for (const [body, field] of cases) {
      const result = await createAsset(env, body, NOW);
      expect(result.ok, JSON.stringify(body)).toBe(false);
      if (result.ok || result.error !== 'validation') continue;
      expect(result.issues.map((issue) => issue.path)).toContain(field);
    }
    expect(await stored(NEW_ID)).toBeNull();
  });

  // Add a site shows the first refusal beside its Domain input. It names the
  // field by the label a person reads, in the words every register refusal
  // uses (`fieldRefusal`), and says site — never the body's key or a system
  // noun.
  it('words each refusal by the field’s label and says site, keeping the key as the path', async () => {
    const cases: [unknown, string, string | RegExp][] = [
      [{ id: 'NOT VALID', displayName: 'Bad Id' }, 'id', 'Site must be a site id'],
      [{ displayName: 'No Id' }, 'id', 'Site is required'],
      [{ id: NEW_ID, displayName: '   ' }, 'displayName', 'Display name is required'],
      [{ id: NEW_ID, displayName: 'x'.repeat(81) }, 'displayName', 'Display name must be 80 characters or fewer'],
      [{ id: NEW_ID, displayName: 'Brand New', domain: 'https://brandnew.test/x' }, 'domain', 'Domain must be a hostname such as example.com'],
      [{ id: NEW_ID, displayName: 'Brand New', status: 'shipping' }, 'status', /^Lifecycle stage must be one of pre-launch/],
      [{ id: NEW_ID, displayName: 'Brand New', senseOnly: 2 }, 'senseOnly', 'Automation must be at most 1'],
    ];
    for (const [body, path, message] of cases) {
      const result = await createAsset(env, body, NOW);
      if (result.ok || result.error !== 'validation') throw new Error(`${JSON.stringify(body)} was not refused`);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({ path, message });
      expect(result.issues[0]!.message).not.toMatch(/\bproperty\b|\basset\b/i);
    }
    // A domain that is only padded is trimmed, as it always was.
    const padded = await createAsset(env, { id: NEW_ID, displayName: ' Brand New ', domain: ' brandnew.test ' }, NOW);
    expect(padded).toMatchObject({ ok: true, asset: { displayName: 'Brand New', domain: 'brandnew.test' } });
  });

  it('refuses a body that is not a JSON object', async () => {
    for (const body of ['nope', [1, 2], null, 7]) {
      const result = await createAsset(env, body, NOW);
      expect(result.ok).toBe(false);
    }
  });
});

// Failed site writes leave the transaction unchanged.

/** This test's env, its store changed by `change` around each unit of work. */
function withStore(change: (store: WorkspaceStore) => WorkspaceStore): IngestEnv {
  return { ...env, STORE: change(env.STORE) };
}

/** A store whose statements naming the site table fail, as a store refusing them would. */
const refusingSiteStatements = (store: WorkspaceStore): WorkspaceStore => ({
  ...store,
  write: (work) =>
    store.write((tx) =>
      work({
        ...tx,
        query: (async (sql: string, params?: Parameters<Transaction['query']>[1]) => {
          if (/^\s*(INSERT INTO|UPDATE) noticeos\.assets\b/.test(sql)) throw new Error('Postgres refused the site row');
          return tx.query(sql, params);
        }) as Transaction['query'],
      }),
    ),
});

/** Abort a real transaction after its work has run, before it commits. */
const abortingTransaction = (store: WorkspaceStore): WorkspaceStore => ({
  ...store,
  write: (work) =>
    store.write(async (tx) => {
      await work(tx);
      throw new Error('the Postgres transaction aborted');
    }),
});

describe('a failed site transaction', () => {
  it('a failed Postgres statement leaves sites unchanged', async () => {
    await expect(createAsset(withStore(refusingSiteStatements), { id: NEW_ID, displayName: 'Brand New' }, NOW)).rejects.toThrow();
    expect(await stored(NEW_ID)).toBeNull();

    const before = await stored('meals.example');
    await expect(
      writeAssetColumn(withStore(refusingSiteStatements), { asset: 'meals.example', column: 'status', value: 'live' }, NOW),
    ).rejects.toThrow();
    expect(await stored('meals.example')).toEqual(before);
  });

  it('a failed transaction leaves no new site and a later retry can create it', async () => {
    await expect(createAsset(withStore(abortingTransaction), { id: NEW_ID, displayName: 'Brand New' }, NOW)).rejects.toThrow(
      'the Postgres transaction aborted',
    );
    expect(await stored(NEW_ID)).toBeNull();

    // A later retry creates the site normally.
    expect(await createAsset(env, { id: NEW_ID, displayName: 'Brand New', status: 'live' }, NOW + 1000)).toMatchObject({ ok: true });
    expect(await stored(NEW_ID)).toMatchObject({ status: 'live', updated_at: new Date(NOW + 1000).toISOString() });
  });
});
