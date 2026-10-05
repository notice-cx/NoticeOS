// THE ORDER OF SITES IS A FACT THE STORE KEEPS (bead ro-ujb9.76.52).
//
// Each site stores its place in the list (`list_position`), and every list of
// sites orders by it (`SITE_ORDER`, @noticeos/contract site-order.ts). Pinned
// here on the real store:
//   - the clean start preserves fixture order;
//   - a new site takes the next place, at the end, and two added at once take
//     two different places;
//   - retiring and restoring a site keeps its place;
//   - the one write that changes a place (`moveAsset`): the site takes the
//     place of the site it is moved onto, and the sites between close up;
//   - every moved site is stamped, and moves take turns with creates and moves.
//
// The moves use sites of their own, added at the end of the seeded list, so
// the seeded order every other file relies on is never moved.

import { env } from 'cloudflare:test';
import { TEST_SITES } from './invented-sites';
import { afterEach, describe, expect, it } from 'vitest';
import { createAsset, moveAsset, writeAssetColumn } from '../src/asset-state.js';
import { dataForSeoCandidates } from '../src/dataforseo-dumps.js';
import { reset } from './helpers.js';
import { listedSites, removeSites, siteInStore, storeSites } from './sites';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const LATER = Date.parse('2026-09-29T13:00:00.000Z');

afterEach(async () => {
  await reset();
  await removeSites((await storeSites()).map((site) => site.id).filter((id) => id.endsWith('.test')));
});

/** Each site's place, by id. */
async function places(): Promise<Map<string, number>> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{ asset_id: string; place: number }>(`SELECT asset_id, list_position::int AS place FROM noticeos.assets`),
  );
  return new Map(rows.map((row) => [row.asset_id, row.place]));
}

/** Add these sites through the product, one after another. */
async function created(ids: string[]): Promise<void> {
  for (const id of ids) {
    const result = await createAsset(env, { id, displayName: id, domain: id, status: 'live' }, NOW);
    expect(result.ok).toBe(true);
  }
}

/** The listed ids that end in `.test`, in list order. */
const ours = async (): Promise<string[]> => (await listedSites()).filter((id) => id.endsWith('.test'));

