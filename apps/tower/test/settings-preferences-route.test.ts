// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { WorkspaceStore } from '@noticeos/postgres';
import { handleStoredRead } from '../worker/stored-read-route';
import type { TowerConfig } from '../worker/config-source';

const state = vi.hoisted(() => ({ saved: false as boolean | null }));
vi.mock('../worker/config-source', async importOriginal => ({
  ...await importOriginal<typeof import('../worker/config-source')>(),
  timeZoneEverSaved: async () => state.saved,
}));

it('projects clock and rate without constructing the full settings payload', async () => {
  const config = vi.fn(async () => ({ osTimeZone: 'UTC', operatorRateUsdPerMin: 3.5 }) as TowerConfig);
  const deps = { store: {} as WorkspaceStore, config, compiledTimeZone: 'UTC' };
  state.saved = false;
  const response = await handleStoredRead(new Request('https://tower.example/api/settings?view=preferences'), deps);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ clock: { owner: 'config/constants.json', timeZone: 'UTC', chosen: false }, operatorRateUsdPerMin: 3.5 });
  state.saved = null;
  const unknown = await handleStoredRead(new Request('https://tower.example/api/settings?view=preferences'), deps);
  expect((await unknown?.json()).clock.chosen).toBe(true);
  const before = config.mock.calls.length;
  for (const suffix of ['?view=other', '?view=preferences&view=preferences', '?view=preferences&asset=example']) {
    expect((await handleStoredRead(new Request(`https://tower.example/api/settings${suffix}`), deps))?.status).toBe(400);
  }
  expect(config).toHaveBeenCalledTimes(before);
});
