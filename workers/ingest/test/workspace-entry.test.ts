import { createExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import IngestWorker from '../src/index.js';
import { TOWER_CONFIG_FILES } from '../../../packages/contract/src/configuration.mjs';
import { WORKSPACE_SELECTION_HEADER } from '../../../scripts/browser-request-policy.mjs';

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

it.each([
  { origin: 'http://tower.local:5173', setup: { NOTICEOS_LOCAL_TOWER_ORIGIN: 'http://tower.local:5173' } },
  { origin: 'http://127.0.0.1:5173', setup: { NOTICEOS_LOCAL_TOWER_ORIGIN: undefined, NOTICEOS_GOOGLE_SETUP_REQUIRED: true } },
])('declines both Google OAuth starts before credentials at $origin outside setup', async ({ origin, setup }) => {
  const configured: Record<string, unknown> = {
    NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: origin, ...setup,
  };
  const bindings = new Proxy(configured, { get(target, key) {
    if (typeof key === 'string' && Object.hasOwn(target, key)) return target[key];
    throw new Error('Unexpected access to a credential or database.');
  } });
  const worker = new IngestWorker(createExecutionContext(), bindings as unknown as IngestEnv);
  const selection = { [WORKSPACE_SELECTION_HEADER]: crypto.randomUUID() };
  for (const provider of ['google', 'adsense'] as const) {
    const url = `${origin}/api/integrations/${provider}/oauth/start`;
    const input = provider === 'google' ? { origin } : { origin, provider };
    const submit = (source: string) => worker.beginGoogleOAuth(input, new Request(url, {
      method: 'POST', headers: { origin: source, ...selection },
    }));
    await expect(submit(origin)).resolves.toEqual({ ok: false, error: 'redirect_unusable' });
    await expect(submit('http://another.local:5173')).rejects.toThrow();
  }
});