describe('a site keeps its place in the list', () => {
  it('the clean start lists the seeded sites in fixture order', async () => {
    const inserted = TEST_SITES.map((site) => site.id);
    expect(await listedSites()).toEqual(inserted);
    // Their ids and instants do not order them: several share one instant, and
    // the list is not in id order.
    expect(inserted).not.toEqual([...inserted].sort());
  });

  it('a new site is added at the end of the list', async () => {
    await created(['newest.test']);
    expect((await listedSites()).at(-1)).toBe('newest.test');
    expect((await dataForSeoCandidates(env.STORE)).at(-1)?.asset).toBe('newest.test');
  });

  it('two sites added at once take two different places, both after every site before them', async () => {
    const before = Math.max(...(await places()).values());
    const results = await Promise.all([
      createAsset(env, { id: 'first.test', displayName: 'First', domain: 'first.test' }, NOW),
      createAsset(env, { id: 'second.test', displayName: 'Second', domain: 'second.test' }, NOW),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    const now = await places();
    const [first, second] = [now.get('first.test')!, now.get('second.test')!];
    expect(first).not.toBe(second);
    expect(Math.min(first, second)).toBeGreaterThan(before);
    expect(new Set(await ours())).toEqual(new Set(['first.test', 'second.test']));
    expect((await listedSites()).slice(-2).sort()).toEqual(['first.test', 'second.test']);
  });

  it('retiring and restoring a site keeps its place', async () => {
    await created(['a.test', 'b.test', 'c.test']);
    const before = await places();
    const order = await listedSites();

    // Archive: nothing removes a site, so retiring it is its only way out.
    expect((await writeAssetColumn(env, { asset: 'b.test', column: 'status', value: 'retired' }, NOW)).ok).toBe(true);
    expect((await siteInStore('b.test'))?.status).toBe('retired');
    expect(await places()).toEqual(before);
    expect(await listedSites()).toEqual(order);

    expect((await writeAssetColumn(env, { asset: 'b.test', column: 'status', value: 'live' }, LATER)).ok).toBe(true);
    expect(await places()).toEqual(before);
    expect(await listedSites()).toEqual(order);
  });
});

describe('moveAsset — the one write that changes a place', () => {
  it.each([['a.test', 'd.test'], ['d.test', 'a.test']])('Undo restores the full span, including retired sites: %s to %s', async (asset, to) => {
    await created(['a.test', 'b.test', 'c.test', 'd.test']);
    await writeAssetColumn(env, { asset: 'b.test', column: 'status', value: 'retired' }, NOW);
    const before = await listedSites();
    const moved = await moveAsset(env, { asset, to }, LATER);
    if (!moved.ok || !moved.undoTo) throw new Error('Expected a reversible move');
    const undone = await moveAsset(env, { asset, to: moved.undoTo, expectRevision: moved.revision }, LATER);
    expect(undone.ok).toBe(true);
    expect(await listedSites()).toEqual(before);
  });

  it.each(['move', 'create'])('Undo refuses after a newer %s without changing the current order', async change => {
    await created(['a.test', 'b.test', 'c.test']);
    const moved = await moveAsset(env, { asset: 'a.test', to: 'c.test' }, LATER);
    if (!moved.ok || !moved.undoTo) throw new Error('Expected a reversible move');
    if (change === 'move') await moveAsset(env, { asset: 'c.test', to: 'b.test' }, LATER);
    else await created(['d.test']);
    const before = await storeSites();
    expect(await moveAsset(env, { asset: 'a.test', to: moved.undoTo, expectRevision: moved.revision }, LATER))
      .toEqual({ ok: false, error: 'expect_mismatch' });
    expect(await storeSites()).toEqual(before);
  });

  it('two simultaneous guarded moves cannot both replace the same order', async () => {
    await created(['a.test', 'b.test', 'c.test']);
    const state = await moveAsset(env, { asset: 'a.test', to: 'a.test' }, LATER);
    if (!state.ok) throw new Error('Expected an order revision');
    const results = await Promise.all([
      moveAsset(env, { asset: 'a.test', to: 'b.test', expectRevision: state.revision }, LATER),
      moveAsset(env, { asset: 'c.test', to: 'b.test', expectRevision: state.revision }, LATER),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: 'expect_mismatch' }]);
  });

  it('refuses a malformed revision before changing the store', async () => {
    const before = await storeSites();
    for (const expectRevision of [null, '', 'a'.repeat(63), 'G'.repeat(64), [], 3]) {
      expect(await moveAsset(env, { asset: 'a.test', to: 'b.test', expectRevision }, LATER))
        .toMatchObject({ ok: false, error: 'validation', issues: [{ path: 'expectRevision' }] });
    }
    expect(await storeSites()).toEqual(before);
  });

  it('moved down the list, a site takes the place of the site it is moved onto, and each site it passes moves up one', async () => {
    await created(['a.test', 'b.test', 'c.test', 'd.test']);
    const before = await places();

    const result = await moveAsset(env, { asset: 'a.test', to: 'c.test' }, LATER);
    expect(result).toEqual({ ok: true, asset: 'a.test', order: await listedSites(), revision: expect.stringMatching(/^[a-f0-9]{64}$/), undoTo: "b.test" });
    expect(await ours()).toEqual(['b.test', 'c.test', 'a.test', 'd.test']);
    const after = await places();
    expect(after.get('a.test')).toBe(before.get('c.test'));
    expect(after.get('b.test')).toBe(before.get('a.test'));
    expect(after.get('c.test')).toBe(before.get('b.test'));
    expect(after.get('d.test')).toBe(before.get('d.test'));
  });

  it('moved up the list, a site takes the place of the site it is moved onto, and each site it passes moves down one', async () => {
    await created(['a.test', 'b.test', 'c.test', 'd.test']);
    const before = await places();

    expect((await moveAsset(env, { asset: 'd.test', to: 'b.test' }, LATER)).ok).toBe(true);
    expect(await ours()).toEqual(['a.test', 'd.test', 'b.test', 'c.test']);
    const after = await places();
    expect(after.get('d.test')).toBe(before.get('b.test'));
    expect(after.get('b.test')).toBe(before.get('c.test'));
    expect(after.get('c.test')).toBe(before.get('d.test'));
    expect(after.get('a.test')).toBe(before.get('a.test'));
  });

  it('changes no other site, keeps the same set of places, and a gap stays where it was', async () => {
    await created(['a.test']);
    // A refused create has used a place: the list now has a gap after a.test.
    expect(await createAsset(env, { id: 'a.test', displayName: 'Again' }, NOW)).toEqual({ ok: false, error: 'asset_exists', asset: 'a.test', existingStatus: 'live' });
    await created(['b.test', 'c.test']);
    const before = await places();
    expect(before.get('b.test')! - before.get('a.test')!).toBe(2);

    expect((await moveAsset(env, { asset: 'c.test', to: 'a.test' }, LATER)).ok).toBe(true);
    const after = await places();
    expect(await ours()).toEqual(['c.test', 'a.test', 'b.test']);
    expect([...after.values()].sort((x, y) => x - y)).toEqual([...before.values()].sort((x, y) => x - y));
    for (const [id, place] of before) if (!id.endsWith('.test')) expect(after.get(id)).toBe(place);
    expect(after.get('c.test')).toBe(before.get('a.test'));
    expect(after.get('a.test')).toBe(before.get('b.test'));
    expect(after.get('b.test')).toBe(before.get('c.test'));
  });

  it('stamps only the sites whose place changed', async () => {
    await created(['a.test', 'b.test', 'c.test', 'd.test']);
    expect((await moveAsset(env, { asset: 'c.test', to: 'b.test' }, LATER)).ok).toBe(true);
    for (const id of ['a.test', 'b.test', 'c.test', 'd.test']) {
      const row = await siteInStore(id);
      expect(row?.updated_at).toBe(['b.test', 'c.test'].includes(id) ? '2026-09-29T13:00:00.000Z' : '2026-09-29T12:00:00.000Z');
    }
  });

  it('a site moved onto its own place changes nothing', async () => {
    await created(['a.test', 'b.test']);
    const before = await storeSites();
    const order = await listedSites();
    expect(await moveAsset(env, { asset: 'b.test', to: 'b.test' }, LATER)).toEqual({ ok: true, asset: 'b.test', order, revision: expect.stringMatching(/^[a-f0-9]{64}$/), undoTo: null });
    expect(await storeSites()).toEqual(before);
  });

  it('an unknown site is refused by its id, and nothing moves', async () => {
    await created(['a.test', 'b.test']);
    const order = await listedSites();
    expect(await moveAsset(env, { asset: 'never.test', to: 'a.test' }, LATER)).toEqual({ ok: false, error: 'unknown_asset', asset: 'never.test' });
    expect(await moveAsset(env, { asset: 'a.test', to: 'never.test' }, LATER)).toEqual({ ok: false, error: 'unknown_asset', asset: 'never.test' });
    expect(await listedSites()).toEqual(order);
  });

  it('a body without two site ids is refused, naming each missing one', async () => {
    const refused = await moveAsset(env, { asset: 'a.test' }, LATER);
    expect(refused).toMatchObject({ ok: false, error: 'validation' });
    expect(refused.ok === false && refused.error === 'validation' ? refused.issues.map((issue) => issue.path) : []).toEqual(['to']);
    expect(await moveAsset(env, 'a.test', LATER)).toMatchObject({ ok: false, error: 'validation' });
  });

  it('a move and a create at once take turns: the move holds and the new site is last', async () => {
    await created(['a.test', 'b.test', 'c.test']);
    const [moved, made] = await Promise.all([
      moveAsset(env, { asset: 'a.test', to: 'c.test' }, LATER),
      createAsset(env, { id: 'd.test', displayName: 'D', domain: 'd.test' }, LATER),
    ]);
    expect([moved.ok, made.ok]).toEqual([true, true]);
    expect(await ours()).toEqual(['b.test', 'c.test', 'a.test', 'd.test']);
    expect((await listedSites()).at(-1)).toBe('d.test');
    const all = [...(await places()).values()];
    expect(new Set(all).size).toBe(all.length);
  });

  it('two moves at once take turns, and every place stays one site\'s', async () => {
    await created(['a.test', 'b.test', 'c.test', 'd.test']);
    const results = await Promise.all([
      moveAsset(env, { asset: 'a.test', to: 'b.test' }, LATER),
      moveAsset(env, { asset: 'c.test', to: 'd.test' }, LATER),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(await ours()).toEqual(['b.test', 'a.test', 'd.test', 'c.test']);
    const all = [...(await places()).values()];
    expect(new Set(all).size).toBe(all.length);

  });
});
