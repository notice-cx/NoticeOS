import { createExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import IngestWorker from '../src/index.js';
import { TOWER_CONFIG_FILES } from '../../../packages/contract/src/configuration.mjs';

it('standalone config RPC cannot downgrade an original hosted proof into legacy capabilities', async () => {
  const reads: PropertyKey[] = [];
  const bindings = new Proxy({ NOTICEOS_WORKSPACE_PROFILE: 'standalone' }, {
    get(target, key) {
      reads.push(key);
      if (key === 'NOTICEOS_WORKSPACE_PROFILE') return target.NOTICEOS_WORKSPACE_PROFILE;
      throw new Error('Unexpected legacy capability access.');
    },
  });
  const worker = new IngestWorker(createExecutionContext(), bindings as IngestEnv);
  const proof = new Request('https://fixture.example.test/api/config');
  await expect(worker.getConfigDocuments(Object.values(TOWER_CONFIG_FILES), proof)).rejects.toThrow('Workspace entry is unavailable');
  await expect(worker.applyConfigOps({ ops: [], actor: 'forged' }, proof)).rejects.toThrow('Workspace entry is unavailable');
  expect(reads).toEqual(['NOTICEOS_WORKSPACE_PROFILE', 'NOTICEOS_WORKSPACE_PROFILE']);
});

it('missing or unknown server profile refuses config, other RPC, HTTP and cron before binding access', async () => {
  for (const profile of [undefined, 'unknown', ' hosted ']) {
    const reads: PropertyKey[] = [];
    const bindings = new Proxy({}, {
      get(_target, key) {
        reads.push(key);
        if (key === 'NOTICEOS_WORKSPACE_PROFILE') return profile;
        throw new Error('Unexpected capability access.');
      },
    });
    const worker = new IngestWorker(createExecutionContext(), bindings as IngestEnv);
    await expect(worker.getConfigDocuments([])).rejects.toThrow('Workspace profile is unavailable');
    await expect(worker.applyConfigOps({ ops: [], actor: 'forged' })).rejects.toThrow('Workspace profile is unavailable');
    await expect(worker.ga4Realtime()).rejects.toThrow('Workspace profile is unavailable');
    await expect(worker.fetch(new Request('https://fixture.example.test/api/pulse'))).rejects.toThrow('Workspace profile is unavailable');
    await expect(worker.scheduled({ cron: '0 * * * *' } as ScheduledController)).rejects.toThrow('Workspace profile is unavailable');
    expect(reads).toEqual(Array(5).fill('NOTICEOS_WORKSPACE_PROFILE'));
  }
});

it('platform housekeeping is a credential-free no-op outside hosted profile', async () => {
  for (const profile of ['standalone', 'demo']) {
    const reads: PropertyKey[] = [];
    const bindings = new Proxy({}, { get(_target, key) {
      reads.push(key);
      if (key === 'NOTICEOS_WORKSPACE_PROFILE') return profile;
      throw new Error('Unexpected credential or operational capability access.');
    } });
    const worker = new IngestWorker(createExecutionContext(), bindings as IngestEnv);
    await worker.scheduled({ cron: '7 * * * *' } as ScheduledController);
    expect(reads).toEqual(['NOTICEOS_WORKSPACE_PROFILE']);
  }
});
