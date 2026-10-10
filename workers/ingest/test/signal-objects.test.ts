import { env } from 'cloudflare:test';
import { openWorkspaceStore, type WorkspaceStore } from '@noticeos/postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signalObjectScope } from '../src/signal-objects.js';
import { archiveCollectedDump } from '../src/signal-dumps.js';
import { dataForSeoCheckpointKey } from '../src/dataforseo-dumps.js';
import { readPanelManifest, readPanelObject } from '../src/panel-source.js';
import { asOwner, emptyTables, reset, storeArchiveRun } from './helpers.js';

beforeEach(reset);
const INPUT = {
  provider: 'google' as const,
  target: { asset: 'meadow.example', integration: 'gsc' as const, credentialRef: 'fixture', propertyRef: 'sc-domain:meadow.example' },
  report: 'query', reportDate: '2026-09-01', requestedAt: '2026-09-02T12:15:00.000Z',
  dataState: 'provider-final' as const,
  collected: { pages: [{ request: {}, response: { rows: [{ clicks: 7 }] } }], providerRows: 1, providerTruncated: false },
};

async function secondWorkspace(work: (target: IngestEnv) => Promise<void>): Promise<void> {
  await env.STORE.workspaceId();
  const workspaceId = crypto.randomUUID();
  await asOwner(`INSERT INTO noticeos.workspaces (workspace_id, slug, display_name)
    VALUES ('${workspaceId}', 'objects-fixture', 'Objects fixture');
    INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, list_position)
    VALUES ('${workspaceId}', 'meadow.example', 'meadow.example', 'Meadow', 'live', 1);`);
  const store = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId });
  try { await work({ ...env, STORE: store }); }
  finally {
    await store.close();
    await emptyTables(['archive_runs', 'archive_objects']);
    await asOwner(['assets', 'workspace_counters', 'workspaces']
      .map((table) => `DELETE FROM noticeos.${table} WHERE workspace_id = '${workspaceId}';`).join('\n'));
  }
}

async function manifestObject(store: WorkspaceStore, key: string): Promise<void> {
  await store.write((tx) => tx.execute(`INSERT INTO noticeos.archive_objects
    (workspace_id, object_key, content_sha256, object_bytes, first_stored_at)
    VALUES ($1, $2, $3, 1, now())`, [tx.workspaceId, key, 'a'.repeat(64)]));
}

