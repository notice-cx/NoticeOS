// EVERY INGEST READ OF THE SITE LIST ASKS POSTGRES (bead ro-ujb9.76.4.2).
//
// Collectors list sites by their stored place.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { assetKnown, knownAssetIds } from '../src/asset-registry.js';
import { loadBingPortfolioCandidates } from '../src/bing-client.js';
import { clarityCandidates } from '../src/clarity-dumps.js';
import { dataForSeoCandidates } from '../src/dataforseo-dumps.js';
import { readOsAssetId } from '../src/os-asset.js';
import { posthogCandidates } from '../src/posthog-dumps.js';
import { TEST_OS_ASSET } from './invented-sites';
import { addSites, inSiteOrder, storeSites } from './sites';

describe('the site list is read on Postgres', () => {
  it('knows stored sites and every stored id', async () => {
    expect(await assetKnown(env.STORE, 'nosh.example')).toBe(true);
    expect(await assetKnown(env.STORE, 'never-added.example')).toBe(false);
    expect([...(await knownAssetIds(env.STORE))].sort()).toEqual((await storeSites()).map((site) => site.id));
  });

  it('names the OS by its stored row', async () => {
    expect(await readOsAssetId(env)).toBe(TEST_OS_ASSET);
  });

  it('collects the active stored sites', async () => {
    for (const candidates of [
      await loadBingPortfolioCandidates(env.STORE),
      await clarityCandidates(env.STORE),
      await dataForSeoCandidates(env.STORE),
      await posthogCandidates(env.STORE),
    ]) {
      expect(candidates.map((candidate) => candidate.asset)).toContain('meals.example');
    }
    expect(await dataForSeoCandidates(env.STORE, 'meals.example')).toEqual([{ asset: 'meals.example', domain: 'meals.example' }]);
  });

  it('lists sites by their stored place: the order they were added in, whatever their instants and ids', async () => {
    // Neither the instant a site was added nor its id orders the list: the
    // latest instant comes first here, and the ids are out of order.
    await addSites([
      { id: 'zeta.example', displayName: 'Zeta', status: 'live', createdAt: '2026-08-03T00:00:00.000Z' },
      { id: 'alpha.example', displayName: 'Alpha', status: 'live', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'beta.example', displayName: 'Beta', status: 'live', createdAt: '2026-08-02T00:00:00.000Z' },
      { id: 'beta-2.example', displayName: 'Beta two', status: 'live', createdAt: '2026-08-02T00:00:00.000Z' },
    ]);
    const added = ['zeta.example', 'alpha.example', 'beta.example', 'beta-2.example'];
    for (const candidates of [
      await loadBingPortfolioCandidates(env.STORE),
      await clarityCandidates(env.STORE),
      await dataForSeoCandidates(env.STORE),
      await posthogCandidates(env.STORE),
    ]) {
      const listed = candidates.map((candidate) => candidate.asset);
      expect(listed).toEqual(await inSiteOrder(listed));
      expect(listed.filter((id) => added.includes(id))).toEqual(added);
      expect(listed.slice(-4)).toEqual(added);
    }
  });
});