describe('workspace-owned signal objects', () => {
  it('keeps identical assets, report dates and bytes separate in one bucket and database', async () => {
    await secondWorkspace(async (other) => {
      const first = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'hosted' };
      const second = { ...other, NOTICEOS_WORKSPACE_PROFILE: 'hosted' };
      const a = await archiveCollectedDump(first, INPUT);
      const b = await archiveCollectedDump(second, INPUT);
      expect(a.objectKey).not.toBe(b.objectKey);
      expect(a.objectKey).toMatch(/^workspaces\/[0-9a-f-]+\/raw\/google\/gsc\//);
      expect((await readPanelManifest(first, 'meadow.example')).map((row) => row.objectKey)).toEqual([a.objectKey]);
      expect((await readPanelManifest(second, 'meadow.example')).map((row) => row.objectKey)).toEqual([b.objectKey]);
      expect(await readPanelObject(first, a.objectKey!)).toBe(await readPanelObject(second, b.objectKey!));
      const get = vi.spyOn(env.RAW_SIGNALS, 'get');
      try {
        expect(await readPanelObject(first, b.objectKey!)).toBeNull();
        expect(await readPanelObject(second, a.objectKey!)).toBeNull();
        expect(get).not.toHaveBeenCalled();
      } finally { get.mockRestore(); }
      const repeat = await archiveCollectedDump(first, INPUT);
      expect(repeat).toMatchObject({ status: 'unchanged', objectKey: a.objectKey });
    });
  });

  it('requires manifest membership even for a valid own prefix; forged foreign rows cannot enable reads', async () => {
    const target = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'hosted' };
    const scope = await signalObjectScope(target);
    const foreign = `workspaces/${crypto.randomUUID()}/raw/google/gsc/meadow.example/query/test.json.gz`;
    await storeArchiveRun({
      id: crypto.randomUUID(), asset: 'meadow.example', integration: 'gsc', report: 'query',
      credential_ref: 'fixture', property_ref: 'sc-domain:meadow.example', report_date: INPUT.reportDate,
      finished_at: INPUT.requestedAt, status: 'success', data_state: 'provider-final', provider_rows: 1,
      request_count: 1, provider_truncated: false, object_key: foreign,
      content_sha256: 'a'.repeat(64), object_bytes: 1,
    });
    expect(await readPanelManifest(target, 'meadow.example')).toEqual([]);
    const get = vi.spyOn(env.RAW_SIGNALS, 'get');
    try {
      expect(await readPanelObject(target, foreign)).toBeNull();
      expect(await readPanelObject(target, scope.key('raw/google/unrecorded.json.gz'))).toBeNull();
      expect(get).not.toHaveBeenCalled();
    } finally { get.mockRestore(); }
  });

  it('keeps legacy archive evidence readable only through explicit standalone and its RLS owner', async () => {
    const key = 'signals/meadow.example/legacy.json.gz';
    await manifestObject(env.STORE, key);
    const gz = new Blob([JSON.stringify({ historical: 7 })]).stream().pipeThrough(new CompressionStream('gzip'));
    await env.RAW_SIGNALS.put(key, await new Response(gz).arrayBuffer());
    expect(await readPanelObject(env, key)).toBe('{"historical":7}');
    await secondWorkspace(async (other) => {
      const get = vi.spyOn(env.RAW_SIGNALS, 'get');
      try {
        expect(await readPanelObject(other, key)).toBeNull();
        for (const profile of ['hosted', 'demo']) {
          expect(await readPanelObject({ ...env, NOTICEOS_WORKSPACE_PROFILE: profile }, key)).toBeNull();
        }
        expect(get).not.toHaveBeenCalled();
      } finally { get.mockRestore(); }
    });
  });

  it('separates paid-page checkpoints with identical request bodies and refuses legacy checkpoint ownership', async () => {
    await secondWorkspace(async (other) => {
      const target = { ...INPUT.target, integration: 'dataforseo' as const, locationCode: 2840, languageCode: 'en', mappingSource: 'register' as const };
      const spec = { name: 'serp-panel' as const, path: '/v3/serp/google/organic/live/advanced' };
      const a = await dataForSeoCheckpointKey(env, target, spec, INPUT.reportDate, { keyword: 'example' });
      const b = await dataForSeoCheckpointKey(other, target, spec, INPUT.reportDate, { keyword: 'example' });
      expect(a).not.toBe(b);
      const scope = await signalObjectScope(env);
      expect(scope.owns(a)).toBe(true);
      expect(scope.owns(b)).toBe(false);
      expect(scope.owns(a.replace(`workspaces/${scope.workspaceId}/`, ''))).toBe(false);
      expect(scope.canReadArchive(a)).toBe(false);
      expect(await scope.legacyCheckpoint(a)).toBeNull();
    });
  });

  it('proves the sole standalone checkpoint owner, without reading transport for hosted/demo or foreign keys', async () => {
    const standalone = await signalObjectScope(env);
    const relative = 'checkpoints/dataforseo/meadow.example/2026-09-01/serp-panel/test.json';
    expect(await standalone.legacyCheckpoint(standalone.key(relative))).toBe(relative);
    for (const profile of ['hosted', 'demo']) {
      const POSTGRES = { get connectionString(): string { throw new Error('No standalone probe permitted'); } };
      const selected = await signalObjectScope({ ...env, POSTGRES, NOTICEOS_WORKSPACE_PROFILE: profile });
      expect(await selected.legacyCheckpoint(selected.key(relative))).toBeNull();
    }
    expect(await standalone.legacyCheckpoint(`workspaces/${crypto.randomUUID()}/${relative}`)).toBeNull();
    expect(await standalone.legacyCheckpoint('checkpoints/dataforseo/unscoped.json')).toBeNull();
  });

  it('does not adopt legacy checkpoints when the selected database has zero workspaces', async () => {
    await asOwner('TRUNCATE noticeos.workspaces CASCADE;', { other: true });
    const scope = await signalObjectScope({ ...env, POSTGRES: env.POSTGRES_OTHER });
    expect(await scope.legacyCheckpoint(scope.key('checkpoints/dataforseo/meadow.example/test.json'))).toBeNull();
  });

  it('refuses missing profiles and unavailable or malformed ownership before bucket access', async () => {
    const get = vi.spyOn(env.RAW_SIGNALS, 'get');
    const put = vi.spyOn(env.RAW_SIGNALS, 'put');
    try {
      for (const profile of ['', 'unknown']) {
        await expect(readPanelObject({ ...env, NOTICEOS_WORKSPACE_PROFILE: profile }, 'raw/test.json.gz')).rejects.toThrow();
      }
      for (const workspaceId of ['', '../foreign', 'not-a-uuid']) {
        const STORE = { ...env.STORE, workspaceId: async () => workspaceId };
        await expect(readPanelObject({ ...env, STORE }, 'raw/test.json.gz')).rejects.toThrow();
        await expect(archiveCollectedDump({ ...env, STORE }, INPUT)).rejects.toThrow();
      }
      expect(get).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    } finally { get.mockRestore(); put.mockRestore(); }
  });

  it('rejects malformed, traversing and alternate-namespace selectors before R2', async () => {
    const scope = await signalObjectScope(env);
    const get = vi.spyOn(env.RAW_SIGNALS, 'get');
    try {
      for (const key of ['raw//x', 'raw/../x', 'raw/%2e%2e/x', 'raw/%2fx', 'raw/%5cx', 'raw/%00x', 'raw/%', '/raw/x', 'backup/x', 'raw/' + 'x'.repeat(2048)]) {
        expect(() => scope.key(key)).toThrow();
        expect(await readPanelObject(env, key)).toBeNull();
      }
      expect(get).not.toHaveBeenCalled();
    } finally { get.mockRestore(); }
  });
});
